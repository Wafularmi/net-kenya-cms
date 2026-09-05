const http = require('http');
const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const QRCode = require('qrcode');
const WebSocket = require('ws');

process.on('uncaughtException', e => { try { process.stderr.write('UNCAUGHT: ' + (e && e.stack || e) + '\n'); } catch {} });
process.on('unhandledRejection', (reason) => { try { process.stderr.write('UNHANDLED: ' + (reason && reason.stack || reason) + '\n'); } catch {} });
process.stderr.write('SERVER_STARTING\n');

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT) || 3443;
const ROOT = __dirname;
const DATA_ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;
let _mpesaSettings = null;
let _httpsPort = null; // set after HTTPS starts

// ---- Externalized document store (PDF blobs moved out of server-data.json) ----
// Large base64 PDFs inflate the single JSON database (~33% overhead) and are
// parsed/rewritten on every request, which does not scale. We keep the heavy
// bytes on disk under DOC_STORE_DIR and reference them by path on the record.
//
// TWO-PHASE ROLLOUT (non-destructive by default):
//   Phase 1 (current): the PDF is written to disk AND the inline base64 copy is
//   KEPT in the JSON record as a backup/rollback source. Reads prefer the disk
//   file (via /api/doc-content) and fall back to the inline copy if it's absent.
//   Phase 2 (later, opt-in): set DOC_STRIP_INLINE=1 to remove the inline base64
//   on read once disk backups are confirmed -> the JSON DB shrinks for real.
const DOC_STORE_DIR = process.env.DOC_STORE_DIR || path.join(DATA_ROOT, 'docs');
const DOC_STRIP_INLINE = process.env.DOC_STRIP_INLINE === '1';
function docSafeKey(key) {
    return String(key || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || ('doc-' + Date.now());
}
function docPath(key) { return path.join(DOC_STORE_DIR, docSafeKey(key) + '.pdf'); }
function ensureDocStore() {
    try { if (!fs.existsSync(DOC_STORE_DIR)) fs.mkdirSync(DOC_STORE_DIR, { recursive: true }); } catch (e) { console.error('docstore mkdir failed:', e); }
}
// Copy the inline base64 PDF to disk (idempotent) and stamp the record with a
// contentPath. Non-destructive in phase 1: we keep the inline `content` as the
// backup copy. Returns { record, stored }. Safe for HTML docs (no-op).
function externalizeCertificate(cert) {
    if (!cert || typeof cert.content !== 'string') return { record: cert, stored: false };
    const c = String(cert.content).trim();
    const isPdf = /^JVBERi0/.test(c) || /^%PDF-/.test(c);
    if (!isPdf) return { record: cert, stored: false };
    const b64 = c.startsWith('data:') ? (c.split(',')[1] || '') : c;
    if (!b64) return { record: cert, stored: false };
    ensureDocStore();
    const key = cert.id || cert.docId || cert.vCode;
    const file = docPath(key);
    const rec = Object.assign({}, cert);
    rec.contentPath = '/api/doc-content/' + encodeURIComponent(key);
    if (fs.existsSync(file)) return { record: rec, stored: true };
    try {
        const buf = Buffer.from(b64, 'base64');
        fs.writeFileSync(file, buf);
        return { record: rec, stored: true };
    } catch (e) { console.error('externalizeCertificate failed:', key, e); return { record: cert, stored: false }; }
}
// Apply phase-2 stripping during a GET read: remove the inline base64 backup
// copy once the disk file is confirmed present and DOC_STRIP_INLINE is enabled.
function maybeStripInline(cert) {
    if (!DOC_STRIP_INLINE || !cert || typeof cert.content !== 'string') return cert;
    if (!cert.contentPath) return cert;
    const file = docPath(cert.id || cert.docId || cert.vCode);
    if (!fs.existsSync(file)) return cert; // never lose data if disk file missing
    const out = Object.assign({}, cert);
    delete out.content;
    return out;
}
// Lazily externalize the inline PDF of every certificate/idCard record on read,
// so legacy records get a disk copy + contentPath without a full migration job.
// Returns records safe to serialize back to the client. Triggers a saveDB only
// when at least one record was actually updated in the DB.
function externalizeStoreRecords(store, rows) {
    if (store !== 'certificates' && store !== 'idCards' && store !== 'idcards') return rows;
    let changed = false;
    const out = [];
    for (const r of rows) {
        if (!r || !r.content) { out.push(maybeStripInline(r)); continue; }
        const res = externalizeCertificate(r);
        const gainedPath = !!res.record.contentPath && res.record.contentPath !== r.contentPath;
        if (gainedPath) {
            const idx = db[store].findIndex(x => x === r);
            if (idx >= 0) { db[store][idx] = res.record; changed = true; }
        }
        out.push(maybeStripInline(res.record));
    }
    if (changed) { try { broadcastEvent('db-change', { store }); saveDB(); } catch (e) { console.error('externalizeStoreRecords save failed:', e); } }
    return out;
}
// Heavy settings blobs (PDF templates) live on disk, NOT in server-data.json.
// Transparent to clients: PUT strips template->disk, GET re-injects it.
const SETTINGS_BLOBS = { diplomaPdfConfig: 'template', completionPdfConfig: 'template' };
function settingsBlobPath(key) { return path.join(DOC_STORE_DIR, 'settings-' + docSafeKey(key) + '-template.pdf'); }
function externalizeSettingsRecord(rec) {
    if (!rec || !SETTINGS_BLOBS[rec.key]) return rec;
    const field = SETTINGS_BLOBS[rec.key];
    const holder = rec.value && typeof rec.value === 'object' ? rec.value : rec;
    const tpl = holder ? holder[field] : null;
    if (typeof tpl === 'string' && tpl.length > 1000) {
        try {
            ensureDocStore();
            fs.writeFileSync(settingsBlobPath(rec.key), Buffer.from(tpl, 'base64'));
            const verify = fs.statSync(settingsBlobPath(rec.key));
            if (verify.size > 0) {
                if (rec.value && typeof rec.value === 'object') rec.value[field] = null;
                else rec[field] = null;
            }
        } catch (e) { console.error('externalizeSettingsRecord failed:', rec.key, e); }
    } else if (!tpl) {
        try { if (fs.existsSync(settingsBlobPath(rec.key))) fs.unlinkSync(settingsBlobPath(rec.key)); } catch {}
    }
    return rec;
}
function injectSettingsBlobs(rec) {
    if (!rec || !SETTINGS_BLOBS[rec.key]) return rec;
    const field = SETTINGS_BLOBS[rec.key];
    const holder = rec.value && typeof rec.value === 'object' ? rec.value : rec;
    if (holder && !holder[field]) {
        try {
            const file = settingsBlobPath(rec.key);
            if (fs.existsSync(file)) {
                const out = Object.assign({}, rec);
                const hv = Object.assign({}, holder);
                hv[field] = fs.readFileSync(file).toString('base64');
                if (out.value && typeof out.value === 'object') out.value = hv;
                else Object.assign(out, hv);
                return out;
            }
        } catch (e) { console.error('injectSettingsBlobs failed:', rec.key, e); }
    }
    return rec;
}
function backfillSettingsBlobs() {
    try {
        if (!Array.isArray(db.settings)) return;
        let changed = false;
        db.settings.forEach((r, i) => {
            if (r && SETTINGS_BLOBS[r.key]) {
                const holder = r.value && typeof r.value === 'object' ? r.value : r;
                if (holder && typeof holder[SETTINGS_BLOBS[r.key]] === 'string' && holder[SETTINGS_BLOBS[r.key]].length > 1000) {
                    externalizeSettingsRecord(r);
                    changed = true;
                }
            }
        });
        if (changed) saveDB();
    } catch (e) { console.error('backfillSettingsBlobs failed:', e); }
}
const CERT_ID_PREFIX = { diploma: 'DIP', admission: 'ADL', completion: 'CMP', enrollment: 'ENL', recommendation: 'REC', 'fee-statement': 'FEE', transcript: 'TRX', 'final-transcript': 'FTR', certificate: 'CERT' };
function certDocId(cert) {
    const p = (CERT_ID_PREFIX[(cert || {}).type] || 'DOC').toUpperCase();
    return p + '-' + String(Date.now().toString(36)).toUpperCase() + Math.random().toString(36).substr(2, 6).toUpperCase();
}
// Guarantee every document record has a unique Document ID + Verification Code
// so all letters, transcripts, diplomas and certificates can be verified and
// reprinted against institutional records, including legacy rows that were
// saved before document IDs were standardised.
function backfillCertIdentifiers(store, rows) {
    if (store !== 'certificates') return rows;
    let changed = false;
    const out = [];
    for (const r of rows) {
        if (!r) { out.push(r); continue; }
        let rec = r;
        if (!rec.docId) { rec = Object.assign({}, rec, { docId: certDocId(rec) }); changed = true; }
        if (!rec.vCode) { rec = Object.assign({}, rec, { vCode: 'V-' + Math.random().toString(36).substr(2,4).toUpperCase() + '-' + Math.random().toString(36).substr(2,4).toUpperCase() }); changed = true; }
        if (changed && rec !== r) {
            const idx = db[store].findIndex(x => x === r);
            if (idx >= 0) { db[store][idx] = rec; }
        }
        out.push(rec);
    }
    if (changed) { try { broadcastEvent('db-change', { store }); saveDB(); } catch (e) { console.error('backfillCertIdentifiers save failed:', e); } }
    return out;
}

// SSE clients for real-time updates
const sseClients = [];
// Public maintenance-status subscribers (login screen has no session token)
const maintClients = [];
function broadcastMaintenance(active) {
    const msg = `event: maintenance\ndata: ${JSON.stringify({ active: !!active })}\n\n`;
    for (const list of [sseClients, maintClients]) {
        for (let i = list.length - 1; i >= 0; i--) {
            const client = list[i];
            if (!client.res.writableEnded) {
                try { client.res.write(msg); } catch {}
            } else {
                list.splice(i, 1);
            }
        }
    }
}

// WebSocket server for discussions
let wss = null;
const wsClients = new Map(); // courseId -> Set of { ws, userId, userName, userRole }

// ---- Crash-safe data layer with auto-backup ----
const DB_FILE = path.join(DATA_ROOT, 'server-data.json');
const DB_VOLUME_PATH = '/data/server-data.json'; // Railway volume path
const DB_TEMP = DB_FILE + '.tmp';
const DB_BACKUP = path.join(DATA_ROOT, 'server-data.backup.json');
const DB_BACKUP_DIR = path.join(DATA_ROOT, 'server-data-backups');
const MAX_BACKUPS = 20;

function ensureBackupDir() {
    try { if (!fs.existsSync(DB_BACKUP_DIR)) fs.mkdirSync(DB_BACKUP_DIR, { recursive: true }); } catch {}
}

function readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Always mirror the live DB back to the Railway volume so it never goes stale.
function syncToVolume() {
    try {
        if (fs.existsSync(DB_FILE)) {
            fs.copyFileSync(DB_FILE, DB_VOLUME_PATH);
        }
    } catch (e) { process.stderr.write('DB_VOLUME_SYNC_FAILED: ' + e.message + '\n'); }
}

// Atomic write: write to temp file, then rename (atomic on same filesystem)
function safeWriteJSON(data) {
    const json = JSON.stringify(data, null, 2);
    try {
        // Write to temp file first
        fs.writeFileSync(DB_TEMP, json, 'utf8');
        // Verify temp file is valid JSON
        JSON.parse(fs.readFileSync(DB_TEMP, 'utf8'));
        // Atomic rename with retry (AV may lock temp file temporarily)
        let renamed = false;
        for (let retries = 0; retries < 15; retries++) {
            try { fs.renameSync(DB_TEMP, DB_FILE); renamed = true; break; } catch (e) {
                if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
                if (retries < 14) { const start = Date.now(); while (Date.now() - start < 200) { /* spin */ } }
            }
        }
        if (!renamed) { console.error('safeWriteJSON: rename failed after 15 retries'); try { if (fs.existsSync(DB_TEMP)) fs.unlinkSync(DB_TEMP); } catch {} return false; }
        // Keep the Railway volume in sync so data is never lost on redeploy
        syncToVolume();
        // Create timestamped backup asynchronously (non-blocking)
        ensureBackupDir();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(DB_BACKUP_DIR, 'server-data.' + stamp + '.json');
        fs.writeFile(backupPath, json, 'utf8', err => {
            if (err) console.error('Backup write error:', err);
            // Prune old backups (keep MAX_BACKUPS)
            try {
                const files = fs.readdirSync(DB_BACKUP_DIR)
                    .filter(f => f.startsWith('server-data.') && f.endsWith('.json'))
                    .sort()
                    .reverse();
                if (files.length > MAX_BACKUPS) {
                    files.slice(MAX_BACKUPS).forEach(f => {
                        try { fs.unlinkSync(path.join(DB_BACKUP_DIR, f)); } catch {}
                    });
                }
            } catch {}
        });
        return true;
    } catch (e) {
        console.error('safeWriteJSON error:', e);
        // Clean up temp file on failure
        try { if (fs.existsSync(DB_TEMP)) fs.unlinkSync(DB_TEMP); } catch {}
        return false;
    }
}

// Load DB with multi-level fallback
function loadDB() {
    const sources = [
        { file: DB_VOLUME_PATH, label: 'volume' },
        { file: DB_FILE, label: 'main' },
        { file: DB_BACKUP, label: 'backup' },
    ];
    // Add timestamped backups (most recent first)
    try {
        ensureBackupDir();
        const backups = fs.readdirSync(DB_BACKUP_DIR)
            .filter(f => f.startsWith('server-data.') && f.endsWith('.json'))
            .sort()
            .reverse()
            .slice(0, 5);
        backups.forEach(f => sources.push({ file: path.join(DB_BACKUP_DIR, f), label: f }));
    } catch {}
    // In pkg mode, fall back to snapshot-bundled server-data.json
    if (process.pkg && ROOT !== DATA_ROOT) {
        sources.push({ file: path.join(ROOT, 'server-data.json'), label: 'snapshot' });
    }
    // Final fallback: shipped seed template (never real data) so a fresh deploy
    // without a volume starts empty instead of overwriting with a stale snapshot.
    try {
        const seedPath = path.join(DATA_ROOT, 'server-data.seed.json');
        if (fs.existsSync(seedPath)) sources.push({ file: seedPath, label: 'seed' });
    } catch {}
    // Try each source
    for (const { file, label } of sources) {
        const data = readJSON(file);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            if (label !== 'main') {
                console.log('DB loaded from fallback: ' + label);
                // Immediately write the recovered data as the new main file
                safeWriteJSON(data);
            }
            return data;
        }
    }
    console.error('All data sources corrupted! Starting with empty DB.');
    return { mpesaSettings: {}, mpesaTransactions: [] };
}

// Copy database from volume before first load
try { if (fs.existsSync(DB_VOLUME_PATH)) { fs.copyFileSync(DB_VOLUME_PATH, DB_FILE); process.stderr.write('DB_COPIED_FROM_VOLUME\n'); } } catch (e) { process.stderr.write('DB_VOLUME_COPY_FAILED: ' + e.message + '\n'); }
// On startup, create a safety backup of whatever file exists
try {
    ensureBackupDir();
    if (fs.existsSync(DB_FILE)) {
        const content = fs.readFileSync(DB_FILE, 'utf8');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(path.join(DB_BACKUP_DIR, 'boot-' + stamp + '.json'), content, 'utf8');
    }
} catch {}

// ---- End crash-safe data layer ----
function broadcastEvent(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (let i = sseClients.length - 1; i >= 0; i--) {
        const client = sseClients[i];
        if (!client.res.writableEnded) {
            client.res.write(msg);
        } else {
            sseClients.splice(i, 1);
        }
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip'
};

const COMPRESSIBLE = ['.html', '.css', '.js', '.json', '.svg', '.txt', '.xml'];

function compress(res, data, contentType) {
    const accept = res.getHeader('Accept-Encoding') || '';
    if (accept.includes('gzip') && data.length > 512) {
        zlib.gzip(data, { level: 6 }, (err, result) => {
            if (!err) {
                res.setHeader('Content-Encoding', 'gzip');
                res.setHeader('Content-Length', result.length);
                res.end(result);
            } else {
                res.setHeader('Content-Length', data.length);
                res.end(data);
            }
        });
    } else {
        res.setHeader('Content-Length', data.length);
        res.end(data);
    }
}

// Cache for frequently accessed files
const fileCache = new Map();
const MAX_CACHE_SIZE = 10 * 1024 * 1024; // 10MB
let cacheSize = 0;

function serveCachedFile(res, filePath, url, req) {
    const isBundle = url.includes('bundle.js');
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const skipGzip = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.svg'].includes(ext);
    const acceptEncoding = (req && req.headers) ? req.headers['accept-encoding'] || '' : '';
    const wantsGzip = acceptEncoding.includes('gzip');
    
    // Serve pre-compressed .gz if available and fresh (avoids runtime gzip cost)
    const gzPath = filePath + '.gz';
    let gzFresh = false;
    if (wantsGzip && !skipGzip && fs.existsSync(gzPath)) {
        try {
            const srcMtime = fs.statSync(filePath).mtimeMs;
            const gzMtime = fs.statSync(gzPath).mtimeMs;
            gzFresh = gzMtime >= srcMtime;
        } catch { gzFresh = false; }
    }
    if (gzFresh) {
        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Encoding', 'gzip');
        if (isBundle || ext === '.css' || ext === '.js') {
            res.setHeader('CDN-Cache-Control', 'no-store');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
        }
        const stat = fs.statSync(gzPath);
        res.setHeader('Content-Length', stat.size);
        return fs.createReadStream(gzPath).pipe(res);
    }
    
    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (res.headersSent) return;
            res.writeHead(404, { 'Content-Type': 'text/html' });
            return res.end('<h2>404</h2>');
        }
        
        if (res.headersSent) return;
        res.setHeader('Content-Type', mime);
        
        if (isBundle || ext === '.css' || ext === '.js') {
            res.setHeader('CDN-Cache-Control', 'no-store');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (skipGzip) {
            res.setHeader('Cache-Control', 'public, max-age=604800');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
        }
        
        if (!skipGzip && wantsGzip && data.length > 512) {
            zlib.gzip(data, { level: 6 }, (err, result) => {
                if (err || res.headersSent) {
                    res.setHeader('Content-Length', data.length);
                    res.end(data);
                } else {
                    res.setHeader('Content-Encoding', 'gzip');
                    res.setHeader('Content-Length', result.length);
                    res.end(result);
                }
            });
        } else {
            res.setHeader('Content-Length', data.length);
            res.end(data);
        }
    });
}

function cacheFile(cacheKey, data) {
    if (data.length > 1024 * 1024) return;
    if (cacheSize + data.length > MAX_CACHE_SIZE) {
        fileCache.clear();
        cacheSize = 0;
    }
    fileCache.set(cacheKey, data);
    cacheSize += data.length;
}


// Online user tracking â€” heartbeat every 30s, expires after 90s
const onlineUsers = new Map();
function cleanOnlineUsers() {
    const cutoff = Date.now() - 90000;
    for (const [user, ts] of onlineUsers) if (ts < cutoff) onlineUsers.delete(user);
}
setInterval(cleanOnlineUsers, 30000);

let db = loadDB();

let _saveTimer = null;
function saveDB() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        safeWriteJSON(db);
        _saveTimer = null;
    }, 500);
}
function flushDB() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    safeWriteJSON(db);
}
process.on('exit', flushDB);
process.on('SIGINT', () => { flushDB(); process.exit(); });

function json(res, code, data) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Cache-Control': 'no-store, max-age=0'
    });
    res.end(JSON.stringify(data));
    return true;
}

// ---- Jitsi JWT moderator tokens (Virtual Classroom) ----
// Uses 8x8 JaaS: tokens are RS256-signed with the tenant private key.
// Token format per https://developer.8x8.com/jaas/docs/api-keys-jwt and the
// official sample https://github.com/8x8/jaas_demo (header kid + alg RS256).
// Requires JWT_APP_ID, JWT_API_KEY_ID, JWT_PRIVATE_KEY and JITSI_BASE_URL.
const JWT_APP_ID = process.env.JWT_APP_ID || 'netkenya';
const JWT_API_KEY_ID = process.env.JWT_API_KEY_ID || '';
const JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY || '';
const JITSI_BASE_URL = (process.env.JITSI_BASE_URL || '').replace(/\/+$/, '');
const PRIVILEGED_ROLES = ['admin', 'lecturer', 'trainer', 'staff', 'coordinator', 'registrar', 'teacher'];
function isPrivilegedRole(role) {
    return PRIVILEGED_ROLES.indexOf(role || '') !== -1;
}
function jitsiJwtEnabled() {
    return !!(JWT_APP_ID && JWT_API_KEY_ID && JWT_PRIVATE_KEY && JITSI_BASE_URL);
}
function b64url(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
// The private key is stored as a PEM string; allow base64-encoded PEM too
// (Railway env vars dislike literal newlines).
function decodePrivateKey(key) {
    const trimmed = String(key || '').trim();
    if (/^-----BEGIN/.test(trimmed)) return trimmed;
    try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
        return /^-----BEGIN/.test(decoded.trim()) ? decoded : trimmed;
    } catch { return trimmed; }
}
function buildJitsiJwt(user, privileged) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        aud: 'jitsi',
        context: {
            user: {
                id: user.username || '',
                name: user.name || user.username || '',
                email: user.email || undefined,
                moderator: privileged ? 'true' : 'false'
            },
            features: {
                livestreaming: 'true',
                recording: 'true',
                transcription: 'true',
                'outbound-call': 'true'
            }
        },
        iss: 'chat',
        room: '*',
        sub: JWT_APP_ID,
        exp: now + 6 * 3600,
        nbf: now - 30
    };
    const data = b64url({ alg: 'RS256', typ: 'JWT', kid: JWT_API_KEY_ID }) + '.' + b64url(payload);
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(data);
    return data + '.' + sign.sign(decodePrivateKey(JWT_PRIVATE_KEY), 'base64url');
}

// Financial stores that require special authorization
const FINANCIAL_STORES = new Set(['payments', 'income', 'expenses', 'fees', 'invoices']);

// Roles allowed to access ALL financial data
const FINANCE_ADMIN_ROLES = new Set(['admin', 'finance', 'registrar']);

// Stores with sensitive records that students must never read.
// (students/users are handled separately via per-row filtering below)
// Note: 'alumni' is NOT denied - graduated students need to read their own alumni record
const STUDENT_DENY_STORES = new Set([
    'staff', 'payroll', 'audit', 'counters',
    'certificates', 'idCards', 'idcards', 'backups', 'smsLog', 'smsSettings',
    'mpesaSettings', 'mpesaTransactions', 'income', 'expenses', 'fees',
    'invoices', 'installments', 'whatsappTemplates', 'whatsappLog',
    'expenseCategories', 'gradRequirements', 'sessions'
]);

// Stores a student is allowed to write to (their own activity records)
const STUDENT_WRITE_STORES = new Set([
    'submissions', 'quizRegistrations', 'examRegistrations',
    'retakeRequests', 'seating', 'borrows', 'tickets', 'enrollments'
]);

// Extract the authenticated user from the request (server-verified).
// Legacy X-User-Id / X-User-Role headers are NO LONGER trusted — a caller must
// present a valid session token (Authorization: Bearer <token> or the `session`
// cookie) that was issued at login. Admins carrying a valid maintenance-bypass
// cookie are also accepted (that cookie is itself server-verified).
function getRequestUser(req) {
    const sessionUser = getSessionUser(req);
    if (sessionUser) return { role: sessionUser.role, username: sessionUser.username, user: sessionUser };
    if (hasMaintenanceBypass(req)) {
        const token = parseCookies(req).mt_bypass;
        const entry = token && maintenanceBypassTokens.get(token);
        const user = entry && (db.users || []).find(u => u.username === entry.username);
        if (user) return { role: user.role, username: user.username, user };
    }
    return null;
}

// Check if user can access a store
function canAccessStore(user, store, method) {
    // Sensitive internal stores - admin only, never via API
    if (store === 'sessions' || store === 'maintenanceBypassTokens') {
        return user && user.role === 'admin';
    }
    // Allow unauthenticated reads for login screen / registration
    if (!user && method === 'GET' && (store === 'settings' || store === 'studyCenters' || store === 'regions')) return true;
    if (!user) return false;
    // Students store: only admin and assistant (if enabled) may create/update/delete
    if (store === 'students' && method !== 'GET') {
        if (user.role === 'admin') return true;
        if (user.role === 'assistant') {
            const rec = (db.settings || []).find(s => s.key === 'assistantAccess');
            const access = rec ? (rec.value || rec) : null;
            if (!access || access['students'] !== false) return true;
            return false;
        }
        return false;
    }
    // Fee agreements + waivers: reads for staff, writes admin/finance/registrar/assistant(with Finance tab)
    if (store === 'feeAgreements' || store === 'waivers') {
        if (method === 'GET') return true;
        if (user.role === 'admin' || user.role === 'finance' || user.role === 'registrar') return true;
        if (user.role === 'assistant') {
            const rec = (db.settings || []).find(s => s.key === 'assistantAccess');
            const access = rec ? (rec.value || rec) : null;
            if (!access || access['finance'] !== false) return true;
            return false;
        }
        return false;
    }
    if (FINANCE_ADMIN_ROLES.has(user.role)) return true;

    if (user.role === 'student') {
        if (STUDENT_DENY_STORES.has(store)) return false;
        if (method !== 'GET' && !STUDENT_WRITE_STORES.has(store)) return false;
        if (method === 'GET' && store === 'payments') return true; // filtering happens in the handler
        return true;
    }

    // Coordinator: sub-admin scoped to their region
    if (user.role === 'coordinator') {
        if (['settings','regions','users','counters'].includes(store)) return false;
        if (['courses','exams','quizzes','questionBank','lessons'].includes(store) && method !== 'GET') return false;
        if (!FINANCIAL_STORES.has(store)) return true;
        return true;
    }

    // Assistant admin: granular per-tab toggles stored in settings:assistantAccess
    if (user.role === 'assistant') {
        // Only admin can change the assistantAccess config itself
        if (store === 'settings' && method !== 'GET') {
            // Defer to later check for assistantAccess key; but block changing it
            // We need the parsed body to check key, but here we only have store/method.
            // Allow PUT to settings only if the tab 'settings' is enabled; the
            // specific 'assistantAccess' key check is done in the PUT handler.
            const rec = (db.settings || []).find(s => s.key === 'assistantAccess');
            const access = rec ? (rec.value || rec) : null;
            if (store === 'settings' && access && access['settings'] === false) return false;
        }
        const rec = (db.settings || []).find(s => s.key === 'assistantAccess');
        const access = rec ? (rec.value || rec) : null;
        // If no config yet, default to allow all (so new assistant isn't locked out)
        if (!access) {
            if (!FINANCIAL_STORES.has(store)) return true;
            return false;
        }
        const storeToTab = {
            students: 'students', courses: 'courses', lessons: 'lessons', attendance: 'attendance',
            grades: 'grades', exams: 'exams', manuals: 'manuals', staff: 'staff',
            payments: 'finance', income: 'finance', expenses: 'finance', fees: 'finance', invoices: 'finance',
            hostel: 'hostel', hostels: 'hostel', borrows: 'hostel',
            library: 'library', inventory: 'inventory', alumni: 'alumni',
            certificates: 'certificates', events: 'events', whatsapp: 'whatsapp', whatsappTemplates: 'whatsapp', whatsappLog: 'whatsapp',
            audit: 'audit', idcards: 'idcards', idCards: 'idcards', questions: 'questions', quizzes: 'quizzes',
            submissions: 'submissions', notes: 'notes', portal: 'portal', pending: 'pending',
            tickets: 'tickets', progress: 'progress', settings: 'settings', verify: 'verify', reprint: 'reprint',
            discussions: 'discussions', regions: 'regions', communication: 'communication', messages: 'messages',
            sms: 'sms', smsLog: 'sms', smsSettings: 'sms', chapel: 'chapel', graduation: 'graduation',
            users: 'users', counters: 'counters', studyCenters: 'regions', studyCenter: 'regions'
        };
        const tab = storeToTab[store];
        if (tab) {
            if (access[tab] === false) return false;
            // Also deny financial stores if finance tab disabled
            if (FINANCIAL_STORES.has(store) && access['finance'] === false) return false;
            return true;
        }
        if (!FINANCIAL_STORES.has(store)) return true;
        return false;
    }

    if (!FINANCIAL_STORES.has(store)) return true;

    return false;
}

// Meeting visibility: staff see rooms whose roles include them (or open rooms);
// students only see Virtual Hall meetings scoped to them.
function meetingVisibleTo(user, mtg) {
    if (!user || !mtg) return false;
    if (user.role === 'admin') return true;
    const aud = mtg.audience || {};
    const roles = Array.isArray(aud.roles) ? aud.roles : [];
    if (user.role === 'student') {
        if (mtg.kind !== 'hall') return false;
        if (roles.length && !roles.includes('student')) return false;
        const su = user.user || {};
        const sid = String(su.studentId || '');
        const stu = sid ? ((db.students || []).find(s => String(s.id) === String(sid)) || null) : null;
        const myCenter = stu ? (stu.studyCenterId || '') : '';
        let myRegion = '';
        if (myCenter) {
            const c = (db.studyCenters || []).find(x => String(x.id) === String(myCenter));
            myRegion = c ? (c.regionId || '') : '';
        }
        const rids = Array.isArray(aud.regionIds) ? aud.regionIds.map(String) : [];
        const cids = Array.isArray(aud.centerIds) ? aud.centerIds.map(String) : [];
        if (rids.length && !rids.includes(String(myRegion))) return false;
        if (cids.length && !cids.includes(String(myCenter))) return false;
        return true;
    }
    if (roles.length && !roles.includes(user.role)) return false;
    if (user.role === 'coordinator') {
        const myRegion = user.user.regionId || '';
        const rids = Array.isArray(aud.regionIds) ? aud.regionIds.map(String) : [];
        if (rids.length && myRegion && !rids.includes(String(myRegion))) return false;
    }
    return true;
}
// Restrict which rows of a store a user may see. Students only ever see their
// own student record and their own login record (users store).
function filterStoreForUser(user, store, rows) {
    if (!user || user.role !== 'student') return rows;
    const su = user.user || {};
    const uid = String(user.username || '').trim();
    const sid = String(su.studentId || '').trim();
    const uidDigits = uid.replace(/[^0-9]/g, '').slice(-9);
    const nameLower = String(su.name || user.username || '').trim().toLowerCase();
    if (store === 'students') {
        return rows.filter(r => {
            if (!r) return false;
            if (String(r.id) === sid || String(r.id) === uid || String(r.id) === 'STU-' + uid || String(r.id) === 'STU-' + sid) return true;
            if (r.admissionNumber && (String(r.admissionNumber) === uid || String(r.admissionNumber) === sid)) return true;
            if (r.phone && uidDigits && String(r.phone).replace(/[^0-9]/g,'').slice(-9) === uidDigits) return true;
            if (r.phone && String(r.phone) === uid) return true;
            if (r.email && String(r.email).toLowerCase() === uid.toLowerCase()) return true;
            if (r.email && sid && String(r.email).toLowerCase() === String(sid).toLowerCase()) return true;
            if (nameLower && r.name && String(r.name).trim().toLowerCase() === nameLower) return true;
            return false;
        });
    }
    if (store === 'users') {
        return rows.filter(r => r && String(r.username) === uid);
    }
    if (store === 'courseCompletions') {
        return rows.filter(r => r && (String(r.studentId) === sid || String(r.studentId) === uid));
    }
    if (store === 'feeAgreements') {
        return rows.filter(r => r && (String(r.studentId) === sid || String(r.studentId) === uid));
    }
    if (store === 'waivers') {
        return rows.filter(r => r && (String(r.studentId) === sid || String(r.studentId) === uid));
    }
    if (store === 'meetings') {
        return rows.filter(r => r && meetingVisibleTo(user, r));
    }
    if (store === 'alumni') {
        return rows.filter(r => {
            if (!r) return false;
            if (r.studentId && (String(r.studentId) === sid || String(r.studentId) === uid)) return true;
            if (r.id && (String(r.id) === sid || String(r.id) === uid)) return true;
            if (r.phone && uidDigits && String(r.phone).replace(/[^0-9]/g,'').slice(-9) === uidDigits) return true;
            if (r.phone && String(r.phone) === uid) return true;
            if (r.email && String(r.email).toLowerCase() === uid.toLowerCase()) return true;
            if (nameLower && r.name && String(r.name).trim().toLowerCase() === nameLower) return true;
            return false;
        });
    }
    return rows;
}

// Server-verified session tokens (issued at login, 12h lifetime).
const sessions = new Map(); // token -> { username, expires, createdAt }
const SESSION_TTL = 12 * 3600 * 1000;
const SESSION_FILE = path.join(DATA_ROOT, 'sessions.json');
function loadSessions() {
    try {
        if (!fs.existsSync(SESSION_FILE)) return;
        const arr = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        if (!Array.isArray(arr)) return;
        const now = Date.now();
        for (const e of arr) {
            if (e && e.token && e.username && e.expires && e.expires > now) {
                sessions.set(e.token, { username: e.username, expires: e.expires, createdAt: e.createdAt || now });
            }
        }
    } catch (e) { console.error('loadSessions failed:', e.message); }
}
function saveSessions() {
    try {
        const arr = [];
        for (const [token, s] of sessions) arr.push({ token, username: s.username, expires: s.expires, createdAt: s.createdAt });
        fs.writeFileSync(SESSION_FILE, JSON.stringify(arr, null, 2), 'utf8');
        try { if (fs.existsSync(SESSION_FILE) && DATA_ROOT !== '/data') fs.copyFileSync(SESSION_FILE, '/data/sessions.json'); } catch {}
        try { if (fs.existsSync('/data/sessions.json') && !fs.existsSync(SESSION_FILE)) fs.copyFileSync('/data/sessions.json', SESSION_FILE); } catch {}
    } catch (e) { console.error('saveSessions failed:', e.message); }
}
setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [token, s] of sessions) if (s.expires < now) { sessions.delete(token); changed = true; }
    if (changed) saveSessions();
}, 10 * 60 * 1000);

function issueSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username, expires: Date.now() + SESSION_TTL, createdAt: Date.now() });
    saveSessions();
    return token;
}

function sessionUserForToken(token) {
    if (!token) return null;
    const s = sessions.get(token);
    if (!s || s.expires < Date.now()) {
        sessions.delete(token);
        return null;
    }
    const user = (db.users || []).find(u => u.username === s.username);
    if (!user || (user.status && user.status !== 'active')) return null;
    return user;
}

function getSessionUser(req) {
    const auth = req.headers['authorization'] || '';
    let token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) token = parseCookies(req).session || '';
    return sessionUserForToken(token);
}

// Restore persisted sessions AFTER all session helpers are defined
// (calling earlier throws a TDZ error on SESSION_FILE and silently skips).
try {
    if (fs.existsSync('/data/sessions.json') && !fs.existsSync(SESSION_FILE)) {
        fs.copyFileSync('/data/sessions.json', SESSION_FILE);
    }
    loadSessions();
} catch (e) { console.error('loadSessions at startup failed:', e.message); }
try { backfillSettingsBlobs(); } catch (e) { console.error('backfillSettingsBlobs failed:', e.message); }

// Brute-force protection for /api/login
const loginAttempts = new Map(); // ip -> { count, windowStart, blockedUntil }
const LOGIN_MAX_ATTEMPTS = parseInt(process.env.LOGIN_MAX_ATTEMPTS) || 10;
const LOGIN_WINDOW_MS = (parseInt(process.env.LOGIN_WINDOW_MS) || 15) * 60 * 1000;
const LOGIN_BLOCK_MS = (parseInt(process.env.LOGIN_BLOCK_MS) || 15) * 60 * 1000;

function clientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
}

function loginRateBlocked(req) {
    const ip = clientIp(req);
    const rec = loginAttempts.get(ip);
    if (!rec) return false;
    if (rec.blockedUntil && rec.blockedUntil > Date.now()) return true;
    if (Date.now() - rec.windowStart > LOGIN_WINDOW_MS) {
        loginAttempts.delete(ip);
        return false;
    }
    return false;
}

function loginRateFail(req) {
    const ip = clientIp(req);
    const now = Date.now();
    let rec = loginAttempts.get(ip);
    if (!rec || now - rec.windowStart > LOGIN_WINDOW_MS) rec = { count: 0, windowStart: now, blockedUntil: 0 };
    rec.count++;
    if (rec.count >= LOGIN_MAX_ATTEMPTS) rec.blockedUntil = now + LOGIN_BLOCK_MS;
    loginAttempts.set(ip, rec);
}

function loginRateSuccess(req) {
    loginAttempts.delete(clientIp(req));
}

// Rate limiting for public /api/verify (separate from login)
const verifyAttempts = new Map();
const VERIFY_MAX_ATTEMPTS = parseInt(process.env.VERIFY_MAX_ATTEMPTS) || 20;
function verifyRateBlocked(req) {
    const ip = clientIp(req);
    const rec = verifyAttempts.get(ip);
    if (!rec) return false;
    if (rec.blockedUntil && rec.blockedUntil > Date.now()) return true;
    if (Date.now() - rec.windowStart > LOGIN_WINDOW_MS) {
        verifyAttempts.delete(ip);
        return false;
    }
    return false;
}
function verifyRateFail(req) {
    const ip = clientIp(req);
    const now = Date.now();
    let rec = verifyAttempts.get(ip);
    if (!rec || now - rec.windowStart > LOGIN_WINDOW_MS) rec = { count: 0, windowStart: now, blockedUntil: 0 };
    rec.count++;
    if (rec.count >= VERIFY_MAX_ATTEMPTS) rec.blockedUntil = now + LOGIN_BLOCK_MS;
    verifyAttempts.set(ip, rec);
}
function verifyRateSuccess(req) {
    verifyAttempts.delete(clientIp(req));
}

// Server-side audit trail for security-relevant events
function auditLog(action, entity, details, user) {
    try {
        if (!Array.isArray(db.audit)) db.audit = [];
        db.audit.push({
            id: 'SVR-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
            source: 'server',
            userId: user || 'system',
            action,
            entity,
            details: details ? JSON.stringify(details).slice(0, 2000) : '',
            date: new Date().toISOString(),
            timestamp: Date.now()
        });
        if (db.audit.length > 20000) db.audit = db.audit.slice(-15000);
        saveDB();
} catch (e) {}
}

// Pass 1: Extract text positions directly from the PDF content stream via pdf.js.
// This is free, instant, and works for any PDF where labels live in the text layer
// (not just raster images).
async function extractFieldsFromPdfJs(pdfBase64) {
    try {
        let pdfjsLib;
        try { pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js'); }
        catch (e) { pdfjsLib = require('pdfjs-dist'); }
        const pdfData = new Uint8Array(Buffer.from(pdfBase64, 'base64'));
        const pdf = await pdfjsLib.getDocument({ data: pdfData, useSystemFonts: true, isEvalSupported: false }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.0 });
        const textContent = await page.getTextContent();
        const pageWidth = viewport.width;   // points
        const pageHeight = viewport.height;
        const ptToMm = 25.4 / 72;

        const fieldPatterns = {
            name: [/\bname\b/i, /\bstudent\s*name\b/i, /\bfull\s*name\b/i, /\bcandidate\s*name\b/i],
            adm:  [/\badm(?:ission)?\s*(?:no|#|number)?\b/i, /\breg(?:istration)?\s*(?:no|#|number)?\b/i, /\badm(?:ission)?\s*(?:no|#)?\s*:?\s*\S+/i],
            date: [/\bdate\b/i, /\bgraduation\s*date\b/i, /\bissue\s*date\b/i, /\bawarded?\s*(?:on|in|dated?)\b/i],
            docid:[/\bdoc(?:ument)?\s*id\b/i, /\bcert(?:ificate)?\s*(?:no|#|number)\b/i, /\bref(?:erence)?\s*(?:no|#|number)\b/i],
            vcode:[/\bverif(?:y|ication)\s*(?:code|no|#|number)?\b/i, /\bv[\-\s]?code\b/i, /\bverify\b/i],
        };
        const datePatterns = [
            /\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b/,
            /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/i,
            /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/i,
        ];

        const fields = {};
        for (const item of textContent.items) {
            if (!item.str || !item.str.trim()) continue;
            const text = item.str.trim();
            const tx = item.transform[4];
            const ty = item.transform[5];
            const xMm = tx * ptToMm;
            const yMm = (pageHeight - ty) * ptToMm;

            for (const [field, pats] of Object.entries(fieldPatterns)) {
                if (fields[field]) continue;
                for (const pat of pats) {
                    const m = text.match(pat);
                    if (m) {
                        fields[field] = { x: Math.round(xMm + (m[0].length * 2.5)), y: Math.round(yMm), size: 12 };
                        break;
                    }
                }
            }
            if (!fields.date) {
                for (const dp of datePatterns) {
                    if (dp.test(text)) { fields.date = { x: Math.round(xMm), y: Math.round(yMm), size: 12 }; break; }
                }
            }
        }
        return fields;
    } catch (e) {
        console.warn('pdf.js text extraction failed:', e.message);
        return {};
    }
}

// Helper: Extract field positions from OCR — token/label-aware with confidence scoring.
// Avoids false positives from words that merely contain a label substring (e.g. the
// word "name" inside a long header sentence) by requiring label-like structure:
// a colon, a "No."/number keyword, or a short standalone label at line start.
function extractFieldPositions(analyzeResult) {
    const fields = {};
    const ptToMm = 25.4 / 72;

    // Each field has an exact label set and a regex set. We score matches and keep
    // the highest-confidence one per field to avoid false positives.
    const fieldRules = {
        name: {
            regex: [/^name[\s:]/i, /\bstudent[\s]name/i, /\bfull[\s]name/i, /\bcandidate[\s]name/i],
            exactTokens: ['name', 'fullname', 'studentname', 'candidatename']
        },
        adm: {
            regex: [/\badm(?:ission)?(?:[\s:.-]*)(?:no|#|number|\.)?\s*[:.]?\s*$/i, /\badm(?:ission)?(?:[\s]no|[\s]#|[\s]number|\.)\b/i, /\breg(?:istration)?(?:[\s:.-]*)(?:no|#|number|\.)?\s*[:.]?\s*$/i, /\bregistration\b/i],
            exactTokens: ['admission', 'admissionno', 'admno', 'adm', 'regno', 'registration', 'regno']
        },
        date: {
            regex: [/^\s*(dated?|date|issue\s*date|award\s*date|graduation\s*date|date\s*of|awarded)\s*[:.]?\s*$/i, /date\s*of\s*(?:award|issue|graduation|birth)?\s*[:.]?\s*$/i],
            exactTokens: ['date', 'dated', 'awarddate', 'issuedate', 'graduationdate', 'awarded']
        },
        docid: {
            regex: [/\b(cert|document|certificate|ref|reg|diploma)\s*(?:\.?\s*no|\.?\s*#|\.?\s*number)?\s*[:.]?\s*$/i, /\bcert(?:ificate)?\s*(?:no|#|number)\b/i, /\bdoc(?:ument)?(?:\s*id)?\s*[:.]?\s*$/i, /\bcertificate\s*(?:no|#|number)\b/i],
            exactTokens: ['docid', 'documentid', 'certno', 'certificateno', 'certificatenumber', 'certificate', 'refno']
        },
        vcode: {
            regex: [/\bverif(?:y|ication)?\s*(?:code|no|#|number)?\s*[:.]?\s*$/i, /\bv[\-\s]?code\b/i, /\bverify\s*(?:code)?\b/i],
            exactTokens: ['verify', 'verification', 'vcode', 'verificationcode', 'verifycode']
        }
    };

    const dateValuePatterns = [
        /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/i,
        /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd)?,?\s+\d{4}\b/i,
        /\b\d{4}[\-\/]\d{1,2}[\-\/]\d{1,2}\b/,
        // numeric date like 12/03/2024 or 12-03-2024, but NOT inside an alphanumeric ID
        /(?<![A-Za-z0-9])[0-3]?\d[\/\-\.][0-1]?\d[\/\-\.](?:19|20)\d{2}(?![A-Za-z0-9])/,
    ];

    const cleanTokens = s => (s || '').replace(/[^\w\-]/g, ' ').trim().toLowerCase().split(/\s+/).filter(Boolean);

    const bboxOf = pts => {
        if (!Array.isArray(pts) || !pts.length) return null;
        let xs = [], ys = [];
        for (const p of pts) {
            if (typeof p === 'number') {
                if (Number.isFinite(p)) (xs.length <= ys.length ? xs : ys).push(p);
            } else if (Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
                xs.push(p[0]); ys.push(p[1]);
            } else if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
                xs.push(p.x); ys.push(p.y);
            }
        }
        if (!xs.length || xs.length !== ys.length) return null;
        return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    };

    const mergeBox = (box, wb) => {
        if (!box) return wb;
        if (!wb) return box;
        return { minX: Math.min(box.minX, wb.minX), maxX: Math.max(box.maxX, wb.maxX), minY: Math.min(box.minY, wb.minY), maxY: Math.max(box.maxY, wb.maxY) };
    };

    // Score how label-like a line is for a given field (higher = better).
    // A line is only treated as a real field label if it carries a strong label
    // signal: a trailing colon, a "No./#/Number/ID/Code" keyword. This prevents
    // decorative prose (headers, body text) from false-matching.
    const scoreLine = (content, rule) => {
        const c = content.trim();
        if (!c) return 0;
        let score = 0;
        for (const rx of rule.regex) {
            if (rx.test(c)) { score += 3; break; }
        }
        const toks = cleanTokens(c);
        for (const t of toks) {
            if (rule.exactTokens.includes(t)) { score += 2; break; }
        }
        // Strong label signals: must have a colon OR a No./#/number/id/code keyword
        const hasColon = /[:：]/.test(c);
        const hasNumberKw = /\b(?:no|#|num|number|id|code|cert(?:(?:ificate)?\.?\s*no)?|adm)\b|[:：]/i.test(c);
        if (!hasColon && !hasNumberKw) return 0;
        // Penalise long prose lines that merely contain a keyword (headers, body text)
        if (toks.length > 3) score -= 1;
        // Penalise if it ends with a common non-label word
        const last = toks[toks.length - 1] || '';
        if (['of', 'the', 'and', 'for', 'this', 'is', 'in', 'on', 'with', 'a'].includes(last)) score -= 2;
        return score;
    };

    const processLines = (lines, words, pageW, pageUnits) => {
        const norm = (pageW == null) ? null : Number(pageW);
        const pageWraw = (norm != null && Number.isFinite(norm)) ? norm : null;
        const unitScale = pageUnits === 'pixel' ? (72 / 300) : (pageUnits === 'inch' ? 72 : 1);
        const wordsByLine = new Map();
        for (let i = 0; i < lines.length; i++) {
            const span = lines[i].spans && lines[i].spans[0];
            if (!span) continue;
            const set = [];
            for (const w of words) {
                const ws = w.span || (w.spans && w.spans[0]) || null;
                if (ws && ws.offset >= span.offset && (ws.offset + ws.length) <= (span.offset + span.length)) set.push(w);
            }
            wordsByLine.set(i, set);
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const content = (line.content || line.text || '').trim();
            if (!content) continue;

            for (const [field, rule] of Object.entries(fieldRules)) {
                if (fields[field]) continue;
                const sc = scoreLine(content, rule);
                if (sc <= 0) continue;

                let box = null;
                const mem = wordsByLine.get(i);
                if (mem && mem.length) {
                    for (const w of mem) box = mergeBox(box, bboxOf(w.polygon) || bboxOf(w.boundingBox));
                }
                if (!box) box = bboxOf(line.polygon) || bboxOf(line.boundingBox);
                if (!box) continue;

                const rawX = pageWraw != null ? Math.min(box.maxX + 10, pageWraw) : box.maxX + 10;
                fields[field] = {
                    x: Math.round(rawX * unitScale * ptToMm),
                    y: Math.round(box.minY * unitScale * ptToMm),
                    size: field === 'name' ? 16 : (field === 'docid' || field === 'vcode' ? 8 : 12)
                };
            }

            if (!fields.date) {
                for (const dp of dateValuePatterns) {
                    if (dp.test(content)) {
                        let box = bboxOf(line.polygon) || bboxOf(line.boundingBox);
                        if (box) {
                            fields.date = {
                                x: Math.round((box.maxX + 10) * unitScale * ptToMm),
                                y: Math.round(box.minY * unitScale * ptToMm),
                                size: 12
                            };
                        }
                        break;
                    }
                }
            }

            // ---- Anchor-based detection for decorative templates ----
            // These templates omit literal field labels ("Name:", "Date:") and instead
            // embed example/recipient data. We detect the recipient line (the name) and
            // the document/date values by their structural position.
            const lower = content.toLowerCase();

            // name: the recipient is the text line immediately following a
            // "presented to / awarded to / certify that" line. We place the name
            // field at that following line's location, skipping over ID-ish lines
            // (which are more likely the admission/no) and falling back to one
            // line-height below the anchor phrase when no clean name line exists.
            if (!fields.name && /presented\s*to|awarded\s*to|hereby\s*award|\bcertif(?:y|ies)\s+that|named\s+as/i.test(lower)) {
                const skipIfId = c => /\b[A-Z0-9]{2,}[\/\-]/.test(c);
                let nameLine = null;
                let k = i + 1;
                while (k < lines.length) {
                    const cand = (lines[k].content || lines[k].text || '').trim();
                    if (cand && !skipIfId(cand)) { nameLine = lines[k]; break; }
                    k++;
                }
                const baseLine = nameLine || line;
                let nb = bboxOf(baseLine.polygon) || bboxOf(baseLine.boundingBox);
                let ob = bboxOf(line.polygon) || bboxOf(line.boundingBox);
                if (nb) {
                    let nY = nb.minY;
                    if (!nameLine && ob) nY = ob.minY + 0.42;
                    fields.name = {
                        x: Math.round((nb.minX + 2) * unitScale * ptToMm),
                        y: Math.round(nY * unitScale * ptToMm),
                        size: 16
                    };
                }
            }

            // adm / docid: an ID-looking value (letters+digits with '/' or '-').
            if (!fields.adm && !fields.docid && /\b\d/.test(content) && /[\/\-]/.test(content) && /\b[A-Z0-9]{2,}\//i.test(content)) {
                let box = bboxOf(line.polygon) || bboxOf(line.boundingBox);
                if (box && !fields.adm) {
                    fields.adm = {
                        x: Math.round((box.minX + 2) * unitScale * ptToMm),
                        y: Math.round(box.minY * unitScale * ptToMm),
                        size: 8
                    };
                }
            }
        }
    };

    for (const page of analyzeResult.pages || []) {
        processLines(page.lines || [], page.words || [], page.width, page.units || page.unit);
    }
    for (const r of analyzeResult.readResults || []) {
        processLines(r.lines || [], r.words || [], r.width, r.units || r.unit);
    }

    return fields;
}

    // ---- Optional at-rest encryption for stored credentials ----
// Active only when DATA_ENCRYPTION_KEY is set (32-byte value, hex or base64).
// Sensitive fields are AES-256-GCM encrypted on disk and decrypted on use.
// Without the env var, values are stored as plaintext (fully backward compatible),
// so existing deployments can adopt encryption by adding the var and restarting.
const ENC_KEY = (function () {
    const raw = process.env.DATA_ENCRYPTION_KEY || '';
    if (!raw) return null;
    let b = Buffer.from(raw, 'base64');
    if (b.length !== 32) b = Buffer.from(raw, 'hex');
    if (b.length !== 32) b = crypto.createHash('sha256').update(raw).digest();
    return b;
})();

function encryptSecret(plain) {
    if (!ENC_KEY || plain === undefined || plain === null || plain === '') return plain;
    try {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
        const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return 'enc:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64');
    } catch { return plain; }
}

function decryptSecret(stored) {
    if (!ENC_KEY || typeof stored !== 'string' || !stored.startsWith('enc:')) return stored;
    try {
        const parts = stored.slice(4).split(':');
        if (parts.length !== 3) return stored;
        const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(parts[0], 'base64'));
        decipher.setAuthTag(Buffer.from(parts[1], 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64')), decipher.final()]).toString('utf8');
    } catch { return stored; }
}

function mpesaSettingsPlain() {
    const s = db.mpesaSettings || {};
    return {
        ...s,
        consumerKey: decryptSecret(s.consumerKey),
        consumerSecret: decryptSecret(s.consumerSecret),
        passkey: decryptSecret(s.passkey)
    };
}

// ---- Maintenance mode ----
// When active, non-admin users are shown a maintenance page and all data APIs
// are locked down. Admins can still sign in and work (bypass cookie issued on login).
const maintenanceBypassTokens = new Map(); // token -> { username, expires }

function getMaintenanceSetting() {
    const rec = (db.settings || []).find(s => s.key === 'maintenance');
    return rec && rec.value && typeof rec.value === 'object' ? rec.value : { active: false, message: '' };
}

function isMaintenanceActive() {
    return getMaintenanceSetting().active === true;
}

function parseCookies(req) {
    const out = {};
    const header = req.headers['cookie'] || '';
    header.split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx === -1) return;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
    });
    return out;
}

function issueMaintenanceBypass(username) {
    const token = crypto.randomBytes(24).toString('hex');
    maintenanceBypassTokens.set(token, { username, expires: Date.now() + 12 * 3600 * 1000 });
    return token;
}

function hasMaintenanceBypass(req) {
    const token = parseCookies(req).mt_bypass;
    if (!token) return false;
    const entry = maintenanceBypassTokens.get(token);
    if (!entry || entry.expires < Date.now()) {
        maintenanceBypassTokens.delete(token);
        return false;
    }
    const user = (db.users || []).find(u => u.username === entry.username);
    return !!(user && user.role === 'admin' && (!user.status || user.status === 'active'));
}

function isAdminRequest(req) {
    const user = getRequestUser(req);
    return !!(user && user.role === 'admin');
}

function maintenanceBlocked(res) {
    return json(res, 503, { error: 'The system is currently under maintenance. Please check back later.' });
}

function getNetworkIPs() {
    const ifs = os.networkInterfaces();
    const ips = [];
    const ignoreRx = /loopback|virtualbox|vmware|hyper.v|vEthernet|bluetooth|docker|vpn|tap|tun|tailscale|zerotier|isatap|teredo|pseudo|miniport|Virtual/i;
    for (const name in ifs) {
        if (ignoreRx.test(name)) continue;
        for (const iface of ifs[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push({ name, address: iface.address });
            }
        }
    }
    ips.sort((a, b) => {
        const aScore = wifiPriority(a.name);
        const bScore = wifiPriority(b.name);
        return aScore - bScore;
    });
    return ips;
}

function wifiPriority(name) {
    const clean = name.replace(/[^a-z0-9]/ig, '').toLowerCase();
    if (/wifi|wireless|wlan/.test(clean)) return 0;
    if (/eth|ethernet|enp|enx|eno|usb|pci/.test(clean)) return 1;
    return 2;
}

function buildUrls(ip) {
    const urls = [];
    if (_httpsPort) urls.push(`https://${ip}:${_httpsPort}`);
    urls.push(`http://${ip}:${PORT}`);
    if (_httpsPort) urls.push(`https://${ip}:${_httpsPort}/connect.html`);
    urls.push(`http://${ip}:${PORT}/connect.html`);
    return urls;
}

const _mpesaTokenCache = new Map(); // key -> { token, expires }
async function mpesaToken(env, key, secret) {
    const cacheKey = env + '|' + key;
    const cached = _mpesaTokenCache.get(cacheKey);
    if (cached && cached.expires > Date.now() + 60000) return cached.token;
    const isSandbox = env === 'sandbox';
    const baseURL = isSandbox ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';
    const auth = Buffer.from(key + ':' + secret).toString('base64');
    return new Promise((resolve, reject) => {
        const u = new URL(baseURL + '/oauth/v1/generate?grant_type=client_credentials');
        const opts = {
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'GET',
            headers: { 'Authorization': 'Basic ' + auth, 'User-Agent': 'NET-Kenya-CMS/1.0', 'Accept': 'application/json' }
        };
        const req = https.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    if (!j.access_token) return reject('Token rejected (HTTP ' + res.statusCode + '): ' + String(data).slice(0, 120));
                    const ttl = (parseInt(j.expires_in) || 3600) * 1000;
                    _mpesaTokenCache.set(cacheKey, { token: j.access_token, expires: Date.now() + ttl });
                    resolve(j.access_token);
                } catch {
                    const title = (String(data).match(/<title[^>]*>([^<]*)/i) || [])[1] || 'no-title';
                    try { process.stderr.write('DARAJA_BLOCKED status=' + res.statusCode + ' server=' + (res.headers.server || '?') + ' via=' + (res.headers.via || '?') + ' title=' + title + ' url=' + u.hostname + '\n'); } catch {}
                    reject('Token fetch failed (HTTP ' + res.statusCode + ' from ' + (res.headers.server || 'unknown') + ' via ' + (res.headers.via || 'unknown') + ' title=' + title + '). Safaricom is blocking the server network — see Railway logs DARAJA_BLOCKED.');
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function mpesaRequest(path, payload, env, key, secret) {
    const token = await mpesaToken(env, key, secret);
    const isSandbox = env === 'sandbox';
    const baseURL = isSandbox ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';
    return new Promise((resolve, reject) => {
        const u = new URL(baseURL + path);
        const body = JSON.stringify(payload);
        const opts = {
            hostname: u.hostname,
            path: u.pathname,
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'User-Agent': 'NET-Kenya-CMS/1.0',
                'Accept': 'application/json'
            }
        };
        const req = https.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function timestamp() {
    const d = new Date();
    return d.getFullYear().toString() +
        String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0') +
        String(d.getHours()).padStart(2, '0') +
        String(d.getMinutes()).padStart(2, '0') +
        String(d.getSeconds()).padStart(2, '0');
}

function handleAPI(req, res) {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = urlObj.pathname;
    const parts = path.split('/').filter(Boolean);

    if (parts[0] !== 'api') return false;

    // GET /api/health
    if (parts.length === 2 && parts[1] === 'health') {
        const s = db.mpesaSettings || {};
        const mpesaConfigured = !!(s.shortcode && s.consumerKey && s.consumerSecret && s.passkey);
        return json(res, 200, { status: 'ok', uptime: process.uptime(), mpesaConfigured });
    }

    // GET /api/events â€” SSE stream for real-time updates (authenticated only)
    if (parts.length === 2 && parts[1] === 'events' && req.method === 'GET') {
        const qUser = sessionUserForToken(urlObj.searchParams.get('token'));
        const hUser = getSessionUser(req);
        if (!qUser && !hUser) return json(res, 401, { error: 'Not authenticated' });
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*'
        });
        res.write('\n');
        const client = { res, id: Date.now() };
        sseClients.push(client);
        const keepalive = setInterval(() => {
            if (!res.writableEnded) res.write(': keepalive\n\n');
            else clearInterval(keepalive);
        }, 15000);
        req.on('close', () => {
            clearInterval(keepalive);
            const idx = sseClients.indexOf(client);
            if (idx >= 0) sseClients.splice(idx, 1);
        });
        return true;
    }

    // GET /api/maintenance-status — public maintenance flag (login screen polling/SSE fallback)
    if (parts.length === 2 && parts[1] === 'maintenance-status' && req.method === 'GET') {
        return json(res, 200, { active: isMaintenanceActive() });
    }

    // GET /api/maintenance-events — public SSE stream for maintenance on/off (no auth)
    if (parts.length === 2 && parts[1] === 'maintenance-events' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*'
        });
        res.write('\n');
        const client = { res, id: Date.now() };
        maintClients.push(client);
        try { client.res.write(`event: maintenance\ndata: ${JSON.stringify({ active: isMaintenanceActive() })}\n\n`); } catch {}
        const keepalive = setInterval(() => {
            if (!res.writableEnded) res.write(': keepalive\n\n');
            else clearInterval(keepalive);
        }, 15000);
        req.on('close', () => {
            clearInterval(keepalive);
            const idx = maintClients.indexOf(client);
            if (idx >= 0) maintClients.splice(idx, 1);
        });
        return true;
    }

    // GET /api/network  — list available network interfaces
    if (parts.length === 2 && parts[1] === 'network' && req.method === 'GET') {
        const ifaces = os.networkInterfaces();
        const list = [];
        for (const name of Object.keys(ifaces)) {
            for (const iface of ifaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    list.push({ name, address: iface.address, netmask: iface.netmask });
                }
            }
        }
        return json(res, 200, { interfaces: list, port: PORT, uptime: process.uptime() });
    }

    // GET /api/network-info â€” get IPs and URLs for device connection
    if (parts.length === 2 && parts[1] === 'network-info' && req.method === 'GET') {
        const ips = getNetworkIPs();
        const urls = ips.flatMap(ip => buildUrls(ip.address));
        console.log('network-info request, ips:', ips);
        return json(res, 200, { port: PORT, httpsPort: _httpsPort, ips, urls, hostname: os.hostname() });
    }

    // GET /api/qr?url=... â€” generate QR code for the given URL
    if (parts.length === 2 && parts[1] === 'qr' && req.method === 'GET') {
        const qrUrl = urlObj.searchParams.get('url') || (_httpsPort ? `https://127.0.0.1:${_httpsPort}` : `http://127.0.0.1:${PORT}`);
        try {
            QRCode.toBuffer(qrUrl, { width: 400, margin: 2, color: { dark: '#000000', light: '#ffffff' } }, (err, buf) => {
                if (err) return json(res, 500, { error: err.message });
                res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
                res.end(buf);
            });
        } catch (e) {
            QRCode.toString(qrUrl, { type: 'svg' }, (err, svg) => {
                if (err) return json(res, 500, { error: err.message });
                res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
                res.end(svg);
            });
        }
        return true;
    }

    // GET /api/backup â€” download full database JSON (admin only)
    if (parts.length === 2 && parts[1] === 'backup') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        const authUser = getRequestUser(req);
        if (!authUser || authUser.role !== 'admin') return json(res, 403, { error: 'Administrator access required' });
        flushDB();
        const backup = JSON.stringify(db, null, 2);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        auditLog('backup-download', 'database', { bytes: backup.length }, authUser.username);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="backup-${ts}.json"`,
            'Content-Length': Buffer.byteLength(backup)
        });
        return res.end(backup);
    }

    // POST /api/ai/detect-fields — Multi-pass field detection: PDF.js → Azure prebuilt-read
    if (parts.length >= 2 && parts[1] === 'ai' && parts[2] === 'detect-fields' && req.method === 'POST') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const user = getRequestUser(req);
        if (!user || user.role !== 'admin') return json(res, 403, { error: 'Admin only' });

        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { pdfBase64 } = JSON.parse(body);
                if (!pdfBase64) return json(res, 400, { error: 'pdfBase64 required' });

                // Pass 1: PDF.js text extraction (free, instant)
                let fields = await extractFieldsFromPdfJs(pdfBase64);
                let method = 'pdfjs';
                let confidence = Object.keys(fields).length >= 3 ? 'high' : 'low';

                // Pass 2: Azure OCR if PDF.js didn't find enough fields
                const endpoint = process.env.AZURE_FORM_RECOGNIZER_ENDPOINT;
                const key = process.env.AZURE_FORM_RECOGNIZER_KEY;
                // Use prebuilt-read (better for OCR) instead of prebuilt-layout
                const modelId = process.env.AZURE_DIPLOMA_DETECT_MODEL || 'prebuilt-read';

                if (Object.keys(fields).length < 3 && endpoint && key) {
                    try {
                        const pdfBuffer = Buffer.from(pdfBase64, 'base64');
                        const analyzeUrl = `${endpoint}/formrecognizer/documentModels/${modelId}:analyze?api-version=2023-07-31`;
                        const analyzeRes = await fetch(analyzeUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/pdf',
                                'Ocp-Apim-Subscription-Key': key
                            },
                            body: pdfBuffer
                        });

                        if (analyzeRes.ok) {
                            const operationLocation = analyzeRes.headers.get('operation-location');
                            if (operationLocation) {
                                // Poll for results (with timeout)
                                let result;
                                for (let i = 0; i < 20; i++) {
                                    await new Promise(r => setTimeout(r, 800));
                                    const pollRes = await fetch(operationLocation, {
                                        headers: { 'Ocp-Apim-Subscription-Key': key }
                                    });
                                    const pollData = await pollRes.json();
                                    if (pollData.status === 'succeeded') { result = pollData; break; }
                                    if (pollData.status === 'failed') break;
                                }

                                if (result && result.analyzeResult) {
                                    const azureFields = extractFieldPositions(result.analyzeResult);
                                    delete global.__lastAzure;
                                    for (const [k, v] of Object.entries(azureFields)) {
                                        if (!fields[k]) fields[k] = v;
                                    }
                                    method = Object.keys(fields).length > Object.keys(azureFields).length ? 'pdfjs+azure' : 'azure';
                                    confidence = Object.keys(fields).length >= 3 ? 'high' : 'medium';
                                }
                            }
                        }
                    } catch (azureErr) {
                        console.warn('Azure OCR failed, using PDF.js results:', azureErr.message);
                    }
                }

                // Log detection for debugging
                console.log(`Field detection: method=${method}, fields=${Object.keys(fields).length}, confidence=${confidence}`);
                console.log('Detected fields:', JSON.stringify(fields));

                return json(res, 200, { fields, method, confidence });

            } catch (e) {
                console.error('AI detect-fields error:', e);
                return json(res, 500, { error: e.message });
            }
        });
        return true;
    }

    // POST /api/restore â€” upload full database JSON (replaces all data) (admin only)
    if (parts.length === 2 && parts[1] === 'restore' && req.method === 'POST') {
        const authUser = getRequestUser(req);
        if (!authUser || authUser.role !== 'admin') return json(res, 403, { error: 'Administrator access required' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (!data || typeof data !== 'object') return json(res, 400, { error: 'Invalid backup file' });
                const count = Object.keys(data).length;
                db = data;
                flushDB();
                auditLog('restore', 'database', { stores: count }, authUser.username);
                console.log('Database restored â€”', count, 'stores');
                json(res, 200, { ok: true, stores: count });
            } catch { json(res, 400, { error: 'Invalid JSON in backup file' }); }
        });
        return true;
    }

    // GET /api/db-size â€” report database stats
    if (parts.length === 2 && parts[1] === 'db-size' && req.method === 'GET') {
        const stats = {};
        let total = 0;
        for (const key of Object.keys(db)) {
            if (Array.isArray(db[key])) {
                stats[key] = db[key].length;
                total += db[key].length;
            } else if (db[key] && typeof db[key] === 'object') {
                stats[key] = Object.keys(db[key]).length;
                total += Object.keys(db[key]).length;
            }
        }
        const size = (() => { try { return fs.statSync(DB_FILE).size; } catch { return 0; } })();
        const backupCount = (() => { try { return fs.readdirSync(DB_BACKUP_DIR).filter(f => f.startsWith('server-data.') && f.endsWith('.json')).length; } catch { return 0; } })();
        const hasBackup = fs.existsSync(DB_BACKUP);
        return json(res, 200, { stores: stats, totalRecords: total, fileSize: size, backupCount, hasBackup });
    }

// GET /api/certificate/:id/pdf — serve certificate as PDF
    if (parts.length >= 3 && parts[0] === 'api' && parts[1] === 'certificate' && req.method === 'GET') {
        console.log('CERT ROUTE HIT:', { parts, path });
        const isPdf = parts.length === 4 && parts[3] === 'pdf';
        const certId = decodeURIComponent(parts[2]);
        const cert = db.certificates?.find(c => c.id === certId);
        if (!cert) return json(res, 404, { error: 'Certificate not found' });

        // Serve PDF via Puppeteer (async IIFE)
        (async () => {
            try {
                const puppeteer = require('puppeteer-core');
                const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

                const browser = await puppeteer.launch({
                    headless: 'new',
                    executablePath,
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
                });
                const page = await browser.newPage();

                // Build full HTML with print styles
                const html = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="UTF-8">
                        <title>${cert.docTitle || 'Certificate'}</title>
                        <style>
                            @page { size: A4; margin: 20mm; }
                            body { font-family: 'DejaVu Serif', Georgia, serif; margin: 0; padding: 0; background: #fff; color: #1a1a2e; }
                            .certificate { width: 100%; height: 100vh; display: flex; flex-direction: column; }
                            img { max-width: 100%; height: auto; }
                        </style>
                    </head>
                    <body>${cert.content}</body>
                    </html>
                `;

                await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 90000 });
                await page.evaluate(() => {
                    const imgs = Array.from(document.images);
                    return Promise.all(imgs.map(img => {
                        if (img.complete) return Promise.resolve();
                        return new Promise(resolve => { img.onload = img.onerror = resolve; });
                    }));
                });
                const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' } });
                await browser.close();

                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename="${cert.docTitle || 'certificate'}-${certId}.pdf"`);
                return res.end(pdfBuffer);
            } catch (e) {
                console.error('PDF generation failed:', e);
                // Fallback: serve HTML with print CSS
                res.setHeader('Content-Type', 'text/html');
                return res.end(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="UTF-8">
                        <title>${cert.docTitle || 'Certificate'}</title>
                        <style>
                            @media print { @page { size: A4; margin: 20mm; } body { margin: 0; background: #fff; } .no-print { display: none !important; } }
                            body { font-family: Georgia, serif; margin: 0; padding: 40px; background: #fff; color: #1a1a2e; line-height: 1.5; }
                        </style>
                    </head>
                    <body>${cert.content}</body>
                    </html>
                `);
            }
        })();
    }

    // GET /api/backups â€” list available timestamped backups (admin only)
    if (parts.length === 2 && parts[1] === 'backups' && req.method === 'GET') {
        const authUser = getRequestUser(req);
        if (!authUser || authUser.role !== 'admin') return json(res, 403, { error: 'Administrator access required' });
        try {
            ensureBackupDir();
            const files = fs.readdirSync(DB_BACKUP_DIR)
                .filter(f => f.startsWith('server-data.') && f.endsWith('.json'))
                .sort()
                .reverse()
                .map(f => {
                    const p = path.join(DB_BACKUP_DIR, f);
                    try {
                        const s = fs.statSync(p);
                        const data = readJSON(p);
                        const records = data && typeof data === 'object' && !Array.isArray(data)
                            ? Object.keys(data).reduce((sum, k) => sum + (Array.isArray(data[k]) ? data[k].length : 0), 0)
                            : 0;
                        return { name: f, size: s.size, date: s.mtime.toISOString(), records };
                    } catch { return null; }
                })
                .filter(Boolean);
            return json(res, 200, { backups: files });
        } catch { return json(res, 200, { backups: [] }); }
    }

    // POST /api/restore-from-backup â€” restore from a named timestamped backup (admin only)
    if (parts.length === 3 && parts[1] === 'restore-from-backup' && req.method === 'POST') {
        const authUser = getRequestUser(req);
        if (!authUser || authUser.role !== 'admin') return json(res, 403, { error: 'Administrator access required' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { name } = JSON.parse(body);
                if (!name) return json(res, 400, { error: 'Missing backup name' });
                const backupPath = path.join(DB_BACKUP_DIR, name);
                if (!fs.existsSync(backupPath)) return json(res, 404, { error: 'Backup not found' });
                const data = readJSON(backupPath);
                if (!data || typeof data !== 'object') return json(res, 400, { error: 'Corrupted backup file' });
                // Also ensure main backup is updated
                fs.writeFileSync(DB_BACKUP, JSON.stringify(data, null, 2), 'utf8');
                db = data;
                flushDB();
                auditLog('restore-from-backup', 'database', { name }, authUser.username);
                console.log('Database restored from backup:', name);
                json(res, 200, { ok: true, stores: Object.keys(data).length });
            } catch { json(res, 400, { error: 'Restore failed' }); }
        });
        return true;
    }

    // POST /api/login â€” server-side login (single round trip)
    if (parts.length === 2 && parts[1] === 'login' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                if (loginRateBlocked(req)) {
                    return json(res, 429, { error: 'Too many failed attempts. Please try again in 15 minutes.' });
                }
                const { input, password } = JSON.parse(body);
                if (!input || !password) return json(res, 400, { error: 'Enter username and password' });

                const hash = pw => crypto.createHash('sha256').update(pw, 'utf8').digest('hex');
                const users = db.users || [];
                const students = db.students || [];

                // Lookup user by username, studentId, phone, email, or admission number
                // (usernames match case-insensitively — "John" and "john" are the same account)
                const inputLower = String(input).toLowerCase();
                let user = users.find(u => u.username === input) || users.find(u => String(u.username || '').toLowerCase() === inputLower);
                if (!user) user = users.find(u => u.studentId === input);
                if (!user) {
                    const student = students.find(s => s.phone === input && s.status !== 'pending');
                    if (student) user = users.find(u => u.studentId === student.id || u.username === student.id || u.username === student.admissionNumber || u.username === student.phone || u.username === student.email);
                }
                if (!user) {
                    const student = students.find(s => (s.admissionNumber === input || s.id === input) && s.status !== 'pending');
                    if (student) user = users.find(u => u.studentId === student.id || u.username === student.id || u.username === student.admissionNumber || u.username === student.phone || u.username === student.email);
                }
                if (!user) {
                    const student = students.find(s => s.phone === input || s.admissionNumber === input || s.id === input);
                    if (student) user = users.find(u => u.role === 'student' && u.name && student.name && u.name.toLowerCase() === student.name.toLowerCase());
                }
                if (!user) {
                    const candidate = students.find(s => (s.phone === input || s.admissionNumber === input || s.id === input) && s.status === 'active' && s.phone && s.admissionNumber);
                    if (candidate) {
                        const pwHash = hash(candidate.admissionNumber);
                        if (pwHash === hash(password) || candidate.admissionNumber === password) {
                            user = { username: candidate.phone, password: pwHash, name: candidate.name, role: 'student', status: 'active', studentId: candidate.id, createdAt: new Date().toISOString() };
                            db.users.push(user);
                            safeWriteJSON(db);
                        }
                    }
                }

                if (!user) { loginRateFail(req); auditLog('login-failed', 'user', { username: input }, 'anonymous'); return json(res, 401, { error: 'Invalid username or password' }); }

                const pwHash = hash(password);
                let pwMatch = user.password === pwHash || user.password === password;

                if (!pwMatch && user.role === 'student') {
                    const s = students.find(s => s.id === user.studentId || s.phone === user.username || s.email === user.username || (user.name && s.name === user.name));
                    if (s && s.admissionNumber) pwMatch = hash(s.admissionNumber) === pwHash || s.admissionNumber === password;
                }

                if (!pwMatch) { loginRateFail(req); auditLog('login-failed', 'user', { username: input }, 'anonymous'); return json(res, 401, { error: 'Invalid username or password' }); }

                if (user.password !== pwHash) { user.password = pwHash; safeWriteJSON(db); }
                if (user.status === 'locked') return json(res, 403, { error: 'Account locked due to inactivity. Contact administration to reactivate.' });
                if (user.status === 'inactive') return json(res, 403, { error: 'Account is inactive. Contact administration.' });
                if (user.status === 'pending') return json(res, 403, { error: 'Account pending approval. Please wait for admin confirmation.' });

                // Maintenance mode: only admins can sign in
                if (isMaintenanceActive() && user.role !== 'admin') {
                    return json(res, 503, { error: 'The system is currently under maintenance. Please check back later.' });
                }

                user.lastLogin = new Date().toISOString();
                safeWriteJSON(db);

                // Ensure studentId is present for student users
                if (user.role === 'student' && !user.studentId) {
                    const student = students.find(s => s.phone === user.username || s.id === user.username || s.email === user.username);
                    if (student) user.studentId = student.id;
                }

                // Strip password before sending to client
                const safeUser = { ...user };
                delete safeUser.password;
                delete safeUser.warned1;
                delete safeUser.warned2;

                // Admins get a maintenance bypass token so they can refresh the page
                // and still load the app while maintenance mode is active.
                if (user.role === 'admin') safeUser.mt_bypass = issueMaintenanceBypass(user.username);

                // Server-verified session token for ALL authenticated API calls.
                safeUser.session_token = issueSession(user.username);

                loginRateSuccess(req);
                auditLog('login', 'user', { username: user.username, role: user.role }, user.username);

                json(res, 200, { user: safeUser });
            } catch (e) { process.stderr.write('LOGIN_ERROR: ' + (e && e.stack || e) + '\n'); json(res, 500, { error: 'Login failed' }); }
        });
        return true;
    }

    // POST /api/hash â€” SHA-256 hashing (for phones where crypto.subtle is unavailable)
    if (parts.length === 2 && parts[1] === 'hash' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { password } = JSON.parse(body);
                if (!password) return json(res, 400, { error: 'Missing password' });
                const hash = crypto.createHash('sha256').update(password, 'utf8').digest('hex');
                json(res, 200, { hash });
            } catch { json(res, 400, { error: 'Invalid JSON' }); }
        });
        return true;
    }

    // GET /api/fee-gate — read effective fee-gate config (admin: full; coordinator: own region only)
    if (parts.length === 2 && parts[1] === 'fee-gate' && req.method === 'GET') {
        const fgUser = getRequestUser(req);
        if (!fgUser) return json(res, 401, { error: 'Not authenticated' });
        const rec = (db.settings || []).find(s => s.key === 'feeGate');
        const cfg = rec ? (rec.value || rec) : { enabled: false };
        if (fgUser.role === 'admin') return json(res, 200, { ok: true, config: cfg });
        if (fgUser.role === 'coordinator') {
            const rid = fgUser.user.regionId || '';
            const regions = (cfg && cfg.regions) || {};
            return json(res, 200, { ok: true, mode: cfg.mode || 'global', regionId: rid, region: regions[rid] || null, global: { enabled: !!(cfg && cfg.enabled), amount: (cfg && cfg.amount) || 0, day: (cfg && cfg.day) ?? 1, time: (cfg && cfg.time) || '12:00', tabs: (cfg && cfg.tabs) || {} } });
        }
        return json(res, 403, { error: 'Forbidden' });
    }

    // PUT /api/fee-gate — save fee-gate config (admin: full; coordinator: own region only)
    if (parts.length === 2 && parts[1] === 'fee-gate' && req.method === 'PUT') {
        const fgUser = getRequestUser(req);
        if (!fgUser) return json(res, 401, { error: 'Not authenticated' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                let rec = (db.settings || []).find(s => s.key === 'feeGate');
                if (!rec) { rec = { key: 'feeGate' }; db.settings.push(rec); }
                const cur = rec.value || rec;
                const cleanTabs = (t) => {
                    const known = ['courses', 'exams', 'quizzes', 'discussions', 'live', 'notes'];
                    const out = {};
                    known.forEach(k => { out[k] = !(t && t[k] === false); });
                    return out;
                };
                const cleanRegion = (r) => ({
                    enabled: !!r.enabled,
                    amount: Math.max(0, Number(r.amount) || 0),
                    day: [0, 1, 2, 3, 4, 5, 6].includes(Number(r.day)) ? Number(r.day) : 1,
                    time: /^\d{2}:\d{2}$/.test(String(r.time || '')) ? String(r.time) : '12:00',
                    tabs: cleanTabs(r.tabs),
                    scope: ['all', 'selected', 'except'].includes(r.scope) ? r.scope : 'all',
                    overrides: (r.overrides && typeof r.overrides === 'object') ? r.overrides : {}
                });
                if (fgUser.role === 'admin') {
                    const next = { key: 'feeGate' };
                    if (data && typeof data === 'object' && ('enabled' in data || 'amount' in data || 'tabs' in data) && !data.regions && data.mode === undefined) {
                        Object.assign(next, cur, cleanRegion({ ...cur, ...data }), { key: 'feeGate' });
                        delete next.regions;
                    } else {
                        next.enabled = !!data.enabled;
                        next.amount = Math.max(0, Number(data.amount) || 0);
                        next.day = [0, 1, 2, 3, 4, 5, 6].includes(Number(data.day)) ? Number(data.day) : 1;
                        next.time = /^\d{2}:\d{2}$/.test(String(data.time || '')) ? String(data.time) : '12:00';
                        next.tabs = cleanTabs(data.tabs);
                        next.scope = ['all', 'selected', 'except'].includes(data.scope) ? data.scope : 'all';
                        next.overrides = (data.overrides && typeof data.overrides === 'object') ? data.overrides : {};
                        next.mode = data.mode === 'per-region' ? 'per-region' : 'global';
                        next.regions = {};
                        Object.entries((data.regions && typeof data.regions === 'object') ? data.regions : {}).forEach(([rid, r]) => { next.regions[String(rid)] = cleanRegion(r || {}); });
                    }
                    rec.value = next;
                    saveDB();
                    auditLog('fee-gate', 'settings', { by: fgUser.username }, fgUser.username);
                    return json(res, 200, { ok: true });
                }
                if (fgUser.role === 'coordinator') {
                    const rid = fgUser.user.regionId || '';
                    if (!rid) return json(res, 403, { error: 'No region assigned' });
                    const regions = (cur.regions && typeof cur.regions === 'object') ? { ...cur.regions } : {};
                    regions[rid] = cleanRegion(data || {});
                    const next = { ...cur, regions, mode: 'per-region', key: 'feeGate' };
                    rec.value = next;
                    saveDB();
                    auditLog('fee-gate-region', 'settings', { region: rid, by: fgUser.username }, fgUser.username);
                    return json(res, 200, { ok: true, regionId: rid });
                }
                return json(res, 403, { error: 'Forbidden' });
            } catch (e) { return json(res, 400, { error: 'Invalid request' }); }
        });
        return true;
    }

    // POST /api/change-password — self-service password change (any authenticated user, own account only)
    if (parts.length === 2 && parts[1] === 'change-password' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const authUser = getRequestUser(req);
                if (!authUser || !authUser.user) return json(res, 401, { error: 'Not authenticated' });
                const { currentPw, newPw } = JSON.parse(body);
                if (!currentPw || !newPw) return json(res, 400, { error: 'Enter current and new password' });
                if (String(newPw).length < 6) return json(res, 400, { error: 'New password must be at least 6 characters' });
                const user = (db.users || []).find(u => u.username === authUser.username);
                if (!user) return json(res, 404, { error: 'Account not found' });
                const hash = pw => crypto.createHash('sha256').update(pw, 'utf8').digest('hex');
                const okCurrent = user.password === hash(currentPw) || user.password === currentPw;
                if (!okCurrent) return json(res, 403, { error: 'Current password is incorrect' });
                if (currentPw === newPw) return json(res, 400, { error: 'New password must differ from current' });
                user.password = hash(newPw);
                saveDB();
                auditLog('change-password', 'user', { username: user.username }, user.username);
                return json(res, 200, { ok: true });
            } catch { return json(res, 400, { error: 'Invalid request' }); }
        });
        return true;
    }

    // GET /api/public-contact — admin phone for login screen (public, no secrets)
    if (parts.length === 2 && parts[1] === 'public-contact' && req.method === 'GET') {
        try {
            const rec = (db.settings || []).find(s => s.key === 'whatsapp');
            const val = rec ? (rec.value || rec) : null;
            const phone = (val && (val.adminNumber || val.phone)) || '';
            return json(res, 200, { phone: String(phone || '') });
        } catch { return json(res, 200, { phone: '' }); }
    }

    // POST /api/verify — public guest document verification (rate-limited, minimal fields only)
    if (parts.length === 2 && parts[1] === 'verify' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                if (verifyRateBlocked(req)) {
                    return json(res, 429, { error: 'Too many verification attempts. Please try again in 15 minutes.' });
                }
                const { docId, vCode } = JSON.parse(body);
                if (!docId || !vCode) return json(res, 400, { ok: false, error: 'Enter the Document ID and Verification Code.' });
                const did = String(docId).trim();
                const vc = String(vCode).trim();
                let record = (db.transcriptVerifications || []).find(r => String(r.docId) === did) || null;
                let isTranscript = !!record;
                if (!record) {
                    record = (db.certificates || []).find(c => String(c.docId) === did || String(c.id) === did) || null;
                    isTranscript = false;
                }
                if (!record) { verifyRateFail(req); return json(res, 200, { ok: false, reason: 'not-found', docId: did }); }
                if (String(record.vCode) !== vc) { verifyRateFail(req); return json(res, 200, { ok: false, reason: 'mismatch', docId: did }); }
                verifyRateSuccess(req);
                // Resolve the live student record first: certificate rows carry
                // studentName but NO admission number, so the student table is
                // the source of truth for name/admission/program/center.
                let stu = null;
                try {
                    const sid = record.studentId || '';
                    if (sid) {
                        stu = (db.students || []).find(s => String(s.id) === String(sid)) || null;
                        if (!stu) stu = (db.alumni || []).find(a => String(a.studentId) === String(sid)) || null;
                    }
                } catch {}
                let studyCenter = '';
                try {
                    const cid = stu ? (stu.studyCenterId || '') : '';
                    if (cid) {
                        const center = (db.studyCenters || []).find(c => String(c.id) === String(cid));
                        studyCenter = center ? (center.name || '') : String(cid);
                    }
                } catch {}
                return json(res, 200, { ok: true, isTranscript,
                    studentName: (stu && stu.name) || record.studentName || record.name || '',
                    admission: (stu && (stu.admissionNumber || stu.id)) || record.admission || record.admissionNumber || '',
                    program: (stu && stu.program) || record.program || '',
                    studyCenter,
                    docId: record.docId || did,
                    docTitle: record.docTitle || record.type || '',
                    generatedAt: record.generatedAt || record.createdAt || '',
                    revoked: record.docStatus === 'revoked',
                    revokedBy: record.revokedBy || '',
                    revokedAt: record.revokedAt || '',
                    revokeReason: record.revokeReason || '',
                    cgpa: (typeof record.cgpa === 'number' ? record.cgpa : undefined),
                    classification: record.classification || ''
                });
            } catch { return json(res, 400, { ok: false, error: 'Invalid request' }); }
        });
        return true;
    }

    // POST /api/heartbeat — client sends username every 30s (session-verified)
    if (parts.length === 2 && parts[1] === 'heartbeat' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const authUser = getRequestUser(req);
                if (!authUser) return json(res, 401, { error: 'Not authenticated' });
                const { username } = JSON.parse(body);
                if (!username || username !== authUser.username) return json(res, 401, { error: 'Not authenticated' });
                const u = authUser.user || {};
                onlineUsers.set(username, { name: u.name || username, role: u.role || 'unknown', lastSeen: Date.now(), ip: req.connection.remoteAddress || req.socket.remoteAddress });
                json(res, 200, { ok: true, online: onlineUsers.size });
            } catch { json(res, 400, { error: 'Invalid' }); }
        });
        return true;
    }

    // GET /api/jitsi-token â€” mint a JaaS JWT for the current user (moderator for staff).
    // Only active when JWT_APP_ID, JWT_API_KEY_ID, JWT_PRIVATE_KEY and JITSI_BASE_URL are
    // configured; otherwise the client falls back to the legacy password-based room URL.
    if (parts.length === 2 && parts[1] === 'jitsi-token' && req.method === 'GET') {
        const authUser = getRequestUser(req);
        const user = authUser && authUser.user;
        if (!user) return json(res, 401, { error: 'Not authenticated' });
        if (!jitsiJwtEnabled()) {
            return json(res, 200, { jwtEnabled: false, token: '', base: '' });
        }
        let privileged = isPrivilegedRole(user.role);
        const meetingId = urlObj.searchParams.get('meeting') || '';
        if (meetingId) {
            const mtg = (db.meetings || []).find(m => String(m.id) === String(meetingId));
            if (!mtg) return json(res, 404, { error: 'Meeting not found' });
            if (!meetingVisibleTo(user, mtg)) return json(res, 403, { error: 'Not invited to this meeting' });
            const mods = Array.isArray(mtg.moderatorRoles) ? mtg.moderatorRoles : [];
            privileged = mods.includes(user.role);
        }
        const token = buildJitsiJwt(user, privileged);
        return json(res, 200, { jwtEnabled: true, token, base: JITSI_BASE_URL, appId: JWT_APP_ID, moderator: privileged });
    }

    // GET /api/online â€” returns list of users active in last 90s (authenticated only)
    if (parts.length === 2 && parts[1] === 'online' && req.method === 'GET') {
        const authUser = getRequestUser(req);
        if (!authUser) return json(res, 401, { error: 'Not authenticated' });
        cleanOnlineUsers();
        const list = [];
        for (const [username, data] of onlineUsers) {
            list.push({ username, name: data.name, role: data.role, lastSeen: data.lastSeen });
        }
        list.sort((a, b) => b.lastSeen - a.lastSeen);
        return json(res, 200, { count: list.length, users: list });
    }

    // POST /api/mpesa/settings (admin only)
    if (parts.length >= 3 && parts[1] === 'mpesa' && parts[2] === 'settings' && req.method === 'POST') {
        const authUser = getRequestUser(req);
        if (!authUser || authUser.role !== 'admin') return json(res, 403, { error: 'Administrator access required' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const stored = { ...data };
                if (data.consumerKey) stored.consumerKey = encryptSecret(data.consumerKey);
                if (data.consumerSecret) stored.consumerSecret = encryptSecret(data.consumerSecret);
                if (data.passkey) stored.passkey = encryptSecret(data.passkey);
                db.mpesaSettings = stored;
                saveDB();
                auditLog('mpesa-settings', 'mpesa', { saved: true }, authUser.username);
                json(res, 200, { success: true });
            } catch { json(res, 400, { error: 'Invalid JSON' }); }
        });
        return true;
    }

    // GET /api/mpesa/settings (admin only)
    if (parts.length >= 3 && parts[1] === 'mpesa' && parts[2] === 'settings' && req.method === 'GET') {
        const authUser = getRequestUser(req);
        if (!authUser || authUser.role !== 'admin') return json(res, 403, { error: 'Administrator access required' });
        json(res, 200, mpesaSettingsPlain());
        return true;
    }

    // POST /api/mpesa/stkpush (authenticated; students may only pay for themselves)
    if (parts.length >= 3 && parts[1] === 'mpesa' && parts[2] === 'stkpush' && req.method === 'POST') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const stkUser = getRequestUser(req);
        if (!stkUser) return json(res, 401, { error: 'Not authenticated' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const s = mpesaSettingsPlain();
                if (!s.shortcode || !s.consumerKey || !s.consumerSecret || !s.passkey) {
                    return json(res, 400, { error: 'M-Pesa not configured. Save settings first.' });
                }
                // Normalize payer number: 07.. / +254.. / 254.. -> 254..
                // May differ from the registered number (parent/guardian paying).
                let digits = String(data.phone || '').replace(/[^0-9]/g, '');
                if (/^0/.test(digits)) digits = '254' + digits.substring(1);
                if (!/^254[17]\d{8}$/.test(digits)) {
                    return json(res, 400, { error: 'Enter a valid Safaricom number (e.g. 0712 345 678).' });
                }
                const amount = Math.round(Number(data.amount));
                if (!amount || amount < 1) return json(res, 400, { error: 'Enter an amount of at least KES 1.' });
                if (amount > 500000) return json(res, 400, { error: 'Amount too large for a single STK push.' });
                let studentId = String(data.studentId || '');
                if (stkUser.role === 'student') {
                    const ownId = String((stkUser.user || {}).studentId || stkUser.username || '');
                    const stu = (db.students || []).find(x => String(x.id) === ownId || String(x.phone) === String(stkUser.username));
                    studentId = stu ? stu.id : ownId;
                }
                if (!studentId) return json(res, 400, { error: 'Missing student.' });
                // Cap at remaining program fee (same total for all, unless student record sets its own feeAmount)
                try {
                    const stuRec = (db.students || []).find(x => String(x.id) === String(studentId)) || null;
                    let courseFee = Number(stuRec && stuRec.feeAmount) || 0;
                    if (!(courseFee > 0) && stuRec && stuRec.program) {
                        const acad = (db.settings || []).find(s => s.key === 'academic');
                        const av = acad ? (acad.value || acad) : null;
                        if (av && av.programFees && Number(av.programFees[stuRec.program]) > 0) courseFee = Number(av.programFees[stuRec.program]);
                    }
                    if (courseFee > 0) {
                        const paidSoFar = (db.payments || []).filter(p => String(p.studentId) === String(studentId)).reduce((s, p) => s + (Number(p.amount) || 0), 0)
                            + (db.waivers || []).filter(w => String(w.studentId) === String(studentId)).reduce((s, w) => s + (Number(w.amount) || 0), 0);
                        const remaining = Math.max(0, courseFee - paidSoFar);
                        if (remaining <= 0) return json(res, 400, { error: 'Program fee fully paid. Nothing due.' });
                        if (amount > remaining) return json(res, 400, { error: 'Amount exceeds your remaining program balance of KES ' + Math.round(remaining) + '.' });
                    }
                } catch (capErr) { console.error('mpesa cap check failed:', capErr); }
                const ts = timestamp();
                const pw = Buffer.from(s.shortcode + s.passkey + ts).toString('base64');
                const txnType = s.transactionType === 'till' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline';
                const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
                const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || 'https';
                const callbackUrl = (host.startsWith('localhost') ? 'http://' + host : proto + '://' + host) + '/api/mpesa/callback';
                const payload = {
                    BusinessShortCode: s.shortcode,
                    Password: pw,
                    Timestamp: ts,
                    TransactionType: txnType,
                    Amount: amount,
                    PartyA: digits,
                    PartyB: s.shortcode,
                    PhoneNumber: digits,
                    CallBackURL: callbackUrl,
                    AccountReference: String(data.reference || studentId).slice(0, 12),
                    TransactionDesc: String(data.description || 'Fee Payment').slice(0, 20)
                };
                const result = await mpesaRequest('/mpesa/stkpush/v1/processrequest', payload, s.environment, s.consumerKey, s.consumerSecret);
                if (result && result.CheckoutRequestID) {
                    if (!Array.isArray(db.mpesaTransactions)) db.mpesaTransactions = [];
                    db.mpesaTransactions.push({ id: 'STK-' + Date.now(), checkoutRequestId: result.CheckoutRequestID, merchantRequestId: result.MerchantRequestID || '', studentId, amount, phone: digits, status: 'pending', initiatedBy: stkUser.username, createdAt: new Date().toISOString() });
                    saveDB();
                }
                json(res, 200, result);
            } catch (e) { json(res, 500, { error: e.message || e }); }
        });
        return true;
    }

    // POST /api/mpesa/callback — Safaricom result callback (public; no auth by design)
    if (parts.length >= 3 && parts[1] === 'mpesa' && parts[2] === 'callback' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const cb = data.Body && data.Body.stkCallback;
                if (!cb) return json(res, 200, { ResultCode: 1, ResultDesc: 'Ignored' });
                const checkoutId = cb.CheckoutRequestID || '';
                const txn = (db.mpesaTransactions || []).find(t => t.checkoutRequestId === checkoutId);
                if (cb.ResultCode === 0) {
                    const items = (((cb.CallbackMetadata || {}).Item) || []);
                    const val = (n) => { const it = items.find(i => i.Name === n); return it ? it.Value : null; };
                    const mpesaReceipt = val('MpesaReceiptNumber') || '';
                    const amountPaid = Number(val('Amount')) || (txn ? txn.amount : 0);
                    const payerPhone = String(val('PhoneNumber') || (txn ? txn.phone : ''));
                    const studentId = txn ? txn.studentId : '';
                    if (txn) { txn.status = 'complete'; txn.mpesaReceipt = mpesaReceipt; txn.completedAt = new Date().toISOString(); }
                    if (studentId && amountPaid > 0) {
                        const exists = (db.payments || []).some(p => (p.mpesaCheckout && p.mpesaCheckout === checkoutId) || (p.reference === mpesaReceipt && mpesaReceipt));
                        if (!exists) {
                            const d = new Date();
                            const ym = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
                            const prefix = 'RCT-' + ym + '-';
                            const seq = (db.payments || []).filter(p => p.receiptNo && String(p.receiptNo).startsWith(prefix)).length + 1;
                            const receiptNo = prefix + String(seq).padStart(4, '0');
                            if (!Array.isArray(db.payments)) db.payments = [];
                            db.payments.push({ id: 'PMT-' + Date.now().toString(36).toUpperCase(), studentId, amount: amountPaid, method: 'M-Pesa STK', reference: mpesaReceipt, mpesaCheckout: checkoutId, notes: 'Paid via ' + payerPhone, receiptNo, date: d.toISOString().split('T')[0], createdAt: d.toISOString() });
                            broadcastEvent('db-change', { store: 'payments' });
                        }
                    }
                    saveDB();
                    auditLog('mpesa-payment', 'payment', { checkoutId, receipt: mpesaReceipt, amount: amountPaid }, 'mpesa-callback');
                } else if (txn) {
                    txn.status = 'failed';
                    txn.failReason = cb.ResultDesc || 'cancelled';
                    saveDB();
                }
                return json(res, 200, { ResultCode: 0, ResultDesc: 'Accepted' });
            } catch (e) { return json(res, 200, { ResultCode: 1, ResultDesc: 'Error' }); }
        });
        return true;
    }

    // POST /api/mpesa/query
    if (parts.length >= 3 && parts[1] === 'mpesa' && parts[2] === 'query' && req.method === 'POST') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        if (!getRequestUser(req)) return json(res, 401, { error: 'Not authenticated' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const s = mpesaSettingsPlain();
                if (!s.shortcode || !s.consumerKey || !s.consumerSecret || !s.passkey) {
                    return json(res, 400, { error: 'M-Pesa not configured.' });
                }
                const ts = timestamp();
                const pw = Buffer.from(s.shortcode + s.passkey + ts).toString('base64');
                const payload = {
                    BusinessShortCode: s.shortcode,
                    Password: pw,
                    Timestamp: ts,
                    CheckoutRequestID: data.checkoutRequestId
                };
                const result = await mpesaRequest('/mpesa/stkpushquery/v1/query', payload, s.environment, s.consumerKey, s.consumerSecret);
                // Reconcile: if Daraja confirms success but the callback never
                // arrived (blocked/slow), record the payment here so the
                // student balance reflects it. Idempotent via checkout id.
                try {
                    const rc = result && (result.ResultCode === 0 || result.ResultCode === '0');
                    const cid = String(data.checkoutRequestId || '');
                    const txn = cid ? (db.mpesaTransactions || []).find(t => t.checkoutRequestId === cid) : null;
                    if (rc && txn && txn.status !== 'complete' && txn.studentId && txn.amount > 0) {
                        const dup = (db.payments || []).some(p => (p.mpesaCheckout && p.mpesaCheckout === cid) || (txn.mpesaReceipt && p.reference === txn.mpesaReceipt));
                        if (!dup) {
                            const d = new Date();
                            const ym = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0');
                            const prefix = 'RCT-' + ym + '-';
                            const seq = (db.payments || []).filter(p => p.receiptNo && String(p.receiptNo).startsWith(prefix)).length + 1;
                            if (!Array.isArray(db.payments)) db.payments = [];
                            db.payments.push({ id: 'PMT-' + Date.now().toString(36).toUpperCase(), studentId: txn.studentId, amount: txn.amount, method: 'M-Pesa STK', reference: txn.mpesaReceipt || cid, mpesaCheckout: cid, notes: 'Paid via ' + (txn.phone || '') + ' (confirmed by query)', receiptNo: prefix + String(seq).padStart(4, '0'), date: d.toISOString().split('T')[0], createdAt: d.toISOString() });
                            txn.status = 'complete';
                            txn.completedAt = d.toISOString();
                            txn.completedVia = 'query';
                            broadcastEvent('db-change', { store: 'payments' });
                            saveDB();
                            auditLog('mpesa-payment', 'payment', { checkoutId: cid, amount: txn.amount, via: 'query' }, 'mpesa-query');
                        }
                    }
                } catch (recErr) { console.error('mpesa query reconcile failed:', recErr); }
                json(res, 200, result);
            } catch (e) { json(res, 500, { error: e.message || e }); }
        });
        return true;
    }

    // POST /api/send-sms â€” send bulk SMS via Africa's Talking
    if (parts.length === 2 && parts[1] === 'send-sms' && req.method === 'POST') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { recipients, logEntries } = JSON.parse(body);
                const smsSettings = db.settings && db.settings.find(s => s.key === 'smsSettings');
                if (!smsSettings || !smsSettings.value) return json(res, 400, { error: 'SMS not configured. Save settings first.' });
                const cfg = { ...smsSettings.value, apiKey: decryptSecret(smsSettings.value.apiKey) };
                if (!cfg.apiKey || !cfg.username) return json(res, 400, { error: 'SMS API key or username missing.' });

                if (!db.smsLog) db.smsLog = [];
                let sent = 0, failed = 0;

                for (let i = 0; i < recipients.length; i++) {
                    const { phone, message } = recipients[i];
                    if (!phone || !message) { failed++; continue; }
                    try {
                        const postData = querystring.stringify({
                            username: cfg.username,
                            to: phone,
                            message: message,
                            from: cfg.senderId || ''
                        });
                        const result = await new Promise((resolve, reject) => {
                            const opts = {
                                hostname: 'api.africastalking.com',
                                port: 443,
                                path: '/version1/messaging',
                                method: 'POST',
                                headers: {
                                    'apiKey': cfg.apiKey,
                                    'Content-Type': 'application/x-www-form-urlencoded',
                                    'Content-Length': Buffer.byteLength(postData),
                                    'Accept': 'application/json'
                                }
                            };
                            const req2 = https.request(opts, res2 => {
                                let data = '';
                                res2.on('data', c => data += c);
                                res2.on('end', () => {
                                    try { resolve(JSON.parse(data)); } catch { resolve({ SMSMessageData: { Message: data } }); }
                                });
                            });
                            req2.on('error', reject);
                            req2.write(postData);
                            req2.end();
                        });
                        if (result && result.SMSMessageData && result.SMSMessageData.Recipients) {
                            const r = result.SMSMessageData.Recipients[0];
                            if (r && (r.status === 'Success' || r.statusCode === '101')) sent++;
                            else failed++;
                        } else {
                            failed++;
                        }
                    } catch (e) { failed++; }
                }

                // Save log entries
                if (logEntries && logEntries.length) {
                    for (const entry of logEntries) {
                        entry.createdAt = new Date().toISOString();
                        db.smsLog.push(entry);
                    }
                }
                saveDB();
                broadcastEvent('db-change', { store: 'smsLog' });
                json(res, 200, { sent, failed, total: recipients.length });
            } catch (e) { json(res, 500, { error: e.message || e }); }
        });
        return true;
    }

    // -----------------------------------------------------------
    // Public signup endpoint â€” /api/signup  (POST)
    // -----------------------------------------------------------
    if (parts.length === 2 && parts[1] === 'signup' && req.method === 'POST') {
        if (isMaintenanceActive()) return maintenanceBlocked(res);
        try {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const { name, email, phone, program: prog, studyCenterId, regionId } = data;
                    if (!name || !phone || !prog) return json(res, 400, { error: 'Name, phone, and program are required' });
                    // Check duplicate phone
                    if (!db.students) db.students = [];
                    const existing = db.students.find(s => s.phone && s.phone.replace(/[^0-9]/g,'') === phone.replace(/[^0-9]/g,'') && s.status !== 'rejected');
                    if (existing) return json(res, 409, { error: 'Phone already registered' });
                    // Generate admission number using system counter
                    let admSeq = 0;
                    const admSetting = db.settings ? db.settings.find(s => s.key === 'admissionLastSeq') : null;
                    if (admSetting && typeof admSetting.value === 'number') admSeq = admSetting.value;
                    // Find max seq from existing student admission numbers
                    let maxSeq = 0;
                    db.students.forEach(s => {
                        if (s.admissionNumber && typeof s.admissionNumber === 'string') {
                            const parts2 = s.admissionNumber.split('/');
                            const last = parts2[parts2.length - 1];
                            const n = parseInt(last, 10);
                            if (!isNaN(n) && n > maxSeq) maxSeq = n;
                        }
                    });
                    const nextSeq = Math.max(admSeq, maxSeq) + 1;
                    // Save sequence
                    if (!db.settings) db.settings = [];
                    const idx = db.settings.findIndex(s => s.key === 'admissionLastSeq');
                    if (idx >= 0) db.settings[idx] = { key: 'admissionLastSeq', value: nextSeq };
                    else db.settings.push({ key: 'admissionLastSeq', value: nextSeq });
                    // Build admission number
                    const center = studyCenterId ? db.studyCenters?.find(c => c.id === studyCenterId) : null;
                    const centerCode = center ? center.code : 'GEN';
                    const branding = db.settings ? db.settings.find(s => s.key === 'branding') : null;
                    const initials = branding && branding.initials ? branding.initials : 'STU';
                    const year = new Date().getFullYear().toString().slice(-2);
                    const month = String(new Date().getMonth() + 1);
                    const seqStr = String(nextSeq).padStart(3, '0');
                    const admissionNumber = `${initials}/${centerCode}/${month}-${year}/${seqStr}`;
                    const studentId = 'STU-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
                    const student = {
                        id: studentId, name, email, phone, program: prog, studyCenterId: studyCenterId || '', regionId: regionId || '',
                        admissionNumber, status: 'pending', year: 1, feeAmount: 0,
                        enrollDate: '', createdAt: new Date().toISOString(),
                        registrationRequestedAt: new Date().toISOString(), source: 'public-signup'
                    };
                    db.students.push(student);
                    saveDB();
                    broadcastEvent('db-change', { store: 'students' });
                    // Create admin alert
                    if (!db.alerts) db.alerts = [];
                    db.alerts.push({
                        id: 'ALERT-' + Date.now(), type: 'warning', severity: 'info',
                        title: 'New Registration Request',
                        message: `${name} has requested registration. Phone: ${phone}, Program: ${prog}. Admission#: ${admissionNumber}. Please review and approve or reject.`,
                        createdAt: new Date().toISOString(), read: false
                    });
                    saveDB();
                    broadcastEvent('db-change', { store: 'alerts' });
                    json(res, 200, { success: true, student, admissionNumber });
                } catch (e) { json(res, 400, { error: 'Invalid request body: ' + e.message }); }
            });
        } catch (e) { json(res, 500, { error: e.message || e }); }
        return true;
    }

    // Externalized document content â€” /api/doc-content/:key
    // GET  -> returns the raw PDF bytes for a stored document
    // PUT  -> stores base64 JSON body as the doc's file (certificate write path)
    if (parts[1] === 'doc-content' && req.method === 'GET' && parts.length === 3) {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const user = getRequestUser(req);
        if (!canAccessStore(user, 'certificates', 'GET')) return json(res, 403, { error: 'Forbidden' });
        const key = parts[2];
        const file = docPath(key);
        if (!fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
        try {
            const buf = fs.readFileSync(file);
            res.writeHead(200, {
                'Content-Type': 'application/pdf',
                'Content-Length': buf.length,
                'Content-Disposition': 'inline; filename="' + docSafeKey(key) + '.pdf"',
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'no-store'
            });
            res.end(buf);
        } catch (e) { json(res, 500, { error: e.message || e }); }
        return true;
    }
    if (parts[1] === 'doc-content' && req.method === 'PUT' && parts.length === 3) {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const user = getRequestUser(req);
        if (!canAccessStore(user, 'certificates', 'PUT')) return json(res, 403, { error: 'Forbidden' });
        const key = parts[2];
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body);
                const b64 = (parsed && parsed.base64) ? String(parsed.base64) : '';
                if (!b64) return json(res, 400, { error: 'Missing base64' });
                ensureDocStore();
                const buf = Buffer.from(b64, 'base64');
                fs.writeFileSync(docPath(key), buf);
                json(res, 200, { ok: true, contentPath: '/api/doc-content/' + encodeURIComponent(key) });
            } catch (e) { json(res, 400, { error: 'Invalid body: ' + e.message }); }
        });
        return true;
    }
    if (parts[1] === 'doc-content' && req.method === 'DELETE' && parts.length === 3) {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const user = getRequestUser(req);
        if (!canAccessStore(user, 'certificates', 'DELETE')) return json(res, 403, { error: 'Forbidden' });
        const file = docPath(parts[2]);
        try { if (fs.existsSync(file)) fs.unlinkSync(file); json(res, 200, { ok: true }); }
        catch (e) { json(res, 500, { error: e.message || e }); }
        return true;
    }

    // -----------------------------------------------------------
    // Generic DB CRUD endpoints â€” /api/db/:store[/:key]
    // -----------------------------------------------------------
    // GET /api/db/batch?stores=users,students,courses  â€” batch fetch multiple stores
    if (parts.length >= 3 && parts[1] === 'db' && parts[2] === 'batch' && req.method === 'GET') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const user = getRequestUser(req);
        const names = (urlObj.searchParams.get('stores') || '').split(',').filter(Boolean);
        const result = {};
        for (const name of names) {
            if (!db[name]) db[name] = [];
            if (!canAccessStore(user, name, 'GET')) { result[name] = []; continue; }
            let rows = filterStoreForUser(user, name, db[name]);
            if (name === 'settings' && (!user || user.role !== 'admin')) {
                rows = rows.filter(r => r && r.key !== 'smsSettings');
            }
            if (name === 'settings') rows = rows.map(injectSettingsBlobs);
            if (name === 'settings' && (!user || user.role !== 'admin')) {
                rows = rows.map(r => (r && r.key === 'mpesa') ? { key: 'mpesa', payButtonEnabled: !!((r.value || r).payButtonEnabled) } : r);
            }
            result[name] = rows;
        }
return json(res, 200, result);
    }

    // DELETE /api/db/settings/prune-audit?keep=N  â€” admin only prune audit log
    if (parts.length >= 3 && parts[1] === 'db' && parts[2] === 'settings' && parts[3] === 'prune-audit' && req.method === 'DELETE') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const user = getRequestUser(req);
        if (!canAccessStore(user, 'settings', req.method) || user.role !== 'admin') {
            return json(res, 403, { error: 'Admin only' });
        }
        const keepCount = parseInt(urlObj.searchParams.get('keep')) || 0;
        if (keepCount > 0) {
            db.audit = db.audit.slice(-keepCount);
        } else {
            db.audit = [];
        }
        saveDB();
        return json(res, 200, { ok: true, remaining: db.audit.length });
    }

    if (parts.length >= 2 && parts[1] === 'db') {
        const store = decodeURIComponent(parts[2]);
        const key = parts[3] ? decodeURIComponent(parts[3]) : null;

        // Maintenance mode: only admins can touch data
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);

        // Authorization check
        const user = getRequestUser(req);
        if (!canAccessStore(user, store, req.method)) {
            return json(res, 403, { error: 'Insufficient permissions for this resource' });
        }

        // KeyPath mapping (default = 'id')
        const KEY_PATHS = {
            settings: 'key',
            counters: 'key',
            users: 'username',
            transcriptVerifications: 'docId',
            manuals: 'id'
        };
        const keyPath = KEY_PATHS[store] || 'id';

        // Ensure the store array exists in the DB
        if (!db[store]) db[store] = [];

        // Helper to save DB after mutations â€” broadcast FIRST so clients get instant notification
        function mutate(record) { broadcastEvent('db-change', { store }); saveDB(); }

        // GET /api/db/:store   â€” return all records (with optional ?index=&value= filter, ?page=&limit=)
        if (req.method === 'GET' && !key) {
            let results = db[store] || [];
            
            // Students can only see their own payments
            if (user && user.role === 'student' && store === 'payments') {
                const sid = (user.user || {}).studentId;
                if (sid) {
                    results = results.filter(r => String(r.studentId) === String(sid) || String(r.studentPhone) === String(user.username));
                } else {
                    results = [];
                }
            }

            // Students only see their own student/user records
            results = filterStoreForUser(user, store, results);

            // Non-admins must not read credential-bearing settings records
            if (store === 'settings' && (!user || user.role !== 'admin')) {
                results = results.filter(r => r && r.key !== 'smsSettings');
            }
            
            const indexParam = urlObj.searchParams.get('index');
            const valueParam = urlObj.searchParams.get('value');
            if (indexParam && valueParam !== null) {
                results = results.filter(r => String(r[indexParam]) === valueParam);
            }
            const page = parseInt(urlObj.searchParams.get('page')) || 0;
            const limit = parseInt(urlObj.searchParams.get('limit')) || 0;
            results = backfillCertIdentifiers(store, results);
            results = externalizeStoreRecords(store, results);
            if (store === 'settings') results = results.map(injectSettingsBlobs);
            if (store === 'settings' && (!user || user.role !== 'admin')) {
                results = results.map(r => (r && r.key === 'mpesa') ? { key: 'mpesa', payButtonEnabled: !!((r.value || r).payButtonEnabled) } : r);
            }
            if (limit > 0 && page > 0) {
                const start = (page - 1) * limit;
                const total = results.length;
                results = results.slice(start, start + limit);
                return json(res, 200, { data: results, page, limit, total, pages: Math.ceil(total / limit) });
            }
            return json(res, 200, results);
        }

        // GET /api/db/:store/:key  â€” return single record or null
        if (req.method === 'GET' && key) {
            let item = db[store].find(r => String(r[keyPath]) === key) || null;
            if (item && user && user.role === 'student') {
                const filtered = filterStoreForUser(user, store, [item]);
                item = filtered.length ? filtered[0] : null;
            }
            if (item && store === 'settings' && key === 'smsSettings' && (!user || user.role !== 'admin')) {
                item = null;
            }
            if (item) {
                const list = externalizeStoreRecords(store, [item]);
                item = list[0] || null;
                if (store === 'settings') item = injectSettingsBlobs(item);
                if (item && store === 'settings' && key === 'mpesa' && (!user || user.role !== 'admin')) {
                    item = { key: 'mpesa', payButtonEnabled: !!((item.value || item).payButtonEnabled) };
                }
            }
            return json(res, 200, item);
        }

        // PUT /api/db/:store  â€” upsert (create or replace)
        if (req.method === 'PUT') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    const value = parsed.value || parsed;
                    if (!value || typeof value !== 'object') return json(res, 400, { error: 'Invalid body' });
                    if (store === 'settings' && value.key === 'maintenance' && (!user || user.role !== 'admin')) {
                        return json(res, 403, { error: 'Only administrators can change maintenance mode' });
                    }
                    if (store === 'settings' && value.key === 'assistantAccess' && (!user || user.role !== 'admin')) {
                        return json(res, 403, { error: 'Only administrators can change assistant access' });
                    }
                    const pk = value[keyPath];
                    if (pk === undefined || pk === null) {
                        console.log('PUT ' + store + ' FAILED - missing ' + keyPath + ' bodyKeys:', Object.keys(value));
                        return json(res, 400, { error: `Record missing key field "${keyPath}"` });
                    }
                    // Phase 1: externalize any big base64 PDF in documents before they
                    // land in the in-memory JSON DB, so the JSON stays small to read/write.
                    let toStore = value;
                    if (store === 'certificates' || store === 'idCards' || store === 'idcards') {
                        toStore = externalizeCertificate(value).record;
                    }
                    // Heavy PDF templates in settings go straight to disk, never the JSON.
                    if (store === 'settings') externalizeSettingsRecord(value);
                    const idx = db[store].findIndex(r => r[keyPath] === pk);
                    if (idx >= 0) db[store][idx] = toStore;
                    else db[store].push(toStore);
                    mutate(toStore);
                    if (store === 'settings' && toStore.key === 'maintenance') {
                        try { broadcastMaintenance(!!((toStore.value || toStore).active)); } catch {}
                    }
                    json(res, 200, { ok: true, key: pk });
                } catch (e) { json(res, 400, { error: 'Invalid JSON' }); }
            });
            return true;
        }

        // POST /api/db/:store  â€” add only (error if key exists)
        if (req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    const value = parsed.value || parsed;
                    if (!value || typeof value !== 'object') return json(res, 400, { error: 'Invalid body' });
                    if (store === 'settings' && value.key === 'maintenance' && (!user || user.role !== 'admin')) {
                        return json(res, 403, { error: 'Only administrators can change maintenance mode' });
                    }
                    if (store === 'settings' && value.key === 'assistantAccess' && (!user || user.role !== 'admin')) {
                        return json(res, 403, { error: 'Only administrators can change assistant access' });
                    }
                    const pk = value[keyPath];
                    if (pk === undefined || pk === null) return json(res, 400, { error: `Record missing key field "${keyPath}"` });
                    const exists = db[store].some(r => r[keyPath] === pk);
                    if (exists) return json(res, 409, { error: `Record with ${keyPath}="${pk}" already exists` });
                    db[store].push(value);
                    mutate(value);
                    if (store === 'settings' && value.key === 'maintenance') {
                        try { broadcastMaintenance(!!((value.value || value).active)); } catch {}
                    }
                    json(res, 200, { ok: true, key: pk });
                } catch (e) { json(res, 400, { error: 'Invalid JSON' }); }
            });
            return true;
        }

        // DELETE /api/db/:store  â€” clear entire store
        if (req.method === 'DELETE' && !key) {
            const before = db[store].length;
            db[store] = [];
            mutate({ _cleared: true });
            auditLog('clear-store', store, { records: before }, user && user.username);
            return json(res, 200, { ok: true });
        }

        // DELETE /api/db/:store/:key  â€” remove single record
        if (req.method === 'DELETE' && key) {
            const idx = db[store].findIndex(r => String(r[keyPath]) === key);
            if (idx >= 0) db[store].splice(idx, 1);
            mutate({ [keyPath]: key, _deleted: true });
            auditLog('delete', store, { key }, user && user.username);
            return json(res, 200, { ok: true, deleted: idx >= 0 });
        }

        return json(res, 405, { error: 'Method not allowed' });
    }

    // Discussion API endpoints
    if (parts[1] === 'discussions') {
        const courseId = parts[2];
        
        // GET /api/discussions/:courseId â€” get messages for a course
        if (parts.length === 3 && req.method === 'GET') {
            const discussions = db.discussions || [];
            const courseDiscussions = discussions.filter(d => d.courseId === courseId);
            return json(res, 200, { messages: courseDiscussions });
        }
        
        // POST /api/discussions/:courseId â€” post a new message
        if (parts.length === 3 && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const { userId, userName, userRole, content } = JSON.parse(body);
                    if (!userId || !userName || !content) return json(res, 400, { error: 'Missing required fields' });
                    
                    const discussions = db.discussions || [];
                    const message = {
                        id: 'DISC-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
                        courseId,
                        userId,
                        userName,
                        userRole,
                        content,
                        pinned: false,
                        locked: false,
                        likes: [],
                        replies: [],
                        timestamp: new Date().toISOString()
                    };
                    discussions.push(message);
                    db.discussions = discussions;
                    flushDB();
                    broadcastEvent('discussion-new', message);
                    json(res, 200, { ok: true, message });
                } catch (e) { json(res, 400, { error: 'Invalid JSON' }); }
            });
            return true;
        }
        
        // PUT /api/discussions/:courseId/:messageId â€” moderate (pin/lock/delete) or reply/like
        if (parts.length === 4 && req.method === 'PUT') {
            const messageId = parts[3];
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    const { action, userRole } = parsed;
                    if (!['pin', 'lock', 'unpin', 'unlock', 'delete', 'reply', 'like'].includes(action)) return json(res, 400, { error: 'Invalid action' });
                    
                    const isStaff = ['admin', 'lecturer', 'registrar'].includes(userRole);
                    if (!isStaff && !['reply', 'like'].includes(action)) return json(res, 403, { error: 'Insufficient permissions' });
                    
                    const discussions = db.discussions || [];
                    const idx = discussions.findIndex(d => d.id === messageId && d.courseId === courseId);
                    if (idx === -1) return json(res, 404, { error: 'Message not found' });
                    
                    // Ensure sub-arrays exist on legacy messages
                    if (!discussions[idx].likes) discussions[idx].likes = [];
                    if (!discussions[idx].replies) discussions[idx].replies = [];
                    
                    if (action === 'delete') {
                        discussions.splice(idx, 1);
                    } else if (action === 'pin') {
                        discussions[idx].pinned = true;
                    } else if (action === 'unpin') {
                        discussions[idx].pinned = false;
                    } else if (action === 'lock') {
                        discussions[idx].locked = true;
                    } else if (action === 'unlock') {
                        discussions[idx].locked = false;
                    } else if (action === 'reply') {
                        const { userId, userName, content } = parsed;
                        if (!userId || !userName || !content) return json(res, 400, { error: 'Missing required fields for reply' });
                        discussions[idx].replies.push({
                            id: 'REP-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
                            messageId,
                            userId,
                            userName,
                            userRole: userRole || 'student',
                            content,
                            timestamp: new Date().toISOString()
                        });
                    } else if (action === 'like') {
                        const { userId } = parsed;
                        if (!userId) return json(res, 400, { error: 'Missing userId' });
                        const likeIdx = discussions[idx].likes.indexOf(userId);
                        if (likeIdx >= 0) {
                            discussions[idx].likes.splice(likeIdx, 1);
                        } else {
                            discussions[idx].likes.push(userId);
                        }
                    }
                    
                    db.discussions = discussions;
                    flushDB();
                    broadcastEvent('discussion-update', { courseId, messageId, action });
                    json(res, 200, { ok: true });
                } catch (e) { json(res, 400, { error: 'Invalid JSON' }); }
            });
            return true;
        }
    }

    return false;
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
    }

    if (handleAPI(req, res)) return;

    let url = req.url.split('?')[0];
    // Cache-busting: serve versioned paths like /css/main.132.css as /css/main.css
    url = url.replace(/\.\d+\.(css|js)$/i, '.$1');

    if (url === '/api/qr') {
        const searchParams = new URL(req.url, 'http://localhost').searchParams;
        const size = Math.min(parseInt(searchParams.get('size')) || 200, 400);
        const urlParam = searchParams.get('url');
        let qrUrl;
        if (urlParam) {
            qrUrl = urlParam;
        } else {
            const ips = getNetworkIPs();
            if (!ips.length) {
                res.writeHead(503, { 'Content-Type': 'text/plain' });
                return res.end('No network found');
            }
            const primaryIP = ips[0];
            qrUrl = _httpsPort ? `https://${primaryIP.address}:${_httpsPort}` : `http://${primaryIP.address}:${PORT}`;
            console.log('QR code using IP:', primaryIP.address, primaryIP.name, 'from', ips.length, 'interfaces');
        }
        QRCode.toBuffer(qrUrl, { width: size, margin: 2, errorCorrectionLevel: 'M' }, (err, png) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                return res.end('QR generation failed');
            }
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
            return res.end(png);
        });
        return;
    }


    if (url === '/') url = '/index.html';

    // Maintenance mode: show the maintenance page to everyone except admins (bypass cookie)
    if (isMaintenanceActive() && !hasMaintenanceBypass(req) && (url === '/index.html' || url === '/student-manual.html' || url === '/coordinator-manual.html' || url === '/admin-manual.html' || url === '/assistant-admin-manual.html' || url === '/staff-manual.html')) {
        url = '/maintenance.html';
    }

    // In pkg mode, check for external files first (allows hot-updating HTML/JS/CSS)
    let filePath;
    if (process.pkg && ROOT !== DATA_ROOT) {
        const externalPath = path.join(DATA_ROOT, url);
        if (fs.existsSync(externalPath)) {
            filePath = externalPath;
        } else {
            filePath = path.join(ROOT, url);
        }
    } else {
        filePath = path.join(ROOT, url);
    }

    if (!filePath.startsWith(ROOT) && !filePath.startsWith(DATA_ROOT)) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    // Inject branding into index.html and manual pages at serve-time
    if (filePath.endsWith('index.html') || filePath.endsWith('student-manual.html') || filePath.endsWith('coordinator-manual.html') || filePath.endsWith('admin-manual.html') || filePath.endsWith('assistant-admin-manual.html') || filePath.endsWith('staff-manual.html') || filePath.endsWith('maintenance.html')) {
        fs.readFile(filePath, 'utf8', (err, html) => {
            if (err) {
                res.writeHead(500);
                return res.end('Server error');
            }
            const branding = db.settings ? db.settings.find(s => s.key === 'branding') : null;
            const schoolName = branding && branding.schoolName ? branding.schoolName : 'NET Foundation Kenya';
            const initials = branding && branding.initials ? branding.initials : 'NET';
            const logoData = branding && branding.logo ? branding.logo : '';
            let logoCss = '';
            if (branding && branding.logo) {
                logoCss = '<style>#login-logo{background:transparent url(\'' + branding.logo + '\') no-repeat center / cover !important;text-indent:-9999px!important;background-color:transparent!important}#header-logo-img{display:block}#header-logo-placeholder{display:none}.terms-logo{background:transparent url(\'' + branding.logo + '\') no-repeat center / cover}</style>';
            }
            const maintSetting = getMaintenanceSetting();
            const maintMsg = maintSetting.message && String(maintSetting.message).trim()
                ? String(maintSetting.message).trim()
                : 'We are carrying out scheduled maintenance and improvements. The system will be back shortly. Thank you for your patience.';
            html = html.replace(/\{\{SCHOOL_NAME\}\}/g, schoolName)
                       .replace(/\{\{INITIALS\}\}/g, initials)
                       .replace(/\{\{LOGO_CSS\}\}/g, logoCss)
                       .replace(/\{\{LOGO_DATA\}\}/g, logoData)
                       .replace(/\{\{LOGO_VISIBLE\}\}/g, logoData ? 'block' : 'none')
                       .replace(/\{\{INITIALS_VISIBLE\}\}/g, logoData ? 'none' : 'block')
                       .replace(/\{\{MAINTENANCE_MESSAGE\}\}/g, maintMsg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('CDN-Cache-Control', 'no-store');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'SAMEORIGIN');
            res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
            res.end(html);
        });
        return;
    }

    serveCachedFile(res, filePath, url, req);
});

// WebSocket server for discussions
wss = new WebSocket.Server({ server });
wss.on('connection', (ws, req) => {
    let currentCourseId = null;
    let currentUser = null;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            switch (msg.type) {
                case 'join':
                    currentCourseId = msg.courseId;
                    currentUser = msg.user;
                    if (!wsClients.has(currentCourseId)) wsClients.set(currentCourseId, new Set());
                    wsClients.get(currentCourseId).add({ ws, userId: currentUser.id, userName: currentUser.name, userRole: currentUser.role });
                    break;
                case 'message':
                    if (currentCourseId && wsClients.has(currentCourseId)) {
                        const broadcast = {
                            type: 'message',
                            id: 'DISC-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
                            courseId: currentCourseId,
                            userId: currentUser.id,
                            userName: currentUser.name,
                            userRole: currentUser.role,
                            content: msg.content,
                            timestamp: new Date().toISOString()
                        };
                        wsClients.get(currentCourseId).forEach(client => {
                            if (client.ws.readyState === WebSocket.OPEN) {
                                client.ws.send(JSON.stringify(broadcast));
                            }
                        });
                    }
                    break;
                case 'pin':
                case 'lock':
                case 'delete':
                    if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'lecturer' || currentUser.role === 'registrar')) {
                        broadcastDiscussionEvent(currentCourseId, msg.type, msg.messageId);
                    }
                    break;
            }
        } catch (e) {
            console.error('WS message error:', e);
        }
    });

    ws.on('close', () => {
        if (currentCourseId && wsClients.has(currentCourseId)) {
            const clients = wsClients.get(currentCourseId);
            for (const client of clients) {
                if (client.ws === ws) {
                    clients.delete(client);
                    break;
                }
            }
            if (clients.size === 0) wsClients.delete(currentCourseId);
        }
    });
});

function broadcastDiscussionEvent(courseId, eventType, messageId) {
    if (!courseId || !wsClients.has(courseId)) return;
    const event = { type: eventType, messageId, timestamp: new Date().toISOString() };
    wsClients.get(courseId).forEach(client => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(event));
        }
    });
}

server.keepAliveTimeout = 30000;
server.headersTimeout = 31000;
server.listen(PORT, '0.0.0.0', () => {
    const local = `http://127.0.0.1:${PORT}`;
    const ips = getNetworkIPs();
    const urls = ips.flatMap(ip => buildUrls(ip.address));
    const primaryUrl = urls.length > 0 ? urls[0] : local;

    console.log('');
    console.log('  â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—');
    console.log('  â•‘      College Management System Server           â•‘');
    console.log('  â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£');
    console.log(`  â•‘  HTTP:   ${local.padEnd(43)}â•‘`);
    if (_httpsPort) console.log(`  â•‘  HTTPS:  https://127.0.0.1:${String(_httpsPort).padEnd(28)}â•‘`);
    urls.forEach(u => {
        const isHttps = u.startsWith('https');
        const isConnect = u.includes('connect.html');
        let label;
        if (isConnect && isHttps) label = '  â•‘  Sec-C:';
        else if (isConnect) label = '  â•‘  Connect:';
        else if (isHttps) label = '  â•‘  SecNet:';
        else label = '  â•‘  Network:';
        const display = isHttps ? u : u;
        console.log(`${label} ${display.padEnd(43)}â•‘`);
    });
    console.log('  â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£');
    console.log('  â•‘  Scan QR from connect.html for mobile access    â•‘');
    console.log(`  â•‘  Primary: ${(primaryUrl).padEnd(46)}â•‘`);
    console.log('  â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£');
    console.log('  â•‘  M-Pesa API: /api/mpesa/*                      â•‘');
    console.log('  â•‘  Press Ctrl+C to stop the server               â•‘');
    console.log('  â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
    console.log('');
    // Start auto-updater
    try {
        require('./updater');
    } catch (e) {
        console.log('[Updater] Not started:', e.message);
    }
    // Start HTTPS server (optional, non-blocking)
    try {
        const { createHttpsServer } = require('./server-https');
        createHttpsServer(server).then(srv => {
            if (srv) {
                _httpsPort = srv.address().port;
                // Refresh banner with HTTPS info
                const httpsLocal = `https://127.0.0.1:${_httpsPort}`;
                const ips2 = getNetworkIPs();
                const urls2 = ips2.flatMap(ip => buildUrls(ip.address));
                const primary2 = urls2.length > 0 ? urls2[0] : httpsLocal;
                console.log('  â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—');
                console.log('  â•‘      HTTPS Enabled â€” Certificates Active       â•‘');
                console.log('  â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£');
                console.log(`  â•‘  Local:   ${httpsLocal.padEnd(43)}â•‘`);
                urls2.filter(u => u.startsWith('https')).forEach(u => {
                    const label = u.includes('connect.html') ? '  â•‘  Sec-C:' : '  â•‘  SecNet:';
                    console.log(`${label} ${u.padEnd(43)}â•‘`);
                });
                console.log(`  â•‘  QR:     ${primary2.padEnd(43)}â•‘`);
                console.log('  â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
                console.log('');
            }
        }).catch(() => {});
    } catch (e) {
        console.log('[HTTPS] Not started:', e.message);
    }
    // auto-open browser after 1.5s
    setTimeout(() => {
        try {
            const { spawn } = require('child_process');
            if (process.platform === 'win32') {
                spawn('cmd', ['/c', 'start', '', local], { detached: true, stdio: 'ignore' }).unref();
            } else if (process.platform === 'darwin') {
                spawn('open', [local], { detached: true, stdio: 'ignore' }).unref();
            } else {
                spawn('xdg-open', [local], { detached: true, stdio: 'ignore' }).unref();
            }
        } catch (e) { /* non-critical */ }
    }, 1500);
});



