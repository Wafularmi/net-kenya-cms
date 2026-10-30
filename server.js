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
const dripEngine = require('./drip-engine');

// ---- Password hashing --------------------------------------------------
// New and changed passwords are stored as PBKDF2-HMAC-SHA256 with a random
// per-user salt, never as a bare digest. Accounts that predate this change
// still hold a bare sha256 digest: they keep working, and are upgraded to
// PBKDF2 the first time their owner signs in successfully.
const PBKDF2_ITERATIONS = 120000;
const PBKDF2_KEYLEN = 32;
function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const dk = crypto.pbkdf2Sync(String(pw), salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, 'sha256');
    return 'pbkdf2$' + PBKDF2_ITERATIONS + '$' + salt.toString('base64') + '$' + dk.toString('base64');
}
function verifyPassword(pw, stored) {
    if (!stored) return false;
    const v = String(stored);
    if (v.startsWith('pbkdf2$')) {
        const p = v.split('$');
        const iter = parseInt(p[1], 10) || PBKDF2_ITERATIONS;
        let salt, want;
        try { salt = Buffer.from(p[2] || '', 'base64'); want = Buffer.from(p[3] || '', 'base64'); } catch { return false; }
        if (!salt.length || !want.length) return false;
        const dk = crypto.pbkdf2Sync(String(pw), salt, iter, want.length, 'sha256');
        return dk.length === want.length && crypto.timingSafeEqual(dk, want);
    }
    // Legacy: a bare sha256 digest.
    if (/^[0-9a-f]{64}$/i.test(v)) {
        const legacy = Buffer.from(crypto.createHash('sha256').update(String(pw), 'utf8').digest('hex'), 'hex');
        const storedBuf = Buffer.from(v, 'hex');
        return storedBuf.length === legacy.length && crypto.timingSafeEqual(storedBuf, legacy);
    }
    return false;
}

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
// Phase 2 (active): PDF bytes live in docs/ (+ persistent /data volume copies)
// and are STRIPPED from server-data.json once the volume copy is confirmed.
// Reads serve the disk file (via /api/doc-content). server-data.json stays small
// so every save is milliseconds and the event loop never freezes the live system.
const DOC_STORE_DIR = process.env.DOC_STORE_DIR || path.join(DATA_ROOT, 'docs');
const DOC_STRIP_INLINE = process.env.DOC_STRIP_INLINE === '1';
// Persistent volume for document files (mirrors the DB volume strategy).
// /data exists on Railway; absent locally (dev keeps inline copies as before).
const DOC_VOLUME_DIR = process.env.DOC_VOLUME_DIR || '/data/docs';
function volumeRoot() { try { return path.dirname(DOC_VOLUME_DIR); } catch { return '/data'; } }
function volumeAvailable() { try { return fs.existsSync(volumeRoot()); } catch { return false; } }
function syncDocFileToVolume(filename) {
    // Best-effort persistent copy. Returns true only when the volume copy is confirmed.
    try {
        const src = path.join(DOC_STORE_DIR, filename);
        if (!fs.existsSync(src)) return false;
        try { fs.mkdirSync(DOC_VOLUME_DIR, { recursive: true }); } catch {}
        fs.copyFileSync(src, path.join(DOC_VOLUME_DIR, filename));
        return fs.existsSync(path.join(DOC_VOLUME_DIR, filename));
    } catch (e) { return false; }
}
function restoreDocsFromVolume() {
    // After an ephemeral restart, bring back doc files from the persistent volume.
    let restored = 0;
    try {
        ensureDocStore();
        if (!fs.existsSync(DOC_VOLUME_DIR)) return 0;
        const files = fs.readdirSync(DOC_VOLUME_DIR).filter(f => f.endsWith('.pdf') || f.endsWith('.html'));
        for (const f of files) {
            try {
                const dest = path.join(DOC_STORE_DIR, f);
                if (!fs.existsSync(dest)) { fs.copyFileSync(path.join(DOC_VOLUME_DIR, f), dest); restored++; }
            } catch {}
        }
    } catch (e) { console.error('restoreDocsFromVolume failed:', e.message); }
    return restored;
}
function docSafeKey(key) {
    return String(key || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || ('doc-' + Date.now());
}
function docPath(key) { return path.join(DOC_STORE_DIR, docSafeKey(key) + '.pdf'); }
// Module-scope file helpers (the request handler shadows `path`, so plain
// path.join() there would throw "path.join is not a function").
function docPathByKey(key) { try { return path.join(DOC_STORE_DIR, docSafeKey(key) + '.pdf'); } catch { return null; } }
function docVolPathByKey(key) { try { return path.join(DOC_VOLUME_DIR, docSafeKey(key) + '.pdf'); } catch { return null; } }
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
    if (!fs.existsSync(file)) {
        try {
            const buf = Buffer.from(b64, 'base64');
            fs.writeFileSync(file, buf);
        } catch (e) { console.error('externalizeCertificate failed:', key, e); return { record: cert, stored: false }; }
    }
    // Disk copy verified (pre-existing or just written): persist to the volume,
    // then drop the inline bytes so server-data.json stays small. Inline is kept
    // ONLY when no persistent volume exists (local dev) or the copy failed.
    try {
        if (syncDocFileToVolume(docSafeKey(key) + '.pdf')) delete rec.content;
    } catch {}
    return { record: rec, stored: true };
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
// Archive LARGE HTML document content to disk (same idea as the PDF-template
// blobs) so server-data.json stays small. Re-injected transparently on read.
// Small docs (< threshold) stay inline; any stale archive is removed on update.
const HTML_DOC_MAX_INLINE = 60000;
function htmlContentPath(key) { return path.join(DOC_STORE_DIR, 'cert-html-' + docSafeKey(key) + '.html'); }
function archiveHtmlContent(cert) {
    if (!cert || typeof cert.content !== 'string') return cert;
    const c = String(cert.content).trim();
    if (/^JVBERi0/.test(c) || /^%PDF-/.test(c)) return cert; // PDFs handled by externalizeCertificate
    const key = docSafeKey(cert.id || cert.docId || cert.vCode || 'doc');
    const file = htmlContentPath(key);
    const out = Object.assign({}, cert);
    if (c.length > HTML_DOC_MAX_INLINE) {
        try {
            ensureDocStore();
            fs.writeFileSync(file, cert.content);
            try { syncDocFileToVolume('cert-html-' + key + '.html'); } catch {}
            out.contentArchived = key;
            delete out.content;
            return out;
        } catch (e) { console.error('archiveHtmlContent failed:', key, e); return cert; }
    }
    if (cert.contentArchived || fs.existsSync(file)) {
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
        delete out.contentArchived;
    }
    return out;
}
// Transparency for archived docs: if a record was parked on disk, refill its
// `content` from the archive so every client viewer works unchanged.
function maybeReinjectArchived(rec) {
    if (!rec || !rec.contentArchived) return rec;
    if (typeof rec.content === 'string' && rec.content) return rec;
    const file = htmlContentPath(rec.contentArchived);
    try {
        if (fs.existsSync(file)) {
            const out = Object.assign({}, rec);
            out.content = fs.readFileSync(file, 'utf8');
            return out;
        }
    } catch (e) { console.error('reinject html failed:', rec.id, e); }
    return rec;
}
// Lazily externalize the inline PDF of every certificate/idCard record on read,
// so legacy records get a disk copy + contentPath without a full migration job.
// Returns records safe to serialize back to the client. Triggers a saveDB only
// when at least one record was actually updated in the DB.
// Country-aware branding overlay: for a coordinator scoped to a country (or an
// admin previewing a country), the branding record they read must reflect the
// identity of THAT country — brandName, initials, contact phone and postal address.
// The global branding record always remains the base (logos, terms, theme), and
// only the country's own identity fields override it. This makes every document,
// receipt, transcript and ID card generated by a country coordinator read as that
// country's institution, with the coordinator/contact phone on the document.
function applyCountryBranding(user, rec) {
    try {
        if (!rec) return rec;
        const scope = countryScopeOf(user);
        if (!scope) return rec;
        const countriesSetting = (db.settings || []).find(s => s.key === 'countries');
        const countries = countriesSetting ? (countriesSetting.value || countriesSetting) : [];
        const entry = (Array.isArray(countries) ? countries : []).find(c => c && c.name === scope);
        if (!entry) return rec;
        const out = Object.assign({}, rec);
        const globalInitials = (rec && rec.initials) || '';
        if (entry.postalAddress) out.postalAddress = String(entry.postalAddress);
        if (entry.phone) out.phone = String(entry.phone);
        if (entry.brandName) out.schoolName = String(entry.brandName);
        if (entry.initials) out.initials = String(entry.initials);
        out.country = scope;
        out.countryIsOverlay = true;
        // instituteCode is ALWAYS the global Net Foundation initials (e.g. "NF"),
        // regardless of the country's own brand initials (Togo="TG", Uganda="UG").
        // Admission numbers use this global code as their first segment while the
        // country identity lives in the study-center code (e.g. "UNSC").
        out.instituteCode = globalInitials || out.initials || 'NF';
        return out;
    } catch (e) { console.error('applyCountryBranding failed:', e); return rec; }
}

function externalizeStoreRecords(store, rows) {
    if (store !== 'certificates' && store !== 'idCards' && store !== 'idcards') return rows;
    let changed = false;
    const out = [];
    for (const r of rows) {
        if (!r || !r.content) { out.push(maybeReinjectArchived(maybeStripInline(r))); continue; }
        const res = externalizeCertificate(r);
        const gainedPath = !!res.record.contentPath && res.record.contentPath !== r.contentPath;
        if (gainedPath) {
            const idx = db[store].findIndex(x => x === r);
            if (idx >= 0) { db[store][idx] = res.record; changed = true; }
        }
        out.push(maybeReinjectArchived(maybeStripInline(res.record)));
    }
    if (changed) { try { broadcastEvent('db-change', { store }); saveDB(); } catch (e) { console.error('externalizeStoreRecords save failed:', e); } }
    return out;
}
// Heavy settings blobs (PDF templates) live on disk, NOT in server-data.json.
// Transparent to clients: PUT strips template->disk, GET re-injects it.
const SETTINGS_BLOBS = { diplomaPdfConfig: 'template', completionPdfConfig: 'template' };
function settingsBlobPath(key) { return path.join(DOC_STORE_DIR, 'settings-' + docSafeKey(key) + '-template.pdf'); }
function externalizeSettingsRecord(rec) {
    if (!rec || !SETTINGS_BLOBS[rec.key]) return null;
    const field = SETTINGS_BLOBS[rec.key];
    const holder = rec.value && typeof rec.value === 'object' ? rec.value : rec;
    const tpl = holder ? holder[field] : null;
    if (typeof tpl === 'string' && tpl.length > 1000) {
        let buf;
        try { buf = Buffer.from(tpl, 'base64'); } catch (e) { return 'Invalid PDF template encoding. Please re-upload the template.'; }
        if (buf.length < 8 || buf.slice(0, 5).toString('ascii') !== '%PDF-') {
            return 'Uploaded file is not a valid PDF. Please save a real PDF template (e.g. export from Word/Canva) and upload that.';
        }
        try {
            ensureDocStore();
            fs.writeFileSync(settingsBlobPath(rec.key), buf);
            // Keep base64 in DB as persistent source of truth (disk is
            // ephemeral on Railway). Previously we nulled the field and
            // relied solely on disk - a restart wiped the template and
            // `loadGeneratorTemplateBytes` fell through to the "upload
            // template" toast even though the user had saved. We now keep
            // the value so `config.template` remains usable after restarts.
            return null;
        } catch (e) { console.error('externalizeSettingsRecord failed:', rec.key, e); return 'Could not write the PDF template to disk: ' + (e.message || e); }
    } else if (!tpl) {
        try { if (fs.existsSync(settingsBlobPath(rec.key))) fs.unlinkSync(settingsBlobPath(rec.key)); } catch {}
    }
    return null;
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
// One-time (idempotent) migration: move legacy inline PDF bytes to disk +
// volume, then strip them from server-data.json. Only strips when the volume
// copy is confirmed, so data is never at risk. Shrinks the DB for real.
function stripStoredInlineBlobs() {
    try {
        if (!volumeAvailable()) return 0; // local dev: keep inline copies
        let stripped = 0;
        for (const store of ['certificates', 'idCards', 'idcards']) {
            const rows = db[store];
            if (!Array.isArray(rows)) continue;
            for (const r of rows) {
                if (!r || typeof r.content !== 'string') continue;
                const c = r.content.trim();
                if (!(/^JVBERi0/.test(c) || /^%PDF-/.test(c))) continue;
                const key = r.id || r.docId || r.vCode;
                if (!key) continue;
                try {
                    ensureDocStore();
                    const file = docPath(key);
                    if (!fs.existsSync(file)) {
                        const b64 = c.startsWith('data:') ? (c.split(',')[1] || '') : c;
                        if (!b64) continue;
                        fs.writeFileSync(file, Buffer.from(b64, 'base64'));
                    }
                    r.contentPath = '/api/doc-content/' + encodeURIComponent(key);
                    if (syncDocFileToVolume(docSafeKey(key) + '.pdf')) { delete r.content; stripped++; }
                } catch (e) { console.error('stripStoredInlineBlobs failed:', key, e.message); }
            }
        }
        if (stripped) saveDB();
        return stripped;
    } catch (e) { console.error('stripStoredInlineBlobs failed:', e.message); return 0; }
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
function certVerifyCode() {
    return 'V-' + Math.random().toString(36).substr(2, 4).toUpperCase() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
}
const DOC_IDENTITY_STORES = new Set(['certificates', 'idCards', 'idcards']);
// Document ID + Verification Code are the IMMUTABLE identity of an issued
// document. Once a record exists, its docId/vCode can never change and can
// never be dropped by an update, reprint, upgrade or legacy payload. New
// records that somehow arrive without identifiers get them minted at WRITE
// time (never left to be invented later on a read), so every stored document
// permanently verifies against what was printed on it.
function preserveDocIdentity(store, incoming, existing) {
    if (!DOC_IDENTITY_STORES.has(store) || !incoming || typeof incoming !== 'object') return incoming;
    if (existing) {
        if (existing.docId) incoming.docId = String(existing.docId);
        if (existing.vCode) incoming.vCode = String(existing.vCode);
    }
    if (!incoming.docId) incoming.docId = certDocId(incoming);
    if (!incoming.vCode) incoming.vCode = certVerifyCode();
    return incoming;
}

// SSE clients for real-time updates
const sseClients = [];
// Diagnostic stamp: event name + how many clients it was delivered to. Lets us
// prove whether a broadcast reached anyone instead of guessing from the browser.
let __lastBroadcast = null;
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

// ---- Crash-safe data layer with auto-backup -------------------------------
// The database lives as ONE FILE PER STORE under db-stores/, with append-only
// JSON Lines archives for the log stores. It used to be a single 33 MB
// server-data.json that was re-serialised, rewritten, copied to the volume and
// copied AGAIN as a backup on every save: roughly 600 ms of blocked event
// loop and ~100 MB of I/O per change. That is what makes a busy exam hall
// crawl. Per-store files mean a change rewrites only the store that changed,
// so a submitted paper costs a few kilobytes instead of megabytes.
//
// DB_STORAGE=single restores the old single-file behaviour (kill switch).
const DB_FILE = path.join(DATA_ROOT, 'server-data.json');
const DB_VOLUME_PATH = '/data/server-data.json'; // Railway volume path
const DB_TEMP = DB_FILE + '.tmp';
const DB_BACKUP = path.join(DATA_ROOT, 'server-data.backup.json');
const DB_BACKUP_DIR = path.join(DATA_ROOT, 'server-data-backups');
const MAX_BACKUPS = 20;

// ---- Per-store persistence -------------------------------------------------
const STORE_DIR = path.join(DATA_ROOT, 'db-stores');
const VOLUME_STORE_DIR = '/data/db-stores';
const LOG_DIR = path.join(DATA_ROOT, 'db-logs');
const VOLUME_LOG_DIR = '/data/db-logs';
const DB_STORAGE_MODE = String(process.env.DB_STORAGE || 'files').toLowerCase() === 'single' ? 'single' : 'files';
// A log store only ever grows and is read as a "recent window". The window is
// kept in the store file; everything that rolls out of it is kept FOREVER in
// an append-only archive, so the audit trail is never truncated by a restart.
const LOG_STORES = {
    audit:           { window: 1000, archive: 'audit' },
    alerts:          { window: 1000, archive: 'alerts' },
    whatsappLog:     { window: 500,  archive: 'whatsapp-log' },
    analyticsEvents: { window: 500,  archive: 'analytics-events' },
    smsLog:          { window: 500,  archive: 'sms-log' }
};
// Runtime-only keys are rebuilt on boot and must never reach the disk.
const RUNTIME_DB_KEYS = ['__countryIndex'];

function ensureDir(dir) {
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
}
function ensureBackupDir() { ensureDir(DB_BACKUP_DIR); }

function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// Atomic write: write to temp file, then rename (atomic on same filesystem).
function atomicWriteFile(file, content) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    for (let retries = 0; retries < 15; retries++) {
        try { fs.renameSync(tmp, file); return true; }
        catch (e) {
            if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
            if (retries < 14) { const start = Date.now(); while (Date.now() - start < 200) { /* spin */ } }
        }
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    console.error('atomicWriteFile: rename failed after 15 retries: ' + file);
    return false;
}

// Always mirror the live data back to the Railway volume so it never goes stale.
const _volumeMirrorWarned = {};
function mirrorFileToVolume(file, volumeDir) {
    try {
        ensureDir(volumeDir);
        fs.copyFileSync(file, path.join(volumeDir, path.basename(file)));
    } catch (e) {
        // A missing/unwritable volume must not be noisy: warn once per
        // directory, then carry on writing to the local copy.
        if (!_volumeMirrorWarned[volumeDir]) {
            _volumeMirrorWarned[volumeDir] = true;
            process.stderr.write('DB_VOLUME_SYNC_FAILED: ' + e.message + '\n');
        }
    }
}
function syncToVolume() {
    try {
        if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_VOLUME_PATH);
    } catch (e) { process.stderr.write('DB_VOLUME_SYNC_FAILED: ' + e.message + '\n'); }
}

// ---- Store files -----------------------------------------------------------
// The store name is encoded so it survives the filesystem untouched and can
// always be read back exactly as it was written.
function storeFileName(store) { return encodeURIComponent(String(store)) + '.json'; }
function storeNameFromFile(file) {
    const raw = file.replace(/\.json$/, '');
    try { return decodeURIComponent(raw); } catch { return raw; }
}
function storeFilePath(store) { return path.join(STORE_DIR, storeFileName(store)); }
function isLogStore(store) { return Object.prototype.hasOwnProperty.call(LOG_STORES, store); }

// Write ONE store to its own file and mirror it to the volume.
function writeStoreFile(store, value) {
    if (DB_STORAGE_MODE !== 'files') return false;
    try {
        ensureDir(STORE_DIR);
        const file = storeFilePath(store);
        const ok = atomicWriteFile(file, JSON.stringify(value));
        if (ok) mirrorFileToVolume(file, VOLUME_STORE_DIR);
        return ok;
    } catch (e) { console.error('writeStoreFile failed (' + store + '): ' + e.message); return false; }
}

// ---- Append-only archive for the log stores --------------------------------
// The archive is the durable home of the entries that rolled out of the
// recent window. It is only ever appended to, never rewritten, and it is split
// into ordered segments so the history always reads oldest -> newest.
const MAX_LOG_SEGMENT_BYTES = 8 * 1024 * 1024;
function logArchiveDir(store) { return path.join(LOG_DIR, LOG_STORES[store].archive); }
function logArchiveSegments(store) {
    try {
        return fs.readdirSync(logArchiveDir(store)).filter(f => f.endsWith('.jsonl')).sort();
    } catch { return []; }
}
function appendLogArchive(store, records) {
    if (DB_STORAGE_MODE !== 'files' || !records || !records.length) return;
    try {
        const dir = logArchiveDir(store);
        ensureDir(dir);
        const segs = logArchiveSegments(store);
        let name = segs.length ? segs[segs.length - 1] : '0001.jsonl';
        // Start a new segment when the current one has grown large, so a
        // segment is never rewritten and the order is never disturbed.
        try {
            if (segs.length && fs.statSync(path.join(dir, name)).size > MAX_LOG_SEGMENT_BYTES) {
                name = String(segs.length + 1).padStart(4, '0') + '.jsonl';
            }
        } catch {}
        const target = path.join(dir, name);
        fs.appendFileSync(target, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        mirrorFileToVolume(target, path.join(VOLUME_LOG_DIR, LOG_STORES[store].archive));
    } catch (e) { console.error('log archive append failed (' + store + '): ' + e.message); }
}
// A deleted record is recorded as a tombstone so it cannot come back when the
// archive is replayed at boot.
function tombstoneLogArchive(store, record) {
    if (DB_STORAGE_MODE !== 'files' || !record) return;
    try { appendLogArchive(store, [{ __tombstone: true, id: record.id || null, at: Date.now() }]); }
    catch (e) { /* keep going - the record is still gone from the window */ }
}
// Remove every archived entry of a log store (an explicit instruction).
function clearLogArchive(store) {
    if (DB_STORAGE_MODE !== 'files') return;
    try {
        const dir = logArchiveDir(store);
        for (const f of logArchiveSegments(store)) {
            try { fs.unlinkSync(path.join(dir, f)); } catch {}
            try { fs.unlinkSync(path.join(VOLUME_LOG_DIR, LOG_STORES[store].archive, f)); } catch {}
        }
    } catch {}
}
// The newest `want` entries of a log archive, with tombstoned ids removed.
function readLogArchiveTail(store, want) {
    const dir = logArchiveDir(store);
    const entries = [];
    const dead = new Set();
    for (const seg of logArchiveSegments(store)) {
        let raw = '';
        try { raw = fs.readFileSync(path.join(dir, seg), 'utf8'); } catch { continue; }
        for (const line of raw.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            let rec = null;
            try { rec = JSON.parse(t); } catch { continue; }
            if (!rec || typeof rec !== 'object') continue;
            if (rec.__tombstone) { if (rec.id) dead.add(String(rec.id)); continue; }
            entries.push(rec);
        }
    }
    const alive = entries.filter(r => !(r && r.id && dead.has(String(r.id))));
    return want > 0 ? alive.slice(Math.max(0, alive.length - want)) : alive;
}

// ---- Dirty-store tracking --------------------------------------------------
// Every write to a store is tracked automatically, so a save can never miss a
// change and can never rewrite a store that did not change.
const _dirtyStores = new Set();
function markStoreDirty(store) {
    const s = String(store || '');
    if (!s || RUNTIME_DB_KEYS.indexOf(s) >= 0) return;
    _dirtyStores.add(s);
}
// A record can also be edited in place (rec.field = x) without replacing the
// array element, so the records themselves are tracked too. The proxies are
// created lazily - only for the records that are actually read.
const _recordProxyCache = new WeakMap();   // raw record -> proxy
const _recordRaw = new WeakMap();          // proxy -> raw record
function wrapRecord(rec, store) {
    if (!rec || typeof rec !== 'object') return rec;
    if (_recordRaw.has(rec)) return rec;                 // already a proxy
    const cached = _recordProxyCache.get(rec);
    if (cached) return cached;
    const proxy = new Proxy(rec, {
        set(t, k, v) { markStoreDirty(store); t[k] = v; return true; },
        deleteProperty(t, k) { markStoreDirty(store); delete t[k]; return true; }
    });
    _recordProxyCache.set(rec, proxy);
    _recordRaw.set(proxy, rec);
    return proxy;
}
function wrapStoreValue(store, value) {
    if (!Array.isArray(value)) return value;
    return new Proxy(value, {
        get(target, prop) {
            const v = Reflect.get(target, prop);
            // Element access hands out the tracked record.
            if (typeof prop === 'string' && /^(0|[1-9][0-9]*)$/.test(prop)) return wrapRecord(v, store);
            return v;
        },
        set(target, prop, val) {
            markStoreDirty(store);
            // Keep the raw record in the array so it is never wrapped twice.
            const raw = (val && typeof val === 'object' && _recordRaw.has(val)) ? _recordRaw.get(val) : val;
            return Reflect.set(target, prop, raw);
        },
        deleteProperty(target, prop) { markStoreDirty(store); return Reflect.deleteProperty(target, prop); }
    });
}
function wrapDBObject(raw) {
    const target = {};
    if (raw && typeof raw === 'object') {
        Object.keys(raw).forEach(k => { target[k] = wrapStoreValue(k, raw[k]); });
    }
    return new Proxy(target, {
        set(t, k, v) { markStoreDirty(k); t[k] = wrapStoreValue(k, v); return true; },
        deleteProperty(t, k) { markStoreDirty(k); delete t[k]; return true; }
    });
}

// The database as it should be written to disk (runtime caches removed).
function persistableDB() {
    const out = {};
    for (const k of Object.keys(db)) {
        if (RUNTIME_DB_KEYS.indexOf(k) >= 0) continue;
        out[k] = db[k];
    }
    return out;
}

// Keep only the most recent entries of a log store in memory; the rest is
// moved into the append-only archive.
function trimLogStore(store) {
    const cfg = LOG_STORES[store];
    if (!cfg) return;
    const rows = db[store];
    if (!Array.isArray(rows) || rows.length <= cfg.window) return;
    const overflow = rows.slice(0, rows.length - cfg.window);
    db[store] = rows.slice(rows.length - cfg.window);
    appendLogArchive(store, overflow);
}

// ---- Backups ----------------------------------------------------------------
// A full backup used to be written on every save (another 33 MB). It is now
// written on a timer and on shutdown, which is what a backup is for.
const FULL_BACKUP_INTERVAL_MS = 15 * 60 * 1000;
let _lastFullBackup = 0;
function pruneBackups() {
    try {
        const files = fs.readdirSync(DB_BACKUP_DIR)
            .filter(f => f.startsWith('server-data.') && f.endsWith('.json'))
            .sort().reverse();
        if (files.length > MAX_BACKUPS) {
            files.slice(MAX_BACKUPS).forEach(f => {
                try { fs.unlinkSync(path.join(DB_BACKUP_DIR, f)); } catch {}
            });
        }
    } catch {}
}
// The backup is assembled from the store files instead of from one huge
// in-memory string, so building it never blocks the event loop. It is written
// as a stream, so even a very large database never needs a second copy in
// memory.
function listStoreEntries() {
    const entries = [];
    let files = [];
    try { files = fs.readdirSync(STORE_DIR).filter(f => f.endsWith('.json')).sort(); } catch {}
    for (const f of files) {
        const name = storeNameFromFile(f);
        if (RUNTIME_DB_KEYS.indexOf(name) >= 0) continue;
        entries.push([name, path.join(STORE_DIR, f)]);
    }
    return entries;
}
function writeChunk(stream, chunk) {
    return new Promise((resolve, reject) => {
        const onError = err => { stream.off('drain', onDrain); reject(err); };
        const onDrain = () => { stream.off('error', onError); resolve(); };
        stream.once('error', onError);
        if (stream.write(chunk)) { stream.off('error', onError); resolve(); }
        else stream.once('drain', onDrain);
    });
}
async function writeFullBackup() {
    let out = null;
    try {
        ensureBackupDir();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(DB_BACKUP_DIR, 'server-data.' + stamp + '.json');
        const tmpPath = backupPath + '.tmp';
        out = fs.createWriteStream(tmpPath, { encoding: 'utf8' });
        await writeChunk(out, '{');
        let first = true;
        for (const [name, file] of listStoreEntries()) {
            let content = '';
            try { content = await fs.promises.readFile(file, 'utf8'); } catch { continue; }
            await writeChunk(out, (first ? '' : ',') + JSON.stringify(name) + ':' + content);
            first = false;
        }
        await writeChunk(out, '}');
        await new Promise((resolve, reject) => {
            out.once('error', reject);
            out.end(err => (err ? reject(err) : resolve()));
        });
        out = null;
        try { fs.renameSync(tmpPath, backupPath); } catch { /* keep the tmp copy */ }
        // The single "latest good" copy the boot fallback reads.
        await fs.promises.copyFile(backupPath, DB_BACKUP);
        pruneBackups();
    } catch (e) {
        console.error('full backup failed: ' + e.message);
        try { if (out) out.destroy(); } catch {}
    }
}
function scheduleFullBackup() {
    if (DB_STORAGE_MODE === 'single') return;   // single mode backs up on every save
    const now = Date.now();
    if (now - _lastFullBackup < FULL_BACKUP_INTERVAL_MS) return;
    _lastFullBackup = now;
    setTimeout(() => { try { writeFullBackup(); } catch (e) { /* logged inside */ } }, 1500);
}

// ---- Reading the store files ----------------------------------------------
// The Railway volume is the durable copy, so it wins - exactly as the old boot
// copied /data/server-data.json over the local file.
function prepareFileStorage() {
    ensureDir(STORE_DIR);
    ensureDir(LOG_DIR);
    try {
        if (fs.existsSync(VOLUME_STORE_DIR)) {
            for (const f of fs.readdirSync(VOLUME_STORE_DIR)) {
                if (!f.endsWith('.json')) continue;
                try { fs.copyFileSync(path.join(VOLUME_STORE_DIR, f), path.join(STORE_DIR, f)); } catch {}
            }
        }
    } catch {}
    try {
        if (fs.existsSync(VOLUME_LOG_DIR)) {
            for (const store of Object.keys(LOG_STORES)) {
                const archive = LOG_STORES[store].archive;
                const volDir = path.join(VOLUME_LOG_DIR, archive);
                if (!fs.existsSync(volDir)) continue;
                ensureDir(path.join(LOG_DIR, archive));
                for (const f of fs.readdirSync(volDir)) {
                    if (!f.endsWith('.jsonl')) continue;
                    try { fs.copyFileSync(path.join(volDir, f), path.join(LOG_DIR, archive, f)); } catch {}
                }
            }
        }
    } catch {}
}
function loadStoresFromDisk() {
    const out = {};
    let files = [];
    try { files = fs.readdirSync(STORE_DIR).filter(f => f.endsWith('.json')); } catch {}
    for (const f of files) {
        const data = readJSON(path.join(STORE_DIR, f));
        // A store may hold any JSON value (most hold a list, some a settings
        // object). Only an unreadable file is skipped.
        if (data === null || data === undefined) continue;
        const name = storeNameFromFile(f);
        // Runtime caches are rebuilt on boot and must never be read back.
        if (RUNTIME_DB_KEYS.indexOf(name) >= 0) continue;
        out[name] = data;
    }
    // A log store keeps its recent window in the store file; the older entries
    // live in the append-only archive and are NOT loaded back into memory -
    // the screens read the recent window, exactly as before.
    for (const store of Object.keys(LOG_STORES)) {
        if (!Object.prototype.hasOwnProperty.call(out, store)) {
            // No window file (fresh or recovered): take the newest entries from
            // the archive so the history is not lost.
            out[store] = readLogArchiveTail(store, LOG_STORES[store].window);
        }
    }
    return out;
}
// One-off: split the old single-file database into store files.
function migrateLegacyToStores(legacy) {
    const written = [];
    for (const store of Object.keys(legacy)) {
        if (RUNTIME_DB_KEYS.indexOf(store) >= 0) continue;
        const value = legacy[store];
        if (isLogStore(store)) {
            const cfg = LOG_STORES[store];
            const rows = Array.isArray(value) ? value : [];
            const overflow = rows.length > cfg.window ? rows.slice(0, rows.length - cfg.window) : [];
            const window = rows.length > cfg.window ? rows.slice(rows.length - cfg.window) : rows;
            if (overflow.length) appendLogArchive(store, overflow);
            writeStoreFile(store, window);
        } else {
            writeStoreFile(store, value);
        }
        written.push(store);
    }
    return written;
}

// Atomic write (legacy single-file mode): write to temp file, then rename.
function safeWriteJSON(data) {
    const json = JSON.stringify(data);
    try {
        // Write to temp file first
        fs.writeFileSync(DB_TEMP, json, 'utf8');
        // No verify re-read: it doubled every save's I/O (read + full re-parse
        // on the event loop) and serializer output needs no validation.
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
            pruneBackups();
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
// Strip runtime-only keys from a freshly loaded DB object. Always-on safety:
// if a previous process ever persisted db.__countryIndex (Maps flattened to {}),
// discard it so buildCountryIndex() rebuilds valid Maps instead of returning
// the stale corrupt object and throwing mid-request.
function purgeRuntimeCaches(obj) {
    if (obj && typeof obj === 'object') {
        try { delete obj.__countryIndex; } catch {}
    }
}
// The old single-file reader. It stays as the migration source and as the
// fallback chain for a database that has never been split.
function loadLegacyDB() {
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
    // Main file first, with retries: transient locks (AV scanners briefly hold
    // the file on Windows) are the most common cause of a first-read failure
    // on a healthy file. A flaky read must never trigger a fallback overwrite.
    for (let attempt = 0; attempt < 4; attempt++) {
        const main = readJSON(DB_FILE);
        if (main && typeof main === 'object' && !Array.isArray(main)) {
            if (attempt > 0) process.stderr.write('DB_MAIN_RECOVERED_AFTER_RETRY attempt=' + attempt + '\n');
            purgeRuntimeCaches(main);
            return main;
        }
        if (attempt < 3) { const s = Date.now(); while (Date.now() - s < 150) {} }
    }
    // Main is missing or unreadable after retries: walk the remaining fallbacks
    // (volume, backup, timestamped, seed). A fallback becomes the new main ONLY
    // if there is no main file to protect or it is genuinely newer — a stale
    // backup must never silently overwrite a newer main file. Otherwise boot
    // from it in memory and shout, preserving the file for forensics.
    for (const { file, label } of sources) {
        if (label === 'main') continue;
        const data = readJSON(file);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            console.log('DB loaded from fallback: ' + label);
            purgeRuntimeCaches(data);
            if (shouldAdoptFallback(DB_FILE, file, label)) {
                safeWriteJSON(data);
            } else {
                process.stderr.write('DB_FALLBACK_NOT_ADOPTED: kept existing main file; running from ' + label + ' in memory. INVESTIGATE before next restart.\n');
            }
            return data;
        }
    }
    console.error('All data sources corrupted! Starting with empty DB.');
    return { mpesaSettings: {}, mpesaTransactions: [] };
}

// The database is read from the store files. When they do not exist yet the
// old single file is migrated into them, once.
// One-off: split the old single-file database into store files. The legacy
// object is released as soon as the files are written, so the migration never
// needs two copies of the database in memory at the same time.
function migrateLegacyFileToStores() {
    let legacy = null;
    try {
        legacy = loadLegacyDB();
        if (!legacy || typeof legacy !== 'object') return 0;
        const written = migrateLegacyToStores(legacy);
        process.stderr.write('DB_MIGRATED_TO_STORE_FILES: ' + written.length + ' stores\n');
        // Keep the old file for forensics, but never read it again.
        try { if (fs.existsSync(DB_FILE)) fs.renameSync(DB_FILE, DB_FILE + '.pre-split'); } catch {}
        return written.length;
    } finally {
        legacy = null;   // let the garbage collector reclaim it before the read back
    }
}
function loadDB() {
    if (DB_STORAGE_MODE === 'files') {
        try {
            prepareFileStorage();
            // The database is only "present" when a store file exists. An
            // empty store directory means this is a first run and the old
            // single file has to be migrated.
            let storeFiles = [];
            try { storeFiles = fs.readdirSync(STORE_DIR).filter(f => f.endsWith('.json')); } catch {}
            if (storeFiles.length) {
                const stores = loadStoresFromDisk();
                if (Object.keys(stores).length) return stores;
            }
        } catch (e) {
            process.stderr.write('DB_STORE_LOAD_FAILED: ' + e.message + ' - falling back to the single-file database\n');
        }
        try {
            if (migrateLegacyFileToStores()) {
                const stores = loadStoresFromDisk();
                if (Object.keys(stores).length) return stores;
            }
        } catch (e) {
            process.stderr.write('DB_STORE_MIGRATION_FAILED: ' + e.message + ' - using the single-file database\n');
        }
        return loadLegacyDB() || { mpesaSettings: {}, mpesaTransactions: [] };
    }
    return loadLegacyDB() || { mpesaSettings: {}, mpesaTransactions: [] };
}
// Adopt a fallback as the new main file ONLY when it cannot destroy newer
// data: main missing, or fallback genuinely newer. Seed templates (empty by
// design) never overwrite an existing main file.
function shouldAdoptFallback(mainFile, fallbackFile, label) {
    try {
        if (!fs.existsSync(mainFile)) return true;
        if (label === 'seed') return false;
        const mainStat = fs.statSync(mainFile);
        const fbStat = fs.statSync(fallbackFile);
        return fbStat.mtimeMs > mainStat.mtimeMs;
    } catch { return false; }
}

// Copy database from volume before first load. In per-store mode the volume
// already holds the store files (prepareFileStorage copies them), so the
// single-file copy is only needed as the migration source.
try {
    if (DB_STORAGE_MODE === 'files') {
        prepareFileStorage();
        let hasStores = false;
        try { hasStores = fs.readdirSync(STORE_DIR).some(f => f.endsWith('.json')); } catch {}
        if (!hasStores && fs.existsSync(DB_VOLUME_PATH)) {
            fs.copyFileSync(DB_VOLUME_PATH, DB_FILE);
            process.stderr.write('DB_COPIED_FROM_VOLUME\n');
        }
    } else if (fs.existsSync(DB_VOLUME_PATH)) {
        fs.copyFileSync(DB_VOLUME_PATH, DB_FILE);
        process.stderr.write('DB_COPIED_FROM_VOLUME\n');
    }
} catch (e) { process.stderr.write('DB_VOLUME_COPY_FAILED: ' + e.message + '\n'); }
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
function broadcastEvent(event, data, filter) {
    // `filter(client)` decides who receives this payload. It exists so private
    // records (staff <-> student messages) are pushed ONLY to the people who own
    // them, instead of being broadcast to every signed-in browser.
    let delivered = 0;
    for (let i = sseClients.length - 1; i >= 0; i--) {
        const client = sseClients[i];
        if (client.res.writableEnded) { sseClients.splice(i, 1); continue; }
        let payload = data;
        if (filter) {
            let ok = false;
            try { ok = !!filter(client, data); } catch (e) { ok = false; }
            if (!ok) continue;
            if (typeof filter.payload === 'function') {
                try { payload = filter.payload(client, data); } catch (e) { continue; }
            }
        }
        try { client.res.write('event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n'); delivered++; } catch (e) {}
    }
    __lastBroadcast = { event: event, delivered: delivered, at: Date.now() };
}

// Push the changed row along with the event so the client can update its screen
// from what it already has, instead of refetching (one round-trip is ~700ms here).
function broadcastStoreChange(store, record, action) {
    const payload = { store: store, action: action || (record ? 'upsert' : 'change') };
    if (record) payload.record = record;
    broadcastEvent('db-change', payload);
}

// Private store: only the sender and the recipient receive the row itself.
function broadcastPrivateChange(store, record, usernames) {
    const allow = new Set((usernames || []).filter(Boolean).map(String));
    const filter = function (c) {
        const un = (c.user && c.user.username) || c.username || '';
        return allow.has(String(un));
    };
    filter.payload = function () { return { store: store, action: 'upsert', record: record }; };
    broadcastEvent('db-change', filter.payload(), filter);
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

// ---------------------------------------------------------------------------
// Static file allowlist
//
// The app directory is also the HTTP document root, so every file that ships
// with the deployment used to be downloadable by anyone: server.js, the live
// database (server-data.json), package.json, railway.json, the Dockerfile and
// so on. Nothing outside this allowlist is served any more - an unknown path
// is a 404, exactly as if the file did not exist.
// ---------------------------------------------------------------------------

// Top-level documents the browser may fetch.
const PUBLIC_HTML_FILES = new Set([
    '/index.html',
    '/maintenance.html',
    '/student-manual.html',
    '/coordinator-manual.html',
    '/admin-manual.html',
    '/assistant-admin-manual.html',
    '/staff-manual.html'
]);

// Asset directories whose contents are public. Only the listed file types are
// served from them.
const PUBLIC_ASSET_DIRS = [
    { prefix: '/css/', exts: ['.css'] },
    { prefix: '/js/', exts: ['.js'] },
    { prefix: '/manual-screenshots/', exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'] }
];

function isPublicStaticAsset(url) {
    if (!url) return false;
    // Normalise: no query string, no traversal, single leading slash.
    let p = String(url).split('?')[0].split('#')[0];
    try { p = decodeURIComponent(p); } catch { return false; }
    if (p.indexOf('..') !== -1) return false;
    if (p[0] !== '/') return false;
    if (PUBLIC_HTML_FILES.has(p)) return true;
    for (const dir of PUBLIC_ASSET_DIRS) {
        if (p.indexOf(dir.prefix) !== 0) continue;
        const rel = p.slice(dir.prefix.length);
        if (!rel || rel.indexOf('/') !== -1) continue; // no nested directories
        const ext = path.extname(rel).toLowerCase();
        if (dir.exts.indexOf(ext) !== -1) return true;
    }
    return false;
}

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

let db = wrapDBObject(loadDB());

// ---- Settings record cache -------------------------------------------------
// Authorisation reads the same handful of settings records on every API call
// (the admin tab switches, the assistant switches, the active grading scale).
// A linear scan of the store per check is wasted work, so those records are
// cached and the cache is dropped whenever the settings store is written.
const settingsRecordCache = new Map();
let _activeGradeScaleKey = null;
function settingRecord(key) {
    if (settingsRecordCache.has(key)) return settingsRecordCache.get(key);
    const rec = (db.settings || []).find(s => s && s.key === key) || null;
    settingsRecordCache.set(key, rec);
    return rec;
}
function settingValue(key) {
    const rec = settingRecord(key);
    return rec ? (rec.value !== undefined ? rec.value : rec) : null;
}
function invalidateSettingsCache() {
    settingsRecordCache.clear();
    _activeGradeScaleKey = null;
}

// ---- The owner (the author of the system) --------------------------------
// One account, created from the environment so that no credential is ever
// stored in the repository. The owner IS an admin, with two extra powers:
// deciding which tabs the overall admin may open, and running the owner-only
// security actions. Authorisation always sees the role 'admin', so no
// existing admin check has to change; the extra powers travel with isOwner.
function ownerUsername() {
    const env = String(process.env.OWNER_USERNAME || '').trim();
    if (env) return env;
    const rec = (db.settings || []).find(s => s.key === 'owner');
    const v = rec ? (rec.value || rec) : null;
    return v && v.username ? String(v.username) : '';
}
function isOwnerUser(user) {
    if (!user) return false;
    const u = user.user || user;
    if (u.role === 'owner' || u.isOwner) return true;
    const name = ownerUsername();
    return !!name && String(u.username || '').toLowerCase() === name.toLowerCase();
}
function asAuthorisedUser(u) {
    if (!u) return u;
    if (u.role === 'owner') return Object.assign({}, u, { role: 'admin', isOwner: true });
    return u;
}
function mustChangePassword(user) {
    if (!user) return false;
    const u = user.user || user;
    return !!u.mustChangePassword;
}

// Which tab owns which store. This is the app's own store->tab mapping (the
// one the assistant access control already used) plus the extra stores the
// overall admin's tabs own. The owner uses it to decide which tabs the admin
// may open: a tab that is switched off removes the WRITE access behind it on
// the server. Reads stay available so features that depend on them (the
// login screen, the grade scale, the transcript) keep working.
const STORE_TO_TAB = {
    students: 'students', courses: 'courses', lessons: 'lessons', attendance: 'attendance',
    grades: 'grades', exams: 'exams', manuals: 'manuals', staff: 'staff',
    payments: 'finance', income: 'finance', expenses: 'finance', fees: 'finance', invoices: 'finance',
    hostel: 'hostel', hostels: 'hostel', borrows: 'hostel',
    library: 'library', inventory: 'inventory', alumni: 'alumni',
    alumniEnrollments: 'alumni',
    certificates: 'certificates', events: 'events', whatsapp: 'whatsapp', whatsappTemplates: 'whatsapp', whatsappLog: 'whatsapp',
    audit: 'audit', idcards: 'idcards', idCards: 'idcards', questions: 'questions', quizzes: 'quizzes',
    submissions: 'submissions', notes: 'notes', portal: 'portal', pending: 'pending',
    tickets: 'tickets', progress: 'progress', settings: 'settings', verify: 'verify', reprint: 'reprint',
    discussions: 'discussions', regions: 'regions', communication: 'communication', messages: 'messages',
    sms: 'sms', smsLog: 'sms', smsSettings: 'sms', chapel: 'chapel', graduation: 'graduation',
    users: 'users', counters: 'counters', studyCenters: 'regions', studyCenter: 'regions'
};
// The admin's own tabs own a few stores the assistant's list does not cover.
const ADMIN_STORE_TO_TAB = Object.assign({}, STORE_TO_TAB, {
    media: 'media', mediaUploads: 'media', lessonFiles: 'media',
    books: 'library', library: 'library',
    meetings: 'meetings', meeting: 'meetings',
    examRegistrations: 'exams', quizRegistrations: 'quizzes',
    questionBank: 'questions', courseCompletions: 'certificates',
    analyticsEvents: 'analytics', notifications: 'messages',
    whatsappOutbox: 'whatsapp', whatsappRuns: 'whatsapp',
    smsTemplates: 'sms', transcriptVerifications: 'verify',
    lessonCompletions: 'progress', pendingRegistrations: 'pending',
    hostels: 'hostel', auditTrail: 'audit'
});
function adminTabBlocked(store) {
    const acc = settingValue('adminAccess');
    if (!acc || typeof acc !== 'object') return false;
    const tab = ADMIN_STORE_TO_TAB[store];
    if (tab && acc[tab] === false) return true;
    if (FINANCIAL_STORES.has(store) && acc['finance'] === false) return true;
    return false;
}

// The owner account is created once, from the environment.
function bootstrapOwner() {
    const uname = String(process.env.OWNER_USERNAME || '').trim();
    const upw = String(process.env.OWNER_BOOTSTRAP_PASSWORD || '');
    const disp = String(process.env.OWNER_DISPLAY_NAME || '').trim() || 'Owner';
    if (!uname || !upw) return;
    const users = db.users || (db.users = []);
    const owner = users.find(u => u.role === 'owner');
    if (owner) {
        // The owner already exists: the bootstrap password is only used when
        // that owner has no password yet.
        if (!owner.password && String(owner.username || '').toLowerCase() === uname.toLowerCase()) {
            owner.password = hashPassword(upw);
            saveDB();
            process.stderr.write('OWNER_BOOTSTRAP: first password set for ' + uname + '\n');
        }
        return;
    }
    const existing = users.find(u => String(u.username || '').toLowerCase() === uname.toLowerCase());
    if (existing) {
        existing.role = 'owner';
        existing.status = 'active';
        saveDB();
        process.stderr.write('OWNER_BOOTSTRAP: promoted "' + uname + '" to owner\n');
        return;
    }
    users.push({
        username: uname, password: hashPassword(upw), name: disp, role: 'owner',
        status: 'active', createdAt: new Date().toISOString()
    });
    saveDB();
    process.stderr.write('OWNER_BOOTSTRAP: created the owner account "' + uname + '". Remove OWNER_BOOTSTRAP_PASSWORD from the environment now.\n');
}

let _saveTimer = null;
function saveDB() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        _saveTimer = null;
        flushStores();
    }, 500);
}
function flushDB() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    flushStores();
}
// Write the stores that changed - and only those.
function flushStores() {
    if (DB_STORAGE_MODE === 'single') { safeWriteJSON(db); return; }
    const stores = Array.from(_dirtyStores);
    for (const store of stores) {
        if (RUNTIME_DB_KEYS.indexOf(store) >= 0) continue;
        if (isLogStore(store)) { try { trimLogStore(store); } catch (e) { console.error('trimLogStore failed: ' + e.message); } }
        writeStoreFile(store, db[store]);
    }
    // Cleared AFTER the writes so a change made during the flush is not lost.
    _dirtyStores.clear();
    scheduleFullBackup();
}
process.on('exit', flushDB);
// Railway (and every sane supervisor) stops a container with SIGTERM. Without
// this handler the last few hundred milliseconds of writes would be lost.
process.on('SIGTERM', () => { try { flushDB(); } catch {} process.exit(0); });
process.on('SIGINT', () => { flushDB(); process.exit(); });

// One-time boot stamp: every stored document record must already carry its
// immutable docId/vCode so a later read can never invent new identifiers and
// invalidate printed documents. Runs once on start (and only saves when some
// legacy record had to be fixed).
function stampDocIdentifiersAtBoot() {
    try {
        let changed = false;
        for (const store of docStoreNames()) {
            const rows = db[store];
            if (!Array.isArray(rows)) continue;
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                if (!r || typeof r !== 'object') continue;
                const before = JSON.stringify(r.docId || null) + '\u0000' + JSON.stringify(r.vCode || null);
                preserveDocIdentity(store, r, {
                    docId: r.docId || null,
                    vCode: r.vCode || null
                });
                const after = JSON.stringify(r.docId || null) + '\u0000' + JSON.stringify(r.vCode || null);
                if (before !== after) changed = true;
            }
        }
        if (changed) { try { flushDB(); } catch (e) { console.error('stampDocIdentifiersAtBoot save failed:', e); } }
    } catch (e) { console.error('stampDocIdentifiersAtBoot failed:', e.message); }
}
function docStoreNames() {
    return ['certificates', 'idCards', 'idcards'];
}
try { stampDocIdentifiersAtBoot(); } catch (e) { console.error('boot doc-id stamp failed:', e); }

// ---- Stored results follow the ACTIVE grading scale ----------------------
// A stored result keeps its score; the letter and the grade points are
// re-derived from that score under the scale the institution uses now. The
// run happens once at boot, it is idempotent (a second run finds nothing to
// change) and it is recorded in the audit trail. A mark that is not a plain
// letter (a competency mark such as "PASS") is left exactly as it is.
function normaliseStoredGradeScale() {
    try {
        const scale = activeGradeScaleServer();
        const changed = [];
        for (const g of (db.grades || [])) {
            if (!g || typeof g !== 'object') continue;
            const score = Number(g.score);
            if (!Number.isFinite(score) || score < 0 || score > 100) continue;
            const letter = String(g.grade == null ? '' : g.grade).trim();
            if (!/^[A-F][+-]?$/i.test(letter)) continue;   // not a scale letter
            const band = gradeBandForScore(score);
            if (letter === band.grade && Number(g.gpa) === band.gpa) continue;
            g.grade = band.grade;
            g.gpa = band.gpa;
            changed.push({ id: g.id, score: score, grade: band.grade });
        }
        if (!changed.length) return 0;
        auditLog('normalised', 'grades', { count: changed.length, scale: scale.label }, 'system');
        try { flushDB(); } catch (e) { console.error('grade normalisation save failed:', e); }
        process.stderr.write('GRADE_SCALE_NORMALISED: ' + changed.length + ' stored result(s) re-derived from the active scale\n');
        return changed.length;
    } catch (e) { console.error('normaliseStoredGradeScale failed:', e.message); return 0; }
}

// ---- CORS ------------------------------------------------------------------
// Only trusted origins may call the API from a browser. The live site is
// same-origin (browsers send no Origin header for it); the development app
// runs on http://localhost:8080. Extra origins can be added with the
// CORS_ALLOWED_ORIGINS environment variable (comma separated). A request from
// any other origin simply receives no CORS grant, so the browser blocks it.
const CORS_ALLOWED = String(process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:8080,http://127.0.0.1:8080')
    .split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean);
function allowedOrigin(req) {
    const origin = String((req && req.headers && req.headers.origin) || '').replace(/\/$/, '');
    if (!origin) return '';
    if (CORS_ALLOWED.includes(origin)) return origin;
    // The page may be served from the very host that is answering (behind a
    // proxy the scheme can differ), which is always same-origin as far as the
    // browser is concerned.
    try {
        const host = String((req.headers && req.headers.host) || '');
        if (host && new URL(origin).host === host) return origin;
    } catch {}
    return '';
}
function json(res, code, data) {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Cache-Control': 'no-store, max-age=0'
    };
    if (res && res.__corsOrigin) {
        headers['Access-Control-Allow-Origin'] = res.__corsOrigin;
        headers['Vary'] = 'Origin';
    }
    res.writeHead(code, headers);
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
    'invoices', 'installments', 'whatsappTemplates', 'whatsappLog', 'whatsappOutbox', 'whatsappRuns',
    'expenseCategories', 'gradRequirements', 'sessions', 'submissionResets', 'analyticsEvents'
]);

// Stores a student is allowed to write to (their own activity records)
const STUDENT_WRITE_STORES = new Set([
    'submissions', 'quizRegistrations', 'examRegistrations',
    'retakeRequests', 'seating', 'borrows', 'tickets', 'enrollments',
    'alumniEnrollments'
]);

// Stores with NO country identity by design — institution-wide shared content
// that every country coordinator legitimately needs in full: the unified
// curriculum/catalog (one academy runs the same courses/exams/quizzes in every
// country), reference lists, templates/manuals, communication content, and
// the settings keys coordinators may read (branding, academic). These stay
// visible to all countries. EVERY other store is strictly scoped: a record
// must resolve — via its own country, its student, its study center or its
// region — to exactly the viewer's country, or it is hidden (admin-only)
// until adopted into a country.
const GLOBAL_SHARED_STORES = new Set([
    // Curriculum / catalog
    'courses', 'lessons', 'lessonFiles', 'exams', 'quizzes', 'questionBank',
    'programs', 'feeStructure', 'gradRequirements', 'campuses',
    // Templates / manuals / logs
    // NOTE: whatsappLog / smsLog / messages are deliberately NOT here — message
    // logs are per-country. They used to be shared, which meant every
    // coordinator could read every other country's messaging history.
    'manuals', 'whatsappTemplates', 'smsTemplates',
    // Reference lists
    'expenseCategories', 'incomeCategories', 'deductionAccounts',
    // Staff payroll definitions and deliverables
    'salaryDeductions', 'payslips', 'deductionDisbursements',
    // Communication / assets
    'events', 'alerts', 'notes', 'meetings',
    'books', 'hostels', 'inventory',
    // Settings (read exemptions live at the route level; must flow unfiltered)
    'settings'
]);

// Extract the authenticated user from the request (server-verified).
// Legacy X-User-Id / X-User-Role headers are NO LONGER trusted — a caller must
// present a valid session token (Authorization: Bearer <token> or the `session`
// cookie) that was issued at login. Admins carrying a valid maintenance-bypass
// cookie are also accepted (that cookie is itself server-verified).
function getRequestUser(req) {
    const sessionUser = getSessionUser(req);
    if (sessionUser) {
        const u = asAuthorisedUser(sessionUser);
        return { role: u.role, username: u.username, user: u, isOwner: !!u.isOwner };
    }
    if (hasMaintenanceBypass(req)) {
        const token = parseCookies(req).mt_bypass;
        const entry = token && maintenanceBypassTokens.get(token);
        const user = entry && (db.users || []).find(u => u.username === entry.username);
        if (user) {
            const u = asAuthorisedUser(user);
            return { role: u.role, username: u.username, user: u, isOwner: !!u.isOwner };
        }
    }
    return null;
}

// Country-scoped administrator: a coordinator bound to a country (and NOT to a
// region — regional coordinators keep their existing narrower behavior).
// Returns the country name, or null. Role from the session, scope from the record.
function countryScopeOf(user) {
    if (!user || !user.user) return null;
    if (user.role !== 'coordinator') return null;
    const rec = user.user;
    if (!rec.country || rec.regionId) return null;
    return rec.country;
}

// Per-country Generate Diploma / Generate Completion toggles. Stored in the
// settings key `documentGenFlags` as a value object shaped like:
//   { diploma: { KENYA: true, TOGO: false }, completion: { KENYA: true, TOGO: true } }
// A type is ON for a country unless the flags record explicitly sets it to
// false for that country. Only country-scoped coordinators are ever gated —
// admins, assistants, regional coordinators and other staff keep full access.
const DOC_GEN_TYPES = ['diploma', 'completion'];
function docGenFlagsRecord() {
    const rec = (db.settings || []).find(s => s && s.key === 'documentGenFlags');
    return rec ? ((rec.value && typeof rec.value === 'object') ? rec.value : rec) : null;
}
function docTypeEnabledFor(user, type) {
    if (!user) return true;
    if (user.role === 'admin') return true;
    const country = countryScopeOf(user);
    if (!country) return true;
    const flags = docGenFlagsRecord();
    const perCountry = flags && flags[type] && typeof flags[type] === 'object' ? flags[type] : {};
    return perCountry[country] !== false;
}

// -------- Derived country resolution --------
// Legacy/global records (payments, income, expenses, installments, fee
// agreements, waivers, alumni, students) frequently carry NO explicit country
// field — records created before country tagging or never refreshed. Their
// true country is resolved through their linked student, and a student's
// country through its study center and that center's region. Only the overall
// admin sees truly unresolvable/global rows.
//
// The resolution chain is fully generic: any record resolves via its explicit
// `country`, its `studentId`/`studentPhone`/`phone`, its `studyCenterId`, or
// its `regionId`. There is NO "untagged = visible to every country" fallback
// anymore — a row that resolves to no country is visible to the overall admin
// only, until it is explicitly adopted into a country.
let _countryIndexCache = null;
function buildCountryIndex() {
    // Never persist the index into server-data.json: it holds Maps/sets that
    // JSON.stringify flattens to {}, and once such a corrupt object is cached
    // back into the in-memory DB every recordCountryOf() throws mid-request
    // (idx.byStudentId.has is not a function) — the response is never sent and
    // the client hangs until timeout. The cache lives OUTSIDE db entirely.
    if (_countryIndexCache && _countryIndexCache.byStudentId instanceof Map && _countryIndexCache.byPhone instanceof Map) {
        return _countryIndexCache;
    }
    _countryIndexCache = null;
    const regionCountry = {};
    (db.regions || []).forEach(r => { if (r && r.id) regionCountry[r.id] = r.country || ''; });
    const centerCountry = {};
    (db.studyCenters || []).forEach(c => {
        if (!c) return;
        centerCountry[c.id] = c.country || ((c.regionId && regionCountry[c.regionId]) || '');
    });
    const byStudentId = new Map();
    const byPhone = new Map();
    (db.students || []).forEach(s => {
        if (!s || !s.id) return;
        const c = s.country || ((s.studyCenterId && centerCountry[s.studyCenterId]) || '');
        byStudentId.set(String(s.id), c);
        if (s.phone) byPhone.set(String(s.phone), c);
        if (s.admissionNumber) byStudentId.set(String(s.admissionNumber), c);
        if (s.email) byPhone.set(String(s.email), c);
    });
    // Alumni too: a certificate issued before graduation references a student who
    // has since left db.students, and without this it resolves to no country and
    // is hidden from every coordinator (and appears "not found" in-app).
    (db.alumni || []).forEach(s => {
        if (!s || !s.id) return;
        if (byStudentId.has(String(s.id))) return;
        const c = s.country || ((s.studyCenterId && centerCountry[s.studyCenterId]) || '');
        byStudentId.set(String(s.id), c);
        if (s.phone) byPhone.set(String(s.phone), c);
        if (s.admissionNumber) byStudentId.set(String(s.admissionNumber), c);
        if (s.email) byPhone.set(String(s.email), c);
    });
    _countryIndexCache = { regionCountry, centerCountry, byStudentId, byPhone };
    return _countryIndexCache;
}
function invalidateCountryIndex() { _countryIndexCache = null; }
function recordCountryOf(store, rec) {
    if (!rec) return '';
    if (rec.country) return String(rec.country);
    const idx = buildCountryIndex();
    if (store === 'students') {
        return rec.country || (idx.centerCountry[rec.studyCenterId] || '');
    }
    if (store === 'studyCenters') {
        return rec.country || (rec.regionId && idx.regionCountry[rec.regionId]) || '';
    }
    if (store === 'staff') {
        if (rec && rec._user && rec._user.country) return String(rec._user.country);
        if (rec && rec.userId) {
            const u = (db.users || []).find(x => x && String(x.username) === String(rec.userId)) || (db.users || []).find(x => x && String(x.id) === String(rec.userId));
            if (u && u.country) return String(u.country);
        }
        if (rec && rec.loginUsername) {
            const u2 = (db.users || []).find(x => x && String(x.username) === String(rec.loginUsername));
            if (u2 && u2.country) return String(u2.country);
        }
        if (rec && rec.phone) {
            const u3 = (db.users || []).find(x => x && String(x.username) === String(rec.phone));
            if (u3 && u3.country) return String(u3.country);
        }
        if (rec && rec.studyCenterId && idx.centerCountry[rec.studyCenterId]) return idx.centerCountry[rec.studyCenterId];
        return '';
    }
    if (store === 'regions') return rec.country || '';
    // Generic chain: student-linked records (finance, attendance, grades,
    // enrollments, tickets, seating, borrows, mpesa...) then center/region.
    const sid = rec.studentId != null ? String(rec.studentId) : '';
    if (sid && idx.byStudentId.has(sid)) return idx.byStudentId.get(sid);
    // webhook/payment records that only carry the payer's phone
    const ph = rec.studentPhone || rec.phone || '';
    if (ph && idx.byPhone.has(String(ph))) return idx.byPhone.get(String(ph));
    if (sid && idx.byPhone.has(sid)) return idx.byPhone.get(sid);
    if (rec.studyCenterId && idx.centerCountry[rec.studyCenterId]) return idx.centerCountry[rec.studyCenterId];
    if (rec.regionId && idx.regionCountry[rec.regionId]) return idx.regionCountry[rec.regionId];
    return '';
}
// ---- Lesson pacing configuration/scoping --------------------------------
// Pace overrides live under the `lessonPacing` settings record. Coordinators
// cannot write global settings, so they use the dedicated /api/lesson-pacing
// route, which enforces the same country/region fence as the Fee Gate.
function pacingSameCountry(a, b) {
    const x = String(a == null ? '' : a).trim();
    const y = String(b == null ? '' : b).trim();
    return !!x && !!y && x.toLowerCase() === y.toLowerCase();
}
function pacingConfiguredCountries() {
    const rec = (db.settings || []).find(s => s && s.key === 'countries');
    const raw = rec ? (rec.value || rec) : [];
    return (Array.isArray(raw) ? raw : [])
        .map(c => (typeof c === 'string' ? { name: c } : c))
        .filter(c => c && c.name)
        .map(c => ({ name: String(c.name), code: c.code || '', brandName: c.brandName || c.name }));
}
function pacingRoleOf(user) {
    if (!user) return null;
    if (user.role === 'admin') return 'admin';
    if (user.role !== 'coordinator' || !user.user) return null;
    if (countryScopeOf(user)) return 'country';
    if (user.user.regionId) return 'region';
    return null;
}
function pacingScopeInfo(user, role) {
    if (role === 'country') return { country: countryScopeOf(user) || '' };
    if (role === 'region') {
        const regionId = String((user && user.user && user.user.regionId) || '');
        const region = (db.regions || []).find(r => r && String(r.id) === regionId) || null;
        return { country: String((region && region.country) || ''), regionId: regionId };
    }
    return {};
}
function pacingRegionById(id) {
    return (db.regions || []).find(r => r && String(r.id) === String(id)) || null;
}
function pacingCenterById(id) {
    return (db.studyCenters || []).find(c => c && String(c.id) === String(id)) || null;
}
function pacingStudentById(id) {
    return (db.students || []).find(s => s && (String(s.id) === String(id) || String(s.admissionNumber || '') === String(id))) || null;
}
function pacingStudentRegionId(student) {
    if (!student) return '';
    const center = student.studyCenterId ? pacingCenterById(student.studyCenterId) : null;
    return String((center && center.regionId) || student.regionId || '');
}
function pacingCountryForCenter(center) {
    return center ? recordCountryOf('studyCenters', center) : '';
}
function pacingCountryForStudent(student) {
    return student ? recordCountryOf('students', student) : '';
}
function pacingCanonicalScope(scope, id) {
    const key = String(id == null ? '' : id).trim();
    if (!key) return null;
    if (scope === 'country') {
        const hit = pacingConfiguredCountries().find(c => pacingSameCountry(c.name, key));
        return { id: hit ? hit.name : key, rec: hit || { name: key } };
    }
    if (scope === 'region') {
        const rec = pacingRegionById(key);
        return rec ? { id: String(rec.id), rec: rec } : null;
    }
    if (scope === 'center') {
        const rec = pacingCenterById(key);
        return rec ? { id: String(rec.id), rec: rec } : null;
    }
    if (scope === 'student') {
        const rec = pacingStudentById(key);
        return rec ? { id: String(rec.id), rec: rec } : null;
    }
    return null;
}
function pacingCanEdit(user, role, scope, canonical) {
    if (role === 'admin') return true;
    if (!canonical) return false;
    if (role === 'country') {
        const country = countryScopeOf(user);
        if (!country) return false;
        if (scope === 'country') return pacingSameCountry(canonical.id, country) || pacingSameCountry(canonical.rec && canonical.rec.name, country);
        if (scope === 'region') return pacingSameCountry(canonical.rec && canonical.rec.country, country);
        if (scope === 'center') return pacingSameCountry(pacingCountryForCenter(canonical.rec), country);
        if (scope === 'student') return pacingSameCountry(pacingCountryForStudent(canonical.rec), country);
        return false;
    }
    if (role === 'region') {
        const rid = String((user && user.user && user.user.regionId) || '');
        if (!rid) return false;
        if (scope === 'region') return String(canonical.id) === rid;
        if (scope === 'center') return String((canonical.rec && canonical.rec.regionId) || '') === rid;
        if (scope === 'student') return pacingStudentRegionId(canonical.rec) === rid;
        return false;
    }
    return false;
}
function pacingFilterConfig(cfg, role, scopeInfo) {
    if (role === 'admin') return cfg;
    const out = { countries: {}, regions: {}, centers: {}, students: {} };
    const country = String((scopeInfo && scopeInfo.country) || '');
    const regionId = String((scopeInfo && scopeInfo.regionId) || '');
    Object.keys(cfg.countries || {}).forEach(id => {
        if (pacingSameCountry(id, country)) out.countries[id] = cfg.countries[id];
    });
    Object.keys(cfg.regions || {}).forEach(id => {
        const rec = pacingRegionById(id);
        if (role === 'region' ? String(id) === regionId : pacingSameCountry(rec && rec.country, country)) out.regions[id] = cfg.regions[id];
    });
    Object.keys(cfg.centers || {}).forEach(id => {
        const rec = pacingCenterById(id);
        if (role === 'region' ? String((rec && rec.regionId) || '') === regionId : pacingSameCountry(pacingCountryForCenter(rec), country)) out.centers[id] = cfg.centers[id];
    });
    Object.keys(cfg.students || {}).forEach(id => {
        const rec = pacingStudentById(id);
        if (role === 'region' ? pacingStudentRegionId(rec) === regionId : pacingSameCountry(pacingCountryForStudent(rec), country)) out.students[id] = cfg.students[id];
    });
    return out;
}
function pacingOptionsFor(role, scopeInfo) {
    const configured = pacingConfiguredCountries();
    let regions = (db.regions || []).filter(Boolean);
    let centers = (db.studyCenters || []).filter(Boolean);
    let students = (db.students || []).filter(Boolean);
    if (role === 'country') {
        const country = String((scopeInfo && scopeInfo.country) || '');
        regions = regions.filter(r => pacingSameCountry(r.country, country));
        centers = centers.filter(c => pacingSameCountry(pacingCountryForCenter(c), country));
        students = students.filter(s => pacingSameCountry(pacingCountryForStudent(s), country));
    } else if (role === 'region') {
        const regionId = String((scopeInfo && scopeInfo.regionId) || '');
        regions = regions.filter(r => String(r.id) === regionId);
        centers = centers.filter(c => String((c && c.regionId) || '') === regionId);
        students = students.filter(s => pacingStudentRegionId(s) === regionId);
    }
    const countryMap = {};
    if (role === 'admin') {
        configured.forEach(c => { countryMap[String(c.name).toLowerCase()] = c; });
        regions.forEach(r => { if (r.country && !countryMap[String(r.country).toLowerCase()]) countryMap[String(r.country).toLowerCase()] = { name: String(r.country), code: '', brandName: String(r.country) }; });
        centers.forEach(c => { const n = pacingCountryForCenter(c); if (n && !countryMap[n.toLowerCase()]) countryMap[n.toLowerCase()] = { name: n, code: '', brandName: n }; });
        students.forEach(s => { const n = pacingCountryForStudent(s); if (n && !countryMap[n.toLowerCase()]) countryMap[n.toLowerCase()] = { name: n, code: '', brandName: n }; });
    } else {
        const name = String((scopeInfo && scopeInfo.country) || '');
        if (name) {
            const hit = configured.find(c => pacingSameCountry(c.name, name));
            countryMap[name.toLowerCase()] = hit || { name: name, code: '', brandName: name };
        }
    }
    return {
        countries: Object.keys(countryMap).map(k => countryMap[k]).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        regions: regions.map(r => ({ id: String(r.id), name: r.name || '', country: r.country || '' })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        centers: centers.map(c => ({ id: String(c.id), name: c.name || '', code: c.code || '', regionId: c.regionId || '', country: pacingCountryForCenter(c) })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        students: students.map(s => ({ id: String(s.id), name: s.name || s.fullName || '', admissionNumber: s.admissionNumber || '', studyCenterId: s.studyCenterId || '', regionId: pacingStudentRegionId(s), country: pacingCountryForStudent(s) })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    };
}
function pacingSaveConfig(cfg, user) {
    const clean = { countries: {}, regions: {}, centers: {}, students: {} };
    ['countries', 'regions', 'centers', 'students'].forEach(level => {
        const src = (cfg && cfg[level]) || {};
        Object.keys(src).forEach(id => {
            const byCourse = src[id] || {};
            const courses = {};
            Object.keys(byCourse).forEach(cid => {
                const entry = byCourse[cid] || {};
                const pace = dripEngine.dripNormalizePace(entry.value, entry.unit);
                if (pace) courses[String(cid)] = { value: pace.value, unit: pace.unit };
            });
            if (Object.keys(courses).length) clean[level][String(id)] = courses;
        });
    });
    db.settings = db.settings || [];
    let rec = db.settings.find(s => s && s.key === 'lessonPacing');
    if (!rec) { rec = { key: 'lessonPacing' }; db.settings.push(rec); }
    rec.value = clean;
    rec.updatedAt = new Date().toISOString();
    rec.updatedBy = (user && user.username) || 'system';
    saveDB();
    try { broadcastEvent('db-change', { store: 'settings' }); } catch (e) {}
}

// Counter keys a country/region coordinator may legitimately read/write: the
// per-month payment receipt counters (payment-YYYYMM) needed to issue RCT
// receipt numbers. Everything else (e.g. the global staff ID counter) stays
// admin/finance-only.
function isPaymentCounterKey(key) {
    return typeof key === 'string' && /^payment-\d{6}$/.test(key);
}
// Write fence for country administrators: creations get stamped with their
// country; touching another country's tagged records is rejected. Everyone
// else (admins, regionals, students, others) passes through untouched.
// ---- Server-side marking -------------------------------------------------
// Re-marks a stored submission against the answer key. This is the authority
// for a learner's score: the browser never gets to decide its own marks.
// Returns null when the attempt cannot be marked automatically (written
// answers, or questions that no longer exist).
function scoreSubmissionOnServer(sub) {
    if (!sub || !Array.isArray(sub.answers)) return null;
    const quiz = (db.quizzes || []).find(q => q && String(q.id) === String(sub.quizId))
        || (db.exams || []).find(e => e && String(e.id) === String(sub.quizId));
    if (!quiz) return null;
    const byId = new Map((db.questionBank || []).map(q => [String(q.id), q]));
    const norm = v => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
    let earned = 0, total = 0;
    for (const a of sub.answers) {
        if (!a) return null;
        const q = byId.get(String(a.questionId));
        if (!q) return null;                              // question removed
        // The question bank owns the type. Trusting the browser's answer type
        // let a tampered submission label an essay as an MCQ and award itself
        // full marks, so the type in the paper is what decides how it is marked.
        const qType = String(q.type || a.type || '').toLowerCase();
        if (qType === 'essay') return null;                // staff-marked
        const pts = Number(q.points) || 0;
        total += pts;
        if (qType === 'mcq' || qType === 'truefalse') {
            const key = Array.isArray(q.correctAnswers) && q.correctAnswers.length ? q.correctAnswers : [q.correctAnswer];
            const given = Array.isArray(a.answer) ? a.answer : (a.answer != null ? [a.answer] : []);
            const keyN = key.map(norm), givenN = given.map(norm);
            const ok = keyN.length === givenN.length && keyN.every(k => givenN.includes(k));
            if (ok) earned += pts;
        } else if (qType === 'matching') {
            const pairs = Array.isArray(q.pairs) ? q.pairs : [];
            if (!pairs.length) return null;
            let hits = 0;
            pairs.forEach((p, i) => {
                const got = Array.isArray(a.pairs) && a.pairs[i] ? a.pairs[i].userAnswer : '';
                if (norm(got) === norm(p.right)) hits++;
            });
            earned += (hits / pairs.length) * pts;
        } else if (qType === 'fillin') {
            const blanks = Array.isArray(q.blanks) ? q.blanks : [];
            if (!blanks.length) return null;
            let hits = 0;
            blanks.forEach((b, i) => {
                const got = Array.isArray(a.blankResults) && a.blankResults[i] ? a.blankResults[i].userAnswer : '';
                if (norm(got) && norm(got) === norm(b.answer)) hits++;
            });
            earned += (hits / blanks.length) * pts;
        } else {
            return null;
        }
    }
    if (!(total > 0)) return null;
    return { score: Math.round((earned / total) * 100), pointsEarned: Math.round(earned * 100) / 100, totalPoints: total };
}

// ---- THE GRADING SCALE (one table, shared with the browser) -------------
// The browser renders the same bands (js/bundle.js GRADE_SCALES). The active
// scale is the one the institution selected in Settings > Academic
// (settings.academic.grading). Both sides MUST use the same table, otherwise
// the letter printed on a transcript disagrees with the letter stored for the
// same score.
const GRADE_SCALES = {
    gpa4: { label: '4.0', bands: [
        { min: 90, grade: 'A', gpa: 4.0 }, { min: 80, grade: 'B+', gpa: 3.5 },
        { min: 75, grade: 'B', gpa: 3.0 }, { min: 70, grade: 'B-', gpa: 2.7 },
        { min: 65, grade: 'C+', gpa: 2.3 }, { min: 60, grade: 'C', gpa: 2.0 },
        { min: 50, grade: 'D', gpa: 1.0 }, { min: 0, grade: 'F', gpa: 0.0 }] },
    gpa5: { label: '5.0', bands: [
        { min: 90, grade: 'A', gpa: 5.0 }, { min: 80, grade: 'B+', gpa: 4.5 },
        { min: 75, grade: 'B', gpa: 4.0 }, { min: 70, grade: 'B-', gpa: 3.5 },
        { min: 65, grade: 'C+', gpa: 3.0 }, { min: 60, grade: 'C', gpa: 2.5 },
        { min: 55, grade: 'C-', gpa: 2.0 }, { min: 50, grade: 'D', gpa: 1.0 },
        { min: 0, grade: 'F', gpa: 0.0 }] },
    ects: { label: 'ECTS', bands: [
        { min: 90, grade: 'A', gpa: 4.0 }, { min: 80, grade: 'B', gpa: 3.0 },
        { min: 70, grade: 'C', gpa: 2.0 }, { min: 60, grade: 'D', gpa: 1.0 },
        { min: 50, grade: 'E', gpa: 0.5 }, { min: 0, grade: 'F', gpa: 0.0 }] },
    percent: { label: 'Percentage', bands: [
        { min: 70, grade: 'A', gpa: 4.0 }, { min: 60, grade: 'B', gpa: 3.0 },
        { min: 50, grade: 'C', gpa: 2.0 }, { min: 40, grade: 'D', gpa: 1.0 },
        { min: 0, grade: 'F', gpa: 0.0 }] },
    standard: { label: '4.0', bands: [
        { min: 75, grade: 'A', gpa: 4.0 }, { min: 70, grade: 'B+', gpa: 3.5 },
        { min: 65, grade: 'B', gpa: 3.0 }, { min: 60, grade: 'B-', gpa: 2.7 },
        { min: 55, grade: 'C+', gpa: 2.3 }, { min: 50, grade: 'C', gpa: 2.0 },
        { min: 45, grade: 'D+', gpa: 1.5 }, { min: 40, grade: 'D', gpa: 1.0 },
        { min: 0, grade: 'F', gpa: 0.0 }] }
};
function activeGradeScaleServer() {
    if (_activeGradeScaleKey === null) {
        try {
            const rec = settingRecord('academic');
            _activeGradeScaleKey = String((rec && rec.grading) || '');
        } catch { _activeGradeScaleKey = ''; }
    }
    return GRADE_SCALES[_activeGradeScaleKey] || GRADE_SCALES.standard;
}
// Grade letters must match the student-facing table in the browser.
function gradeBandForScore(score) {
    const s = Number(score) || 0;
    const bands = activeGradeScaleServer().bands;
    for (const b of bands) { if (s >= b.min) return { grade: b.grade, gpa: b.gpa }; }
    return { grade: 'F', gpa: 0.0 };
}

// ---- One course result from its assessment components --------------------
// The transcript prints a COURSE-LEVEL result (GRD-...), never an individual
// exam/quiz/CAT mark. This block keeps that result in step with the components:
// it reads the course weightage, merges the exams + quizzes stores, takes the
// learner's best attempt for each assessment, applies the component weights and
// writes a course-level grade when every component that exists for the course
// has a mark. A component category with no assessments in the course is not
// required, so a course that only has an exam is graded from that exam (and
// attendance if the course records it) instead of being held at zero by a quiz
// that was never offered.
const COURSE_COMPONENT_ORDER = ['exam', 'quiz', 'cat', 'attendance', 'other'];
const COURSE_COMPONENT_LABELS = { exam: 'Exam', quiz: 'Quiz', cat: 'CAT', attendance: 'Attendance', other: 'Other' };
const COURSE_ATT_AWARD_MIN = 80;

function courseComponentType(row) {
    const label = String((row && row.label) || '').toLowerCase();
    if (/attendance/.test(label)) return 'attendance';
    if (/\bcat\b|class\s*assessment|mid[-\s]*sem/.test(label)) return 'cat';
    if (/quiz/.test(label)) return 'quiz';
    if (/exam|final|paper|practicum|essay|project|assignment|portfolio|presentation|\blab\b/.test(label)) return 'exam';
    const type = String((row && row.type) || '').toLowerCase();
    return ['exam', 'quiz', 'cat', 'attendance'].includes(type) ? type : 'other';
}

function courseWeightGroups(course) {
    const src = course || {};
    let rows = Array.isArray(src.weightage) ? src.weightage.filter(r => Number(r && r.value) > 0) : [];
    if (!rows.length) {
        rows = [
            { label: 'Exam', value: src.examWeight != null ? src.examWeight : 30, type: 'exam' },
            { label: 'Quiz', value: src.quizWeight != null ? src.quizWeight : 20, type: 'quiz' },
            { label: 'CAT', value: src.catWeight != null ? src.catWeight : 25, type: 'cat' },
            { label: 'Attendance', value: src.attWeight != null ? src.attWeight : 10, type: 'attendance' }
        ].filter(r => Number(r.value) > 0);
    }
    if (!rows.length) rows = [
        { label: 'Exam', value: 30, type: 'exam' },
        { label: 'Quiz', value: 20, type: 'quiz' },
        { label: 'CAT', value: 25, type: 'cat' },
        { label: 'Attendance', value: 10, type: 'attendance' }
    ];
    const groups = { exam: 0, quiz: 0, cat: 0, attendance: 0, other: 0 };
    const labels = { exam: [], quiz: [], cat: [], attendance: [], other: [] };
    for (const row of rows) {
        const type = courseComponentType(row);
        const value = Number(row && row.value) || 0;
        if (!(value > 0)) continue;
        groups[type] += value;
        if (row && row.label) labels[type].push(String(row.label));
    }
    const total = groups.exam + groups.quiz + groups.cat + groups.attendance + groups.other;
    return { rows, groups, labels, total };
}

function assessmentComponentType(assessment, isExam) {
    const explicit = String((assessment && assessment.assessmentType) || '').toLowerCase();
    if (['exam', 'quiz', 'cat'].includes(explicit)) return explicit;
    return isExam ? 'exam' : 'quiz';
}

// The exams store is the assessment source. Quizzes is retained for older
// CAT/quiz records. A component belongs to the semester of its assessment.
function courseAssessmentComponents(courseId, semester) {
    const out = new Map();
    const add = (assessment, isExam) => {
        if (!assessment || !assessment.id) return;
        if (String(assessment.courseId || '') !== String(courseId)) return;
        if (semester !== null && semester !== undefined && semester !== '' && String(semester) !== 'all'
            && Number(assessment.semester != null ? assessment.semester : 1) !== Number(semester)) return;
        const type = assessmentComponentType(assessment, isExam);
        out.set(String(assessment.id), { id: String(assessment.id), type, assessment, isExam: !!isExam });
    };
    (db.quizzes || []).forEach(q => add(q, false));
    (db.exams || []).forEach(e => add(e, true));
    return Array.from(out.values());
}

function bestAssessmentScores(studentId, components) {
    const ids = new Set(components.map(c => c.id));
    const best = new Map();
    for (const sub of (db.submissions || [])) {
        if (!sub || String(sub.studentId || '') !== String(studentId)) continue;
        const assessmentId = String(sub.quizId || sub.examId || '');
        if (!ids.has(assessmentId)) continue;
        if (sub.needsReview === true || sub.status === 'pending_review') continue;
        const score = Number(sub.score);
        if (!Number.isFinite(score)) continue;
        const prior = best.get(assessmentId);
        if (!prior || score > prior.score) {
            best.set(assessmentId, { score, submissionId: sub.id, scoredAt: sub.submittedAt || sub.gradedAt || '' });
        }
    }
    return best;
}

function isCourseLevelGradeRecord(grade) {
    if (!grade || !grade.courseId) return false;
    if (grade.weighted === true) return true;
    return /^GRD-/.test(String(grade.id || ''));
}

function findCourseLevelGrade(studentId, courseId, semester) {
    return (db.grades || []).find(g => g && isCourseLevelGradeRecord(g)
        && String(g.studentId || '') === String(studentId)
        && String(g.courseId || '') === String(courseId)
        && String(g.semester) === String(semester)) || null;
}

function computeCourseResultFromAssessments(studentId, courseId, semester) {
    const course = (db.courses || []).find(c => c && String(c.id) === String(courseId));
    if (!course || !studentId || !courseId) return null;
    const weight = courseWeightGroups(course);
    const components = courseAssessmentComponents(courseId, semester);
    const best = bestAssessmentScores(studentId, components);
    const details = {};
    const missing = [];
    let requiredWeight = 0;
    let weighted = 0;
    let hasAcademic = false;

    for (const type of ['exam', 'quiz', 'cat']) {
        const groupWeight = Number(weight.groups[type]) || 0;
        if (!(groupWeight > 0)) continue;
        const definitions = components.filter(c => c.type === type);
        // If the course has no assessment of this type, it is not a missing
        // component - it is simply not part of this course's assessment plan.
        if (!definitions.length) continue;
        hasAcademic = true;
        requiredWeight += groupWeight;
        const scores = definitions.map(d => best.get(d.id)).filter(Boolean)
            .map(x => Number(x.score)).filter(Number.isFinite);
        const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        if (!scores.length) missing.push(type);
        weighted += avg * groupWeight;
        details[type] = {
            type,
            label: (weight.labels[type] || []).join(' + ') || COURSE_COMPONENT_LABELS[type],
            weight: groupWeight,
            avg,
            count: scores.length,
            defined: definitions.length
        };
    }

    // Attendance is a component only when the course records attendance for
    // this learner (or at all). No attendance sheet means "not offered".
    const attRows = (db.attendance || []).filter(a => a
        && String(a.studentId || '') === String(studentId)
        && String(a.courseId || '') === String(courseId));
    const courseHasAttendance = (db.attendance || []).some(a => a && String(a.courseId || '') === String(courseId));
    const attWeight = Number(weight.groups.attendance) || 0;
    let attendancePct = 0;
    if (attWeight > 0 && attRows.length) {
        requiredWeight += attWeight;
        attendancePct = (attRows.filter(a => a.status === 'present' || a.status === 'late').length / attRows.length) * 100;
        const attAward = attendancePct >= COURSE_ATT_AWARD_MIN ? 100 : 0;
        weighted += attAward * attWeight;
        details.attendance = {
            type: 'attendance',
            label: (weight.labels.attendance || []).join(' + ') || COURSE_COMPONENT_LABELS.attendance,
            weight: attWeight,
            avg: attAward,
            count: attRows.length,
            defined: attRows.length
        };
    } else if (attWeight > 0 && courseHasAttendance) {
        requiredWeight += attWeight;
        missing.push('attendance');
        details.attendance = {
            type: 'attendance',
            label: (weight.labels.attendance || []).join(' + ') || COURSE_COMPONENT_LABELS.attendance,
            weight: attWeight,
            avg: 0,
            count: 0,
            defined: 0
        };
    }

    if (weight.groups.other > 0) {
        requiredWeight += weight.groups.other;
        missing.push('other');
        details.other = {
            type: 'other',
            label: (weight.labels.other || []).join(' + ') || COURSE_COMPONENT_LABELS.other,
            weight: weight.groups.other,
            avg: 0,
            count: 0,
            defined: 0
        };
    }

    const score = requiredWeight > 0 ? Math.round(weighted / requiredWeight) : 0;
    return {
        complete: hasAcademic && requiredWeight > 0 && missing.length === 0,
        score,
        weightedScore: score,
        requiredWeight,
        missing,
        groups: weight.groups,
        labels: weight.labels,
        components: Object.values(details),
        attendancePct,
        examAvg: details.exam ? details.exam.avg : 0,
        quizAvg: details.quiz ? details.quiz.avg : 0,
        catAvg: details.cat ? details.cat.avg : 0,
        attAwarded: !!(details.attendance && details.attendance.avg >= 100),
        examCount: details.exam ? details.exam.count : 0,
        quizCount: details.quiz ? details.quiz.count : 0,
        catCount: details.cat ? details.cat.count : 0,
        attTotal: details.attendance ? details.attendance.count : 0,
        examWeight: weight.groups.exam,
        quizWeight: weight.groups.quiz,
        catWeight: weight.groups.cat,
        attWeight: weight.groups.attendance,
        otherWeight: weight.groups.other
    };
}

// Write the course-level result only when the component set is complete. A
// manually entered result is absolutely protected; an older imported result
// (neither manual nor weighted) is also left alone. A result this engine wrote,
// or a staff "compute weighted" snapshot, is refreshed as marks change.
function syncCourseGradeFromAssessments(studentId, courseId, semester, opts) {
    try {
        const options = opts || {};
        const result = computeCourseResultFromAssessments(studentId, courseId, semester);
        // There must be ONE course-level result per course + semester. Older
        // data contains duplicate GRD records (for example a stale failed mark
        // under an old student id and the current computed result). Pick the
        // authoritative record instead of whichever happens to come first, and
        // remove the duplicates below. A manual record always wins.
        const matches = (db.grades || []).filter(g => g && isCourseLevelGradeRecord(g)
            && String(g.studentId || '') === String(studentId)
            && String(g.courseId || '') === String(courseId)
            && String(g.semester) === String(semester));
        const manualRecord = matches.find(g => g.manual === true) || null;
        const existing = manualRecord
            || matches.find(g => g.source === 'assessments')
            || matches.find(g => g.weighted === true)
            || matches[0] || null;
        if (!result || !result.complete) {
            if (options.removeIfIncomplete) {
                const removable = matches.filter(g => g.manual !== true && g.source === 'assessments');
                if (removable.length) {
                    db.grades = (db.grades || []).filter(g => !removable.includes(g));
                    saveDB();
                    try { broadcastEvent('db-change', { store: 'grades' }); } catch {}
                    auditLog('removed', 'course-grade', {
                        studentId, courseId, semester: Number(semester) || 1, reason: 'incomplete', count: removable.length
                    }, 'system');
                    return { id: removable[0].id, removed: true };
                }
            }
            return result ? Object.assign({}, result, { recorded: false, existing: false }) : null;
        }
        if (existing && existing.manual === true) return Object.assign({}, result, { id: existing.id, recorded: true, protected: 'manual' });
        if (existing && existing.source !== 'assessments' && existing.weighted !== true) {
            return Object.assign({}, result, { id: existing.id, recorded: true, protected: 'imported' });
        }
        if (options.createOnly && existing) return Object.assign({}, result, { id: existing.id, recorded: true, unchanged: true });
        const band = gradeBandForScore(result.score);
        const id = existing ? existing.id : `GRD-${studentId}-${courseId}-${semester}`;
        const now = new Date().toISOString();
        const duplicates = matches.filter(g => g && String(g.id) !== String(id) && g.manual !== true);
        const same = existing
            && Number(existing.score) === result.score
            && existing.grade === band.grade
            && Number(existing.gpa) === band.gpa
            && JSON.stringify(existing.components || []) === JSON.stringify(result.components);
        if (same && !duplicates.length) return Object.assign({}, result, { id, recorded: true, unchanged: true });
        const record = Object.assign({}, existing || {}, {
            id,
            studentId,
            courseId,
            semester: Number(semester) || 1,
            score: result.score,
            grade: band.grade,
            gpa: band.gpa,
            weighted: true,
            source: 'assessments',
            computedFrom: 'exam+quiz+cat+attendance',
            components: result.components,
            weights: result.groups,
            computedAt: now,
            updatedAt: now
        });
        if (!existing) record.gradedAt = now;
        if (!db.grades) db.grades = [];
        const idx = db.grades.findIndex(g => g && String(g.id) === String(id));
        if (idx >= 0) db.grades[idx] = record; else db.grades.push(record);
        if (duplicates.length) {
            db.grades = db.grades.filter(g => !duplicates.includes(g));
        }
        saveDB();
        try { broadcastEvent('db-change', { store: 'grades' }); } catch {}
        auditLog(existing ? 'recomputed' : 'computed', 'course-grade', {
            studentId, courseId, semester: Number(semester) || 1, score: result.score,
            source: 'assessments', duplicatesRemoved: duplicates.length
        }, 'system');
        return Object.assign({}, result, {
            id, recorded: true, created: !existing, changed: true, duplicatesRemoved: duplicates.length
        });
    } catch (e) {
        console.error('syncCourseGradeFromAssessments failed:', e.message);
        return null;
    }
}

// One idempotent pass at boot for results that were scored before this engine
// existed. It only looks at assessments that actually have a mark; missing
// components stay missing (partial courses do not get a transcript result).
function backfillCourseGradesFromAssessments() {
    try {
        const pairs = new Map();
        for (const sub of (db.submissions || [])) {
            if (!sub || sub.needsReview === true || sub.status === 'pending_review') continue;
            if (!Number.isFinite(Number(sub.score))) continue;
            const assessment = (db.exams || []).find(a => a && String(a.id) === String(sub.quizId || sub.examId))
                || (db.quizzes || []).find(a => a && String(a.id) === String(sub.quizId || sub.examId));
            if (!assessment || !assessment.courseId) continue;
            const semester = Number(assessment.semester != null ? assessment.semester : 1) || 1;
            pairs.set(String(sub.studentId) + '|' + assessment.courseId + '|' + semester, {
                studentId: String(sub.studentId), courseId: String(assessment.courseId), semester
            });
        }
        let created = 0, updated = 0;
        for (const pair of pairs.values()) {
            const r = syncCourseGradeFromAssessments(pair.studentId, pair.courseId, pair.semester, {});
            if (r && r.created) created++;
            else if (r && r.changed) updated++;
        }
        if (created || updated) {
            process.stderr.write('COURSE_GRADE_BACKFILL: ' + created + ' created, ' + updated + ' updated\n');
        }
        return { created, updated };
    } catch (e) {
        console.error('backfillCourseGradesFromAssessments failed:', e.message);
        return { created: 0, updated: 0 };
    }
}

// Keep an EXISTING automatic course result current when its inputs outside the
// submissions store change (attendance, course weightage). This deliberately
// does not create new records: an attendance edit alone must not turn a course
// with no academic components into a result.
function syncExistingCourseGradesFor(studentId, courseId) {
    const rows = (db.grades || []).filter(g => g && isCourseLevelGradeRecord(g)
        && g.source === 'assessments' && g.manual !== true
        && String(g.studentId || '') === String(studentId)
        && String(g.courseId || '') === String(courseId));
    for (const g of rows) {
        syncCourseGradeFromAssessments(g.studentId, g.courseId, g.semester, {});
    }
}
function syncExistingCourseGradesForCourse(courseId) {
    const seen = new Set();
    for (const g of (db.grades || [])) {
        if (!g || !isCourseLevelGradeRecord(g) || g.source !== 'assessments' || g.manual === true) continue;
        if (String(g.courseId || '') !== String(courseId)) continue;
        const key = String(g.studentId) + '|' + String(g.semester);
        if (seen.has(key)) continue;
        seen.add(key);
        syncCourseGradeFromAssessments(g.studentId, g.courseId, g.semester, {});
    }
}

// The stored results are brought in line with the ACTIVE scale once the scale
// itself is available (the tables above are declared before this point).
try { normaliseStoredGradeScale(); } catch (e) { console.error('boot grade normalisation failed:', e); }
try { backfillCourseGradesFromAssessments(); } catch (e) { console.error('boot course-grade backfill failed:', e); }
// The identifiers a learner may answer to: the student id, the username and
// the admission number. A session may carry any one of them. Alumni keep the
// original student's academic id, so grants and history stay linked even when
// the students-store row has been archived.
function findAlumniForUser(user) {
    if (!user) return null;
    const uRec = (db.users || []).find(u => u && String(u.username) === String(user.username)) || {};
    const alumni = db.alumni || [];
    const aid = String(user.alumniId || uRec.alumniId || '').trim();
    const sid = String(user.studentId || uRec.studentId || '').trim();
    const login = String(user.username || '').trim();
    const loginLower = login.toLowerCase();
    const digits = login.replace(/[^0-9]/g, '').slice(-9);
    let hit = aid ? alumni.find(a => a && String(a.id) === aid) : null;
    if (!hit && sid) hit = alumni.find(a => a && (String(a.studentId || '') === sid || String(a.id || '') === sid));
    if (!hit && login) hit = alumni.find(a => a && (
        String(a.id || '') === login ||
        String(a.studentId || '') === login ||
        String(a.admissionNumber || '') === login ||
        String(a.phone || '') === login ||
        String(a.email || '').toLowerCase() === loginLower
    ));
    if (!hit && digits) hit = alumni.find(a => a && a.phone && String(a.phone).replace(/[^0-9]/g, '').slice(-9) === digits);
    if (!hit && user._allowAlumniNameMatch === true) {
        const nameLower = String(user.name || uRec.name || '').trim().toLowerCase();
        if (nameLower) {
            const matches = alumni.filter(a => a && String(a.name || '').trim().toLowerCase() === nameLower);
            if (matches.length === 1) hit = matches[0];
        }
    }
    return hit || null;
}
function studentAliases(user) {
    if (!user) return new Set();
    const uRec = (db.users || []).find(u => u && String(u.username) === String(user.username));
    const stuId = String(user.studentId || '');
    const myStu = (db.students || []).find(s => s && String(s.id) === String(stuId || (uRec && uRec.studentId) || ''));
    const alumni = findAlumniForUser(user);
    return new Set([
        stuId, String((uRec && uRec.studentId) || ''), String(user.username || ''),
        String((myStu && myStu.admissionNumber) || ''),
        String(user.alumniId || (uRec && uRec.alumniId) || ''),
        String((alumni && alumni.studentId) || ''), String((alumni && alumni.id) || ''),
        String((alumni && alumni.admissionNumber) || ''),
        String((alumni && alumni.phone) || ''), String((alumni && alumni.email) || '')
    ].filter(Boolean));
}
// WHICH student a session belongs to. The server decides this - the browser
// never says whose paper it is.
function serverStudentId(user) {
    if (!user) return '';
    const uRec = (db.users || []).find(u => u && String(u.username) === String(user.username));
    const direct = String(user.studentId || (uRec && uRec.studentId) || '');
    const students = db.students || [];
    if (direct && students.some(s => s && String(s.id) === direct)) return direct;
    const login = String(user.username || '');
    const byLogin = students.find(s => s && (
        String(s.id || '') === login ||
        String(s.id || '') === 'STU-' + login ||
        String(s.admissionNumber || '') === login ||
        String(s.email || '') === login
    ));
    if (byLogin) return String(byLogin.id);
    const alumni = findAlumniForUser(user);
    if (alumni) return String(alumni.studentId || alumni.id || '');
    return '';
}
// Course-level alumni access. Courses opt in explicitly; a course created
// before this feature has no alumniAccess block and is therefore not exposed.
function alumniCourseSettings(course) {
    const a = course && course.alumniAccess && typeof course.alumniAccess === 'object' ? course.alumniAccess : null;
    const enabled = !!(a ? a.enabled !== false : (course && course.alumniEnabled === true));
    const mode = a && a.mode === 'invite' ? 'invite' : 'open';
    const rawDays = a ? Number(a.accessDays) : 365;
    const accessDays = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(3650, Math.round(rawDays)) : 365;
    return {
        enabled, mode, accessDays,
        certificate: a ? a.certificate !== false : true,
        certificateFee: Math.max(0, Number(a && a.certificateFee) || 0)
    };
}
function alumniGrantActive(grant, now) {
    if (!grant) return false;
    const status = String(grant.status || 'active').toLowerCase();
    if (['invited', 'dropped', 'declined', 'expired', 'revoked', 'cancelled'].includes(status)) return false;
    const t = now == null ? Date.now() : now;
    const start = grant.startsAt ? Date.parse(String(grant.startsAt)) : NaN;
    if (Number.isFinite(start) && start > t) return false;
    const end = grant.expiresAt ? Date.parse(String(grant.expiresAt)) : NaN;
    if (Number.isFinite(end) && end < t) return false;
    return true;
}
// Students may accept their own invitation or self-enrol in an open alumni
// course. They may never create an invitation, enrol another learner, or
// reach a course whose alumni access is switched off.
function studentAlumniEnrollmentError(user, rec, existing) {
    if (!user || user.role !== 'student' || !rec) return 'Not permitted';
    // Alumni access is a lifelong-learner entitlement, never a shortcut for
    // an active student to bypass tuition or the normal enrolment process.
    if (!isAlumniAccount(user)) return 'Alumni course access is for alumni accounts';
    const sid = serverStudentId(user);
    if (!sid) return 'Your session is not linked to an alumni record';
    const aliases = studentAliases(user);
    const recSid = String(rec.studentId || (existing && existing.studentId) || '');
    if (recSid && recSid !== sid && !aliases.has(recSid)) return 'You may only change your own alumni access';
    const existingSid = String((existing && existing.studentId) || '');
    if (existingSid && existingSid !== sid && !aliases.has(existingSid)) return 'You may only change your own alumni access';
    const courseId = String(rec.courseId || (existing && existing.courseId) || '');
    // An existing grant may be accepted or renewed, but never moved to a
    // different course: otherwise an open-course grant could be re-pointed at
    // an invitation-only course and bypass the invitation.
    if (existing && String(existing.courseId || '') !== courseId) {
        return 'An alumni grant cannot be moved to another course';
    }
    const course = (db.courses || []).find(c => c && String(c.id) === courseId);
    if (!course) return 'Course not found';
    const settings = alumniCourseSettings(course);
    if (!settings.enabled) return 'This course is not open to alumni';
    const existingStatus = String((existing && existing.status) || '').toLowerCase();
    if (settings.mode === 'invite' && !existing) return 'This course is invitation-only';
    if (settings.mode === 'invite' && existingStatus === 'active' && !alumniGrantActive(existing)) {
        return 'This invitation has expired — ask the alumni office to invite you again';
    }
    if (settings.mode === 'invite' && existingStatus && !['invited', 'active'].includes(existingStatus)) {
        return 'This invitation is no longer active';
    }
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const currentEnd = existing && existing.expiresAt ? Date.parse(String(existing.expiresAt)) : NaN;
    const keepEnd = existingStatus === 'active' && Number.isFinite(currentEnd) && currentEnd > now;
    rec.id = existing && existing.id ? existing.id : `AENR-${courseId}-${sid}`;
    rec.courseId = courseId;
    rec.studentId = sid;
    rec.accountType = 'alumni';
    rec.status = 'active';
    rec.accessDays = settings.accessDays;
    rec.expiresAt = keepEnd ? new Date(currentEnd).toISOString() : new Date(now + settings.accessDays * 86400000).toISOString();
    rec.acceptedAt = (existing && existing.acceptedAt) || nowIso;
    if (existing && existing.invitedAt) rec.invitedAt = existing.invitedAt;
    if (!rec.enrolledAt) rec.enrolledAt = nowIso;
    return null;
}
function studentAlumniGrantDeleteError(user, rec) {
    if (!user || user.role !== 'student' || !rec) return 'Not permitted';
    const sid = serverStudentId(user);
    if (!sid) return 'Your session is not linked to an alumni record';
    const aliases = studentAliases(user);
    const recSid = String(rec.studentId || '');
    if (recSid !== sid && !aliases.has(recSid)) return 'You may only change your own alumni access';
    return null;
}
// Link an existing student login to its lifelong-learner identity without
// creating a student record, admission number, or public registration.
function isAlumniAccount(user) {
    if (!user || user.role !== 'student') return false;
    const su = user.user || user;
    if (su.accountType === 'alumni' || su.alumniId) return true;
    const uRec = (db.users || []).find(u => u && String(u.username) === String(user.username)) || null;
    if (uRec && (uRec.accountType === 'alumni' || uRec.alumniId)) return true;
    const sid = serverStudentId(user);
    const student = (db.students || []).find(s => s && String(s.id) === String(sid)) || null;
    if (student) return String(student.status || '').toLowerCase() === 'alumni';
    return !!findAlumniForUser(user);
}
function markAlumniAccount(user, storedUser) {
    if (!user || user.role !== 'student') return;
    const target = storedUser || user;
    const studentId = String(user.studentId || target.studentId || '');
    const student = (db.students || []).find(s => s && String(s.id) === studentId) || null;
    const archivedStudent = !!(student && String(student.status || '').toLowerCase() === 'alumni');
    if (archivedStudent || user.accountType === 'alumni' || target.accountType === 'alumni') {
        user._allowAlumniNameMatch = true;
    }
    const alumni = findAlumniForUser(user);
    if (!alumni && !archivedStudent && user.accountType !== 'alumni' && target.accountType !== 'alumni') return;
    const linkedStudentId = String(
        user.studentId || target.studentId ||
        (alumni && alumni.studentId) || (student && student.id) || (alumni && alumni.id) || ''
    );
    const alumniId = String(
        (alumni && alumni.id) || user.alumniId || target.alumniId || ''
    );
    const alumniSince = (alumni && alumni.gradYear) || user.alumniSince || target.alumniSince || '';
    for (const rec of [user, target]) {
        if (!rec) continue;
        rec.accountType = 'alumni';
        if (alumniId) rec.alumniId = alumniId;
        if (linkedStudentId) rec.studentId = linkedStudentId;
        if (alumniSince !== '') rec.alumniSince = alumniSince;
    }
}
// A stable id for the grade of one attempt, so the server and the browser
// always write the SAME record (no duplicates when both write it).
function assessmentGradeId(studentId, quizId) {
    const clean = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '_');
    return 'GRADE-' + clean(studentId) + '-' + clean(quizId);
}
// Create (or refresh) the grade record that belongs to a marked submission.
// The SERVER is the only writer of a grade record that comes from a paper, so
// there can never be two copies of the same mark.
// Returns { id, created } so the caller can tell a fresh record from an
// updated one.
function upsertGradeFromSubmission(sub, marked, band, assessment, scoredBy) {
    const studentId = String(sub.studentId || '');
    const quizId = String(sub.quizId || sub.examId || '');
    const courseId = String((assessment && assessment.courseId) || sub.courseId || '');
    // A grade always belongs to a learner and an assessment.
    if (!studentId || !quizId) return null;
    const existing = (db.grades || []).find(x => x && String(x.studentId) === studentId && String(x.quizId) === quizId);
    const id = existing ? existing.id : assessmentGradeId(studentId, quizId);
    const entry = {
        id: id,
        studentId: studentId,
        submissionId: sub.id,
        courseId: courseId,
        score: marked.score,
        grade: band.grade,
        gpa: band.gpa,
        type: (assessment && assessment.assessmentType) || 'exam',
        quizId: quizId,
        semester: Number(sub.semester != null ? sub.semester : ((assessment && assessment.semester) != null ? assessment.semester : 1)) || 1,
        gradedAt: new Date().toISOString(),
        scoredBy: scoredBy || 'server'
    };
    const gi = (db.grades || []).findIndex(x => x && x.id === id);
    if (gi >= 0) db.grades[gi] = entry; else db.grades.push(entry);
    // Refresh the COURSE result as soon as a component is marked. This is the
    // bridge that makes an exam/quiz/CAT reach the transcript; the transcript
    // itself keeps printing the course-level GRD record, never this one.
    const courseResult = courseId
        ? syncCourseGradeFromAssessments(studentId, courseId, entry.semester, {})
        : null;
    return {
        id: id,
        created: gi < 0,
        courseGradeId: courseResult && courseResult.id ? courseResult.id : null,
        courseGradeComplete: !!(courseResult && courseResult.complete),
        courseGradeRecorded: !!(courseResult && courseResult.recorded)
    };
}


// ---- Assessment window (server authority) ------------------------------
const ASSESSMENT_GRACE_DAYS = 4;
// The Date/Time fields in the exam and quiz forms are wall-clock times at the
// campus, not UTC. The server container runs in UTC, so comparing those strings
// directly made a 17:00 East Africa exam look like it opened at 20:00 local and
// rejected every learner in between. Resolve the campus timezone first, then
// compare actual instants.
const ASSESSMENT_DEFAULT_TIME_ZONE = 'Africa/Nairobi';
const ASSESSMENT_TIME_ZONES = {
    KENYA: 'Africa/Nairobi', KE: 'Africa/Nairobi',
    UGANDA: 'Africa/Kampala', UG: 'Africa/Kampala',
    TANZANIA: 'Africa/Dar_es_Salaam', TZ: 'Africa/Dar_es_Salaam',
    RWANDA: 'Africa/Kigali', RW: 'Africa/Kigali',
    BURUNDI: 'Africa/Bujumbura', BI: 'Africa/Bujumbura',
    ETHIOPIA: 'Africa/Addis_Ababa', ET: 'Africa/Addis_Ababa',
    'SOUTH SUDAN': 'Africa/Juba', SS: 'Africa/Juba',
    SOMALIA: 'Africa/Mogadishu', SO: 'Africa/Mogadishu',
    ZAMBIA: 'Africa/Lusaka', ZM: 'Africa/Lusaka',
    TOGO: 'Africa/Lome', TG: 'Africa/Lome',
    NIGERIA: 'Africa/Lagos', NG: 'Africa/Lagos',
    GHANA: 'Africa/Accra', GH: 'Africa/Accra',
    CAMEROON: 'Africa/Douala', CM: 'Africa/Douala'
};
function assessmentTimeZone(a, user) {
    const explicit = String((a && (a.timeZone || a.timezone)) || '').trim();
    if (explicit) {
        try { new Intl.DateTimeFormat('en-US', { timeZone: explicit }).format(new Date()); return explicit; } catch {}
    }
    const names = [];
    if (a && a.country) names.push(String(a.country).trim().toUpperCase());
    try {
        const sid = serverStudentId(user || {});
        const student = sid ? (db.students || []).find(s => s && String(s.id) === String(sid)) : null;
        if (student) {
            if (student.country) names.push(String(student.country).trim().toUpperCase());
            const center = (db.studyCenters || []).find(c => c && String(c.id) === String(student.studyCenterId));
            if (center && center.country) names.push(String(center.country).trim().toUpperCase());
            const regionId = (center && center.regionId) || student.regionId;
            const region = regionId ? (db.regions || []).find(r => r && String(r.id) === String(regionId)) : null;
            if (region && region.country) names.push(String(region.country).trim().toUpperCase());
        }
    } catch {}
    for (const name of names) if (ASSESSMENT_TIME_ZONES[name]) return ASSESSMENT_TIME_ZONES[name];
    return ASSESSMENT_DEFAULT_TIME_ZONE;
}
function assessmentTimePartsServer(time) {
    const raw = String(time || '').trim();
    if (!raw) return { start: '', end: '' };
    const range = raw.match(/(\d{1,2}):(\d{2})\s*(?:-|\u2013|to|\u2014)\s*(\d{1,2}):(\d{2})/i);
    if (range) {
        const pad = n => String(n).padStart(2, '0');
        return { start: pad(range[1]) + ':' + pad(range[2]), end: pad(range[3]) + ':' + pad(range[4]) };
    }
    const single = raw.match(/(\d{1,2}):(\d{2})/);
    if (single) { const p = String(single[1]).padStart(2, '0') + ':' + String(single[2]).padStart(2, '0'); return { start: p, end: '' }; }
    return { start: '', end: '' };
}
// Convert a wall-clock date/time in an IANA timezone to a UTC epoch. The
// zones used by the institution have no daylight-saving transition, but the
// two-pass offset calculation also behaves correctly at a DST boundary.
function assessmentEpoch(day, clock, timeZone) {
    const dm = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dm) return NaN;
    const tm = String(clock || '00:00').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!tm) return NaN;
    const guess = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]),
        Number(tm[1]), Number(tm[2]), Number(tm[3] || 0));
    try {
        const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone: timeZone || ASSESSMENT_DEFAULT_TIME_ZONE, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        const offsetAt = (ms) => {
            const p = {};
            for (const part of dtf.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = part.value;
            let hour = Number(p.hour); if (hour === 24) hour = 0;
            const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
                hour, Number(p.minute), Number(p.second));
            return asUTC - ms;
        };
        let epoch = guess - offsetAt(guess);
        const settled = guess - offsetAt(epoch);
        if (Number.isFinite(settled)) epoch = settled;
        return epoch;
    } catch { return guess; }
}
// Manual close date wins; then the end time in the Time field; then the
// 4-day default. The Time field also sets the earliest start of the day.
function assessmentWindowServer(a, user) {
    const now = Date.now();
    if (!a) return { opensAtISO: '', closesAtISO: '', closesAt: '', closed: false, notYetOpen: false, timeZone: ASSESSMENT_DEFAULT_TIME_ZONE };
    const timeZone = assessmentTimeZone(a, user);
    const t = assessmentTimePartsServer(a.time);
    const baseDay = String(a.opensAt || a.date || '').slice(0, 10);
    let opensAtISO = '';
    let opensAtEpoch = NaN;
    if (baseDay) {
        const start = t.start || '00:00';
        opensAtISO = baseDay + 'T' + start + ':00';
        opensAtEpoch = assessmentEpoch(baseDay, start, timeZone);
    }
    let closesAt = a.closesAt || '';
    let closesAtISO = '';
    let closesAtEpoch = NaN;
    if (closesAt) {
        const closeDay = String(closesAt).slice(0, 10);
        closesAtISO = closeDay + 'T23:59:59';
        closesAtEpoch = assessmentEpoch(closeDay, '23:59:59', timeZone);
    } else if (baseDay && t.end) {
        closesAtISO = baseDay + 'T' + t.end + ':00';
        closesAtEpoch = assessmentEpoch(baseDay, t.end, timeZone);
        closesAt = baseDay;
    } else if (baseDay) {
        const d = new Date(baseDay + 'T12:00:00Z');
        if (!isNaN(d.getTime())) {
            d.setUTCDate(d.getUTCDate() + ASSESSMENT_GRACE_DAYS);
            closesAt = d.toISOString().slice(0, 10);
            closesAtISO = closesAt + 'T23:59:59';
            closesAtEpoch = assessmentEpoch(closesAt, '23:59:59', timeZone);
        }
    }
    return {
        opensAtISO, closesAtISO, closesAt, timeZone,
        opensAtEpoch, closesAtEpoch,
        closed: Number.isFinite(closesAtEpoch) && now > closesAtEpoch,
        notYetOpen: Number.isFinite(opensAtEpoch) && now < opensAtEpoch
    };
}

function scopeWrite(user, store, rec, existing) {
    // Coordinators (country OR region bound) may write counters ONLY for the
    // payment receipt keys they need while recording payments. This guard runs
    // for every coordinator regardless of country scope so a region coordinator
    // cannot forge the global staff / other counters either.
    if (user && user.role === 'coordinator' && store === 'counters') {
        return isPaymentCounterKey(rec && rec.key) ? null : 'Not permitted';
    }
    const scope = countryScopeOf(user);
    if (!scope) return null;
    if (['users', 'settings', 'sessions', 'maintenanceBypassTokens', 'audit'].includes(store)) return 'Not permitted';
    if (store === 'counters') return isPaymentCounterKey(rec && rec.key) ? null : 'Not permitted';
    const tagged = rec && rec.country ? String(rec.country) : '';
    const cur = existing && existing.country ? String(existing.country) : '';
    if (tagged && tagged !== scope) return 'Outside your country scope';
    if (cur && cur !== scope) return 'Outside your country scope';
    if (rec && !rec.country) rec.country = scope;
    return null;
}
// Study centers must keep globally-unique short codes: the code is the exact
// token embedded in admission numbers (NF/UNSC/09-26/001), so a duplicate
// would corrupt students' admission numbers across centers.
function studyCenterCodeConflict(rec) {
    try {
        if (!rec || !rec.code) return null;
        const code = String(rec.code).toUpperCase();
        const id = rec.id;
        const hit = (db.studyCenters || []).find(r => r && String(r.code || '').toUpperCase() === code && String(r.id) !== String(id));
        return hit ? String(hit.code) : null;
    } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Public (unauthenticated) surface allowlists
//
// The login screen and the public registration form have to work for a
// visitor with no session, so a small, explicit slice of the data stays
// readable anonymously. Everything else - M-Pesa/SMS credentials, the
// WhatsApp sender, fee rules, admission-sequence state, PDF templates,
// signature images and the whole student database - is staff-only and must
// never be handed to an anonymous caller.
//
// These lists are the ONLY thing an anonymous visitor can read. A store that
// is not listed here stays fully private; a listed store is filtered row by
// row through the projections below.
// ---------------------------------------------------------------------------

// Settings records an anonymous visitor may read.
//   branding   - school identity shown on the login screen (public fields only)
//   academic   - programme list used by the registration form
//   maintenance- on/off flag shown on the login screen
const PUBLIC_SETTING_KEYS = new Set(['branding', 'academic', 'maintenance']);

// Branding fields that must never leave the server for an anonymous visitor:
// the registrar/dean/director signature images, the college stamp and the
// tax PIN. They are used on transcripts, diplomas and receipts - staff only.
const PRIVATE_BRANDING_FIELDS = new Set([
    'sig_registrar', 'sig_dean', 'sig_director', 'college_stamp', 'collegeStamp',
    'kraPin', 'paidSignature', 'receivedSignature', 'stamp', 'sig_stamp'
]);

// Study-centre and region rows are needed by the public registration form.
// Only these columns are exposed; anything added to those records later stays
// server-side by default.
const PUBLIC_CENTER_FIELDS = ['id', 'name', 'code', 'country', 'regionId', 'address'];
const PUBLIC_REGION_FIELDS = ['id', 'name', 'country'];

// Copy a record keeping only the listed columns.
function projectRecord(rec, fields) {
    if (!rec || typeof rec !== 'object') return rec;
    const out = {};
    for (const f of fields) if (rec[f] !== undefined) out[f] = rec[f];
    return out;
}

// Drop the private fields from a branding record (no-op for other records).
function stripPrivateBranding(rec) {
    if (!rec || rec.key !== 'branding') return rec;
    const out = {};
    for (const k of Object.keys(rec)) {
        if (PRIVATE_BRANDING_FIELDS.has(k)) continue;
        out[k] = rec[k];
    }
    return out;
}

// The anonymous view of the settings store: only the public keys, and for
// branding only the public fields. Applied AFTER blob injection so an
// injected blob can never re-add a signature.
function publicSettingsView(rows) {
    return (rows || []).filter(r => r && PUBLIC_SETTING_KEYS.has(r.key)).map(stripPrivateBranding);
}

// Check if user can access a store
function canAccessStore(user, store, method) {
    // Sensitive internal stores - admin only, never via API
    if (store === 'sessions' || store === 'maintenanceBypassTokens') {
        return user && user.role === 'admin';
    }
    // Allow unauthenticated reads for login screen / registration.
    // The ROWS that come back are filtered by the public allowlists above
    // (publicSettingsView / projectRecord), so this grant never exposes the
    // credential- or PII-bearing records of those stores.
    if (!user && method === 'GET' && (store === 'settings' || store === 'studyCenters' || store === 'regions')) return true;
    if (!user) return false;
    // A user who must change their password may only read their own record
    // and the settings the login screen needs; everything else waits.
    if (mustChangePassword(user)) {
        if (store === 'users' && method === 'GET') return true;
        if (store === 'settings' && method === 'GET') return true;
        return false;
    }
    // The overall admin is never limited — full view and full write on every
    // store, checked before any role/country/assistant rule below can apply.
    // The one exception: the owner decides which tabs the admin may open, and
    // a tab that is switched off removes the write access behind it.
    if (user.role === 'admin' && !user.isOwner) {
        if (method !== 'GET' && adminTabBlocked(store)) return false;
    }
    if (user.role === 'admin') return true;
    // Students store: only admin and assistant (if enabled) may create/update/delete
    if (store === 'students' && method !== 'GET') {
        if (user.role === 'admin' || countryScopeOf(user)) return true;
        if (user.role === 'assistant') {
            const access = settingValue('assistantAccess');
            if (!access || access['students'] !== false) return true;
            return false;
        }
        return false;
    }
    // Fee agreements + waivers: reads for staff, writes admin/finance/registrar/assistant(with Finance tab)
    if (store === 'feeAgreements' || store === 'waivers') {
        if (method === 'GET') return true;
        if (user.role === 'admin' || user.role === 'finance' || user.role === 'registrar' || countryScopeOf(user)) return true;
        if (user.role === 'assistant') {
            const access = settingValue('assistantAccess');
            if (!access || access['finance'] !== false) return true;
            return false;
        }
        return false;
    }
    if (FINANCE_ADMIN_ROLES.has(user.role)) return true;

    if (user.role === 'student') {
        if (STUDENT_DENY_STORES.has(store)) return false;
        // A grade is written by the learner only as a request to have their own
        // submission marked; the server re-marks it and owns the score.
        if (method !== 'GET' && store === 'grades') return true;
        if (method !== 'GET' && !STUDENT_WRITE_STORES.has(store)) return false;
        if (method === 'GET' && store === 'payments') return true; // filtering happens in the handler
        return true;
    }

    // NOTE: read-only exceptions for specific settings keys (branding, academic)
    // live at the /api/db route level, where the requested key IS in scope.
    // canAccessStore is store-only and stays strict: settings is never granted
    // here, so no unintended settings key ever leaks to non-admin roles.
// Country administrator: coordinator bound to a country (no region).
    // Near-admin access scoped to their country — can access everything
    // except Settings, global admin stores, and audit logs. Can also
    // create regions and study centers for their country. The counters
    // store is granted but key-scoped (payment receipt counters only; see
    // isPaymentCounterKey in scopeWrite + filterStoreForUser).
    if (countryScopeOf(user)) {
        if (store === 'users' || store === 'sessions' || store === 'maintenanceBypassTokens' || store === 'settings' || store === 'audit') return false;
        return true;
    }
    // Coordinator: sub-admin scoped to their region.
    if (user.role === 'coordinator') {
        if (['settings','regions','users'].includes(store)) return false;
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
            const access = settingValue('assistantAccess');
            if (store === 'settings' && access && access['settings'] === false) return false;
        }
        const access = settingValue('assistantAccess');
        // If no config yet, default to allow all (so new assistant isn't locked out)
        if (!access) return true;
        const tab = STORE_TO_TAB[store];
        if (tab) {
            if (access[tab] === false) return false;
            // Also deny financial stores if finance tab disabled
            if (FINANCIAL_STORES.has(store) && access['finance'] === false) return false;
            return true;
        }
        if (!FINANCIAL_STORES.has(store)) return true;
        return false;
    }

    // Restricted/legacy roles — never let an unknown role slip through the net
    if (user.role === 'librarian') {
        // Library desk: manage books/borrows; read student names for borrowing only
        if (['books', 'library', 'borrows', 'borrowings', 'bookCategories'].includes(store)) return true;
        if (store === 'students' && method === 'GET') return true;
        return false;
    }
    if (user.role === 'staff' || user.role === 'teacher' || user.role === 'trainer') {
        if (!FINANCIAL_STORES.has(store) && method === 'GET') return true;
        return false;
    }

    // Unknown role: read-only on non-financial stores, never writes, never finance
    if (!FINANCIAL_STORES.has(store) && method === 'GET') return true;

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
// A learner's own assessment scope. The browser narrows the same lists for
// presentation, but this is the authority: a student can read only the
// assessments for their active enrolled courses and their own country,
// region and study center. Table exams need their own registration (or an
// open-window exam deliberately published to all enrolled learners), and the
// same applies to CATs, exams and scheduled quizzes. Ordinary lesson quizzes
// remain course work for every learner enrolled in the course.
function learnerAssessmentContext(user) {
    const sid = serverStudentId(user || {});
    if (!sid) return null;
    const student = (db.students || []).find(s => s && String(s.id) === String(sid))
        || findAlumniForUser(user || {})
        || null;
    if (!student) return null;
    const canonicalId = String(student.studentId || student.id || sid);
    const aliases = studentAliases(user || {});
    aliases.add(String(student.id || ''));
    aliases.add(canonicalId);
    if (student.studentId) aliases.add(String(student.studentId));
    if (student.admissionNumber) aliases.add(String(student.admissionNumber));
    const center = (db.studyCenters || []).find(c => c && String(c.id) === String(student.studyCenterId)) || null;
    const region = (db.regions || []).find(r => r && String(r.id) === String((center && center.regionId) || student.regionId)) || null;
    const enrolledCourseIds = new Set((db.enrollments || [])
        .filter(e => e && aliases.has(String(e.studentId)))
        .map(e => String(e.courseId)));
    // Active alumni access grants are course enrolments too. Invitations do
    // not count until the learner accepts them, and closing a course to alumni
    // closes its grants with it.
    (db.alumniEnrollments || [])
        .filter(g => {
            if (!g || !aliases.has(String(g.studentId)) || !alumniGrantActive(g)) return false;
            const course = (db.courses || []).find(c => c && String(c.id) === String(g.courseId));
            return !!(course && alumniCourseSettings(course).enabled);
        })
        .forEach(g => enrolledCourseIds.add(String(g.courseId)));
    const examRegIds = new Set((db.examRegistrations || [])
        .filter(r => r && aliases.has(String(r.studentId)))
        .map(r => String(r.examId || r.quizId)));
    const quizRegIds = new Set((db.quizRegistrations || [])
        .filter(r => r && aliases.has(String(r.studentId)))
        .map(r => String(r.quizId)));
    const retakeExamIds = new Set((db.retakeRequests || [])
        .filter(r => r && aliases.has(String(r.studentId)) && r.status !== 'rejected')
        .map(r => String(r.examId)));
    const submittedIds = new Set((db.submissions || [])
        .filter(r => r && aliases.has(String(r.studentId)))
        .map(r => String(r.quizId)));
    return {
        studentId: canonicalId,
        student,
        centerId: String(student.studyCenterId || (center && center.id) || ''),
        regionId: String((center && center.regionId) || student.regionId || (region && region.id) || ''),
        country: String(student.country || (center && center.country) || (region && region.country) || ''),
        enrolledCourseIds,
        examRegIds,
        quizRegIds,
        retakeExamIds,
        submittedIds
    };
}
function assessmentInLearnerScope(ctx, rec) {
    if (!ctx || !rec) return false;
    if (rec.studyCenterId && (!ctx.centerId || String(rec.studyCenterId) !== ctx.centerId)) return false;
    if (rec.regionId && (!ctx.regionId || String(rec.regionId) !== ctx.regionId)) return false;
    if (rec.country && (!ctx.country || String(rec.country) !== ctx.country)) return false;
    return true;
}
function isScheduledLearnerAssessment(rec) {
    // opensAt/closesAt is just the availability window of an ordinary course
    // quiz; it does not turn that quiz into a registered sitting. A real
    // scheduled assessment carries a date/time (CATs and exams are handled by
    // their assessment type regardless).
    return !!(rec && (rec.date || rec.time || rec.openWindow));
}
function isCourseworkQuizServer(rec) {
    if (!rec) return false;
    const type = String(rec.assessmentType || '').toLowerCase();
    return (type === 'quiz' || !type) && !isScheduledLearnerAssessment(rec);
}
function filterLearnerAssessments(user, store, rows) {
    const ctx = learnerAssessmentContext(user);
    if (!ctx) return [];
    const activeCourses = new Set((db.courses || [])
        .filter(c => c && c.status !== 'inactive')
        .map(c => String(c.id)));
    return (rows || []).filter(rec => {
        if (!rec || rec.published === false) return false;
        if (!ctx.enrolledCourseIds.has(String(rec.courseId))) return false;
        if (!activeCourses.has(String(rec.courseId))) return false;
        if (!assessmentInLearnerScope(ctx, rec)) return false;
        const id = String(rec.id);
        if (store === 'exams') {
            if (!(rec.openWindow || (rec.date && rec.time))) return false;
            return !!(rec.openWindow || ctx.examRegIds.has(id) || ctx.retakeExamIds.has(id) || ctx.submittedIds.has(id));
        }
        if (store === 'quizzes') {
            if (rec.openWindow) return true;
            if (ctx.quizRegIds.has(id) || ctx.examRegIds.has(id) || ctx.submittedIds.has(id)) return true;
            return isCourseworkQuizServer(rec);
        }
        return false;
    });
}

// Restrict which rows of a store a user may see. Students only ever see their
// own student record and their own login record (users store).
function filterStoreForUser(user, store, rows) {
    if (user && user.role === 'student') {
        const su = user.user || {};
        const uid = String(user.username || '').trim();
        const sid = String(su.studentId || serverStudentId(user) || '').trim();
        const alumniId = String(su.alumniId || '').trim();
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
        // Per-learner records: a student may ONLY ever see their own rows.
        // Grades, submissions, attendance, enrolments and exam/quiz registrations
        // are keyed by studentId and were previously readable by any signed-in
        // student account.
        const LEARNER_OWNED = ['grades', 'submissions', 'attendance', 'enrollments', 'alumniEnrollments',
            'examRegistrations', 'quizRegistrations', 'retakeRequests', 'seating'];
        if (LEARNER_OWNED.includes(store)) {
            const learnerAliases = studentAliases(user);
            return rows.filter(r => r && (String(r.studentId) === sid || String(r.studentId) === uid || learnerAliases.has(String(r.studentId))));
        }
        // Alerts are staff/system notices (they contain other learners' names and
        // reasons). Students must not see the alert log at all.
        if (store === 'alerts' || store === 'lessonFiles') return [];
        if (store === 'courseCompletions') {
            return rows.filter(r => r && (String(r.studentId) === sid || String(r.studentId) === uid));
        }
        if (store === 'feeAgreements') {
            return rows.filter(r => r && (String(r.studentId) === sid || String(r.studentId) === uid));
        }
        if (store === 'waivers') {
            return rows.filter(r => r && (String(r.studentId) === sid || String(r.studentId) === uid));
        }
        if (store === 'lessonUnlocks' || store === 'lessonCompletions') {
            // Drip records are per-learner: a student may only ever see their own.
            return rows.filter(r => r && (String(r.studentId) === sid || String(r.studentId) === uid));
        }
        if (store === 'meetings') {
            return rows.filter(r => r && meetingVisibleTo(user, r));
        }
        if (store === 'alumni') {
            return rows.filter(r => {
                if (!r) return false;
                if (r.studentId && (String(r.studentId) === sid || String(r.studentId) === uid)) return true;
                if (r.id && (String(r.id) === sid || String(r.id) === uid || (alumniId && String(r.id) === alumniId))) return true;
                if (r.userId && String(r.userId) === uid) return true;
                if (r.phone && uidDigits && String(r.phone).replace(/[^0-9]/g,'').slice(-9) === uidDigits) return true;
                if (r.phone && String(r.phone) === uid) return true;
                if (r.email && String(r.email).toLowerCase() === uid.toLowerCase()) return true;
                if (nameLower && r.name && String(r.name).trim().toLowerCase() === nameLower) return true;
                return false;
            });
        }
        // Assessment definitions are shared curriculum, but a learner may only
        // see the requests that belong to them. Registrations alone were already
        // scoped above; the exam/quiz rows that feed the student screens were not.
        if (store === 'exams' || store === 'quizzes') {
            return filterLearnerAssessments(user, store, rows);
        }
    }
    // Country filtering for all authenticated users (except main admin).
    // Main admin (role === 'admin') sees ALL countries - global administrator.
    // Exempt stores that are global or identity-only.
    //
    // NO "generic/untagged" fallback exists anymore. Every record a country
    // coordinator sees must resolve — via its own `country` field, its linked
    // student, its study center, or its region — to EXACTLY the coordinator's
    // scope country. Rows that resolve to NO country (or a different country)
    // are hidden from every coordinator and are visible to the overall admin
    // only, until they are adopted into a country. Stores in
    // GLOBAL_SHARED_STORES are deliberate institution-wide content (shared
    // curriculum, templates, manuals) that has no country identity by design.
    const countryExemptStores = ['users', 'counters', 'sessions', 'maintenanceBypassTokens'];
    // Coordinators may only ever see the payment receipt counters (payment-YYYYMM)
    // they touch while recording payments — never the global staff / other counters.
    if (user && user.role === 'coordinator' && store === 'counters') {
        return rows.filter(r => r && isPaymentCounterKey(r.key));
    }
    if (user && user.user && user.user.role !== 'admin' && !countryExemptStores.includes(store)) {
        // A country-scoped user filters on their own country. A region-scoped
        // coordinator has no country of their own, so their scope is the country
        // their region belongs to — otherwise "scoped per country" would leave
        // regional coordinators reading every country's message logs.
        let scope = user.user.country || '';
        if (!scope && user.user.regionId) {
            const region = (db.regions || []).find(r => r && String(r.id) === String(user.user.regionId));
            scope = (region && region.country) || '';
        }
        if (!scope) return rows;
        if (GLOBAL_SHARED_STORES.has(store)) {
            // Deliberately-shared institution content: no country filtering.
        } else if (store === 'messages') {
            // Staff-to-staff messages: your own threads always stay visible even
            // when the other party sits in another country, otherwise a Kenya
            // coordinator could not read a message sent to them by Togo.
            const me = String(user.username || (user.user && user.user.username) || '');
            rows = rows.filter(r => r && (r.sender === me || r.recipient === me || recordCountryOf(store, r) === scope));
        } else {
            rows = rows.filter(r => r && recordCountryOf(store, r) === scope);
        }
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
        fs.writeFileSync(SESSION_FILE, JSON.stringify(arr), 'utf8');
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

// A password change or reset is a security event: every OTHER device that was
// signed in as that account must sign in again with the new password. The
// caller's own request can be kept (the user just proved the password) and so
// can the owner's, so a bulk reset never locks the owner out mid-operation.
function revokeUserSessions(username, keepToken) {
    const uname = String(username || '').toLowerCase();
    if (!uname) return 0;
    let revoked = 0;
    for (const [token, s] of sessions) {
        if (!s || String(s.username || '').toLowerCase() !== uname) continue;
        if (keepToken && token === keepToken) continue;
        sessions.delete(token);
        revoked++;
    }
    if (revoked) { try { saveSessions(); } catch (e) { console.error('saveSessions failed:', e.message); } }
    return revoked;
}
function requestToken(req) {
    const auth = (req && req.headers && req.headers['authorization']) || '';
    let token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) { try { token = parseCookies(req).session || ''; } catch {} }
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
try { const n = restoreDocsFromVolume(); if (n) console.log('restoreDocsFromVolume: restored', n, 'doc files from volume'); } catch (e) { console.error('restoreDocsFromVolume failed:', e.message); }
try { const n = stripStoredInlineBlobs(); if (n) console.log('stripStoredInlineBlobs: stripped inline bytes from', n, 'records'); } catch (e) { console.error('stripStoredInlineBlobs failed:', e.message); }

// Brute-force protection for /api/login
const loginAttempts = new Map(); // ip -> { count, windowStart, blockedUntil }
// Throttle for the public login-country smart-filter (per IP, per minute).
// Lookups never count as login attempts and never create sessions.
const loginCountryHits = new Map(); // ip -> { count, windowStart }
const LOGIN_COUNTRY_MAX = parseInt(process.env.LOGIN_COUNTRY_MAX) || 60;
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

// ---- Security & integrity layer ----
// The served code files (index.html, manuals, css/*.css, js/*.js) are hashed at
// boot into a baseline. A routine watchdog re-hashes them: any file that no
// longer matches the boot baseline is BLOCKED from being served (HTTP 403) and
// raises a severe admin alert + audit + WhatsApp push until an admin rebaselines
// or restores it. The baseline is re-taken on every server start (a restart is a
// fresh, trusted code deployment), so the watchdog catches runtime tampering
// while the process is alive.
const SECURITY_DB_FILE = path.join(DATA_ROOT, 'integrity.json');
const SECURE = {
    manifest: null,             // { version, createdAt, updatedAt, files: { rel: sha } }
    blockedFiles: new Set(),    // absolute paths currently withheld from serving
    blockedAnnounced: new Set(),// rel paths with an already-announced tamper alert (dedupe)
    lastCheck: null,
    candidates: [],             // current cleanup candidates (server memory)
    candidatesAt: null,
    checking: false
};
function trackedCodeFiles() {
    const out = [];
    try {
        const push = f => { if (f && /\.(js|css|html)$/i.test(f)) out.push(path.resolve(f)); };
        push(path.join(ROOT, 'index.html'));
        push(path.join(ROOT, 'maintenance.html'));
        push(path.join(ROOT, 'student-manual.html'));
        push(path.join(ROOT, 'coordinator-manual.html'));
        push(path.join(ROOT, 'admin-manual.html'));
        push(path.join(ROOT, 'assistant-admin-manual.html'));
        push(path.join(ROOT, 'staff-manual.html'));
        for (const dir of ['css', 'js']) {
            const full = path.join(ROOT, dir);
            if (!fs.existsSync(full)) continue;
            for (const name of fs.readdirSync(full)) {
                if (/\.(js|css|html)$/i.test(name)) push(path.join(full, name));
            }
        }
    } catch (e) { console.error('trackedCodeFiles failed:', e.message); }
    return out;
}
function sha256File(file) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
    catch { return null; }
}
// Helper for use inside handleAPI where the module-level `path` is shadowed by
// the URL pathname variable of the same name.
function relTracked(absPath) {
    return path.relative(ROOT, absPath).split('\\').join('/');
}
function loadIntegrityManifest() {
    try { SECURE.manifest = JSON.parse(fs.readFileSync(SECURITY_DB_FILE, 'utf8')); }
    catch { SECURE.manifest = null; }
}
function saveIntegrityManifest() {
    try {
        fs.writeFileSync(SECURITY_DB_FILE, JSON.stringify(SECURE.manifest, null, 2), 'utf8');
        try { if (fs.existsSync(SECURITY_DB_FILE) && DATA_ROOT !== '/data') fs.copyFileSync(SECURITY_DB_FILE, path.join('/data', 'integrity.json')); } catch {}
    } catch (e) { console.error('saveIntegrityManifest failed:', e.message); }
}
function createIntegrityBaseline() {
    const oldFiles = SECURE.manifest && SECURE.manifest.files ? SECURE.manifest.files : null;
    const manifest = { version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), files: {} };
    for (const f of trackedCodeFiles()) {
        const h = sha256File(f);
        if (h) manifest.files[path.relative(ROOT, f).split('\\').join('/')] = h;
    }
    if (oldFiles) {
        const changed = [];
        for (const rel of Object.keys(manifest.files)) {
            if (oldFiles[rel] && oldFiles[rel] !== manifest.files[rel]) changed.push(rel);
        }
        if (changed.length) {
            console.log('Baseline changed across restart (expected on deploy):', changed.length, 'file(s)');
            for (const rel of changed.slice(0, 10)) { try { auditLog('baseline-changed', 'security', { file: rel }, 'system'); } catch (e) {} }
        }
    }
    SECURE.manifest = manifest;
    SECURE.blockedFiles.clear();
    SECURE.blockedAnnounced.clear();
    saveIntegrityManifest();
    console.log('Integrity baseline:', Object.keys(manifest.files).length, 'files');
}
// Push a WhatsApp + whatsappLog record to the configured admin number for severe events.
function notifyAdminSecurity(title, details) {
    try {
        const rec = (db.settings || []).find(s => s.key === 'whatsapp');
        const adminNumber = rec && rec.adminNumber ? String(rec.adminNumber).trim() : '';
        if (adminNumber) {
            if (!db.whatsappLog) db.whatsappLog = [];
            db.whatsappLog.push({
                id: 'SEC-WA-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
                phone: adminNumber, name: 'Admin', template: 'security',
                message: '🔐 ' + title + ' — ' + details,
                date: new Date().toISOString().slice(0, 10), time: new Date().toISOString().slice(11, 19),
                createdAt: new Date().toISOString()
            });
            saveDB();
            broadcastEvent('db-change', { store: 'whatsappLog' });
            broadcastEvent('security-push', { phone: adminNumber, title, details });
        }
    } catch (e) { console.error('notifyAdminSecurity failed:', e.message); }
}
function runIntegrityCheck() {
    if (SECURE.checking) return;
    SECURE.checking = true;
    try {
        if (!SECURE.manifest) return;
        const files = trackedCodeFiles();
        const now = new Date().toISOString();
        for (const f of files) {
            const rel = path.relative(ROOT, f).split('\\').join('/');
            const expected = SECURE.manifest.files[rel];
            if (!expected) continue;
            const h = sha256File(f);
            if (h && h !== expected) {
                SECURE.blockedFiles.add(path.resolve(f));
                if (!SECURE.blockedAnnounced.has(rel)) {
                    SECURE.blockedAnnounced.add(rel);
                    try {
                        if (!db.alerts) db.alerts = [];
                        if (!db.alerts.some(a => a.ruleId === 'sec-file-tamper' && a.entityId === rel && a.status === 'active')) {
                            db.alerts.push({
                                id: 'ALERT-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
                                ruleId: 'sec-file-tamper', entityId: rel, type: 'danger', severity: 'severe',
                                title: '⚠ Code file tampered',
                                message: rel + ' no longer matches the approved baseline. The file is now blocked from being served with HTTP 403 until an administrator rebaselines or restores it.',
                                createdAt: now, read: false, status: 'active'
                            });
                            saveDB();
                            broadcastEvent('db-change', { store: 'alerts' });
                        }
                        auditLog('file-tamper-detected', 'security', { file: rel }, 'system');
                        notifyAdminSecurity('Code file tampered', rel + ' was modified outside the approved baseline and is now blocked from serving.');
                    } catch (e) { console.error('tamper alert failed:', e.message); }
                }
            }
        }
        SECURE.lastCheck = now;
    } catch (e) { console.error('runIntegrityCheck failed:', e.message); }
    SECURE.checking = false;
}
// Routine cleanup: gather candidates (with consent rules).
//  - alerts: status 'resolved' (responded/seen) or older than 45 days
//  - messages: read messages the recipient has since replied to (responded), or read older than 30 days
//  - tickets: closed/resolved tickets older than 14 days
// Nothing is deleted here — each candidate must be explicitly confirmed by an admin.
function collectCleanupCandidates() {
    try {
        const nowTs = Date.now();
        const day = 86400000;
        const candidates = [];
        const seen = new Set();
        const add = (store, id, kind, label, when) => {
            if (!id || seen.has(store + ':' + id)) return;
            seen.add(store + ':' + id);
            candidates.push({ store, id, kind, label: String(label || '').slice(0, 200), at: when || new Date(nowTs).toISOString() });
        };
        for (const a of (db.alerts || [])) {
            const created = a.createdAt ? Date.parse(a.createdAt) : 0;
            if (a.status === 'resolved' || (created && nowTs - created > 45 * day)) {
                add('alerts', a.id, 'alert', (a.title || a.message || a.id).slice(0, 90), a.createdAt);
            }
        }
        const msgs = db.messages || [];
        for (const m of msgs) {
            if (!m || !m.id || !m.sender || !m.recipient || !m.read) continue;
            const mt = Date.parse(m.timestamp || m.createdAt || 0) || 0;
            const replied = msgs.some(m2 => m2 && m2.sender === m.recipient && m2.recipient === m.sender && ((Date.parse(m2.timestamp || m2.createdAt || 0)) || 0) > mt);
            if (replied || (mt && nowTs - mt > 30 * day)) {
                add('messages', m.id, 'message', (m.message || m.text || m.content || '').toString().slice(0, 90) || m.id, m.timestamp || m.createdAt);
            }
        }
        for (const t of (db.tickets || [])) {
            if (!t || !t.id) continue;
            const isClosed = /closed|resolved|answered|complete/i.test(String(t.status || ''));
            const tTime = Date.parse(t.updatedAt || t.createdAt || 0) || 0;
            if (isClosed && tTime && nowTs - tTime > 14 * day) {
                add('tickets', t.id, 'ticket', (t.subject || t.title || t.id).toString().slice(0, 90), t.updatedAt || t.createdAt);
            }
        }
        SECURE.candidates = candidates;
        SECURE.candidatesAt = new Date(nowTs).toISOString();
        return candidates;
    } catch (e) { console.error('collectCleanupCandidates failed:', e.message); return []; }
}
function announceCleanupCandidates() {
    try {
        const c = collectCleanupCandidates();
        broadcastEvent('cleanup-candidates', { count: c.length, at: SECURE.candidatesAt });
    } catch (e) {}
}
// Apply ADMIN-CONFIRMED deletions only. Unconfirmed candidates are untouched.
function applyCleanupConfirmations(confirmations) {
    const results = { ok: 0, errors: [], remaining: 0 };
    try {
        const byStore = {};
        for (const c of (confirmations || [])) {
            if (!c || !c.store || !c.id) { results.errors.push({ error: 'Missing store/id' }); continue; }
            if (!byStore[c.store]) byStore[c.store] = [];
            byStore[c.store].push(String(c.id));
        }
        const KEY_PATHS = { settings: 'key', counters: 'key', users: 'username', transcriptVerifications: 'docId', manuals: 'id' };
        for (const store of Object.keys(byStore)) {
            const arr = db[store];
            if (!Array.isArray(arr)) { results.errors.push({ store, error: 'Unknown store' }); continue; }
            const keyPath = KEY_PATHS[store] || 'id';
            const ids = byStore[store];
            let changed = false;
            for (let i = arr.length - 1; i >= 0; i--) {
                const rec = arr[i];
                if (!rec) continue;
                const pk = String(rec[keyPath] || rec.id || '');
                if (ids.indexOf(pk) >= 0) { arr.splice(i, 1); results.ok++; changed = true; }
            }
            if (changed) {
                try {
                    broadcastEvent('db-change', { store });
                    saveDB();
                    auditLog('cleanup-confirmed', store, { deleted: results.ok }, 'system');
                } catch (e) { console.error('cleanup save failed:', e.message); }
            }
        }
    } catch (e) { console.error('applyCleanupConfirmations failed:', e.message); }
    SECURE.candidates = collectCleanupCandidates();
    results.remaining = SECURE.candidates.length;
    try { broadcastEvent('cleanup-candidates', { count: SECURE.candidates.length, at: SECURE.candidatesAt }); } catch {}
    return results;
}
// Strip ASCII control characters (except tab/newline) and cap field length on
// anything written into the DB, to blunt injection / corruption attempts.
// Pass `preserve` (array of top-level keys) to skip the LENGTH cap for those
// fields only (control chars are still stripped). Documents carry long HTML
// content (transcripts ~99KB, letters embed logo/signatures as base64) and were
// being silently truncated mid-tag, which is why generated documents broke.
function sanitizeBodyFields(obj, maxLen, preserve) {
    if (!obj || typeof obj !== 'object') return obj;
    const cap = maxLen || 20000;
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === 'string') {
            const clean = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
            const isPreserved = !!(preserve && preserve.includes(k));
            // Data URIs and raw base64 of images/PDFs (signature images, logos,
            // templates) must never be length-capped at ANY nesting depth — a
            // truncated blob silently breaks or hangs every document that embeds it.
            const isBinaryBlob = clean.length > cap && (/^data:/i.test(clean) || /^(iVBORw0KGgo|JVBERi0|\/9j\/)/.test(clean));
            obj[k] = (isPreserved || isBinaryBlob) ? clean : clean.slice(0, cap);
        } else if (v && typeof v === 'object' && !Buffer.isBuffer(v)) {
            sanitizeBodyFields(v, cap, preserve);
        }
    }
    return obj;
}

// Branding images (logo + signature fields) and PDF templates should never be
// length-capped the same way normal settings strings are; a truncated base64
// silently breaks every letter/certificate or diploma that embeds it.
function brandingImageKeys(rec) {
    const holder = rec && rec.value && typeof rec.value === 'object' ? rec.value : (rec || null);
    if (!holder) return [];
    const keys = Object.keys(holder).filter(k => k === 'logo' || k === 'logoDark' || k === 'receiptLogo' || k.indexOf('sig') === 0 || k.toLowerCase().includes('logo') || k === 'template');
    // Always preserve the PDF template field for diploma/completion configs
    if (rec && rec.key && SETTINGS_BLOBS[rec.key] && !keys.includes(SETTINGS_BLOBS[rec.key])) keys.push(SETTINGS_BLOBS[rec.key]);
    return keys;
}
// Boot + watchdog: fresh restart = fresh trust baseline (a legit deploy), then
// the 15-minute watchdog blocks any runtime tampering while the process lives.
try { loadIntegrityManifest(); } catch (e) {}
try { createIntegrityBaseline(); } catch (e) { console.error('integrity baseline failed:', e.message); }
setTimeout(() => { try { runIntegrityCheck(); } catch (e) {} }, 5000);
setInterval(() => { try { runIntegrityCheck(); } catch (e) {} }, 15 * 60 * 1000);
setTimeout(() => { try { announceCleanupCandidates(); } catch (e) {} }, 12000);
setInterval(() => { try { announceCleanupCandidates(); } catch (e) {} }, 30 * 60 * 1000);

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

// Create the owner account (once) and warn about secrets stored in the
// clear. Both run before the server accepts traffic.
try { bootstrapOwner(); } catch (e) { process.stderr.write('OWNER_BOOTSTRAP failed: ' + (e && e.message) + '\n'); }
if (!ENC_KEY) {
    const plain = [];
    for (const rec of (db.settings || [])) {
        const v = rec ? (rec.value || rec) : null;
        if (v && typeof v === 'object' && (v.consumerSecret || v.passkey || v.apiKey)) plain.push(rec.key);
    }
    if (plain.length) {
        process.stderr.write('SECURITY_WARNING: DATA_ENCRYPTION_KEY is not set, so these settings hold secrets in the clear: ' + plain.join(', ') + '\n');
    }
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

// The college's public contact number. One place decides what the login
// screen, the public-contact endpoint and every other surface show, so the
// screens can never disagree with each other.
function getContactPhone() {
    const settings = db.settings || [];
    const branding = settings.find(s => s.key === 'branding');
    const bVal = branding && (branding.value && typeof branding.value === 'object' ? branding.value : branding);
    let raw = bVal && bVal.phone ? String(bVal.phone) : '';
    if (!raw.trim()) {
        const wa = settings.find(s => s.key === 'whatsapp');
        const wVal = wa && (wa.value && typeof wa.value === 'object' ? wa.value : wa);
        raw = wVal && (wVal.adminNumber || wVal.phone) ? String(wVal.adminNumber || wVal.phone) : '';
    }
    return normaliseContactPhone(raw);
}
// 0713824567 -> +254713824567 (same rule the client applies)
function normaliseContactPhone(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    const digits = s.replace(/[^0-9]/g, '');
    if (!digits) return '';
    if (s.startsWith('+')) return '+' + digits;
    if (digits.startsWith('254')) return '+' + digits;
    if (digits.startsWith('0')) return '+254' + digits.substring(1);
    return '+' + digits;
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
const _mpesaTokenInFlight = new Map(); // key -> Promise so concurrent pushes share one fetch
async function mpesaToken(env, key, secret) {
    const cacheKey = env + '|' + key;
    const cached = _mpesaTokenCache.get(cacheKey);
    if (cached && cached.expires > Date.now() + 60000) return cached.token;
    if (_mpesaTokenInFlight.has(cacheKey)) return _mpesaTokenInFlight.get(cacheKey);
    const isSandbox = env === 'sandbox';
    const baseURL = isSandbox ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';
    const auth = Buffer.from(key + ':' + secret).toString('base64');
    const fetching = new Promise((resolve, reject) => {
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
                    _mpesaTokenInFlight.delete(cacheKey);
                    resolve(j.access_token);
                } catch {
                    const title = (String(data).match(/<title[^>]*>([^<]*)/i) || [])[1] || 'no-title';
                    try { process.stderr.write('DARAJA_BLOCKED status=' + res.statusCode + ' server=' + (res.headers.server || '?') + ' via=' + (res.headers.via || '?') + ' title=' + title + ' url=' + u.hostname + '\n'); } catch {}
                    _mpesaTokenInFlight.delete(cacheKey);
                    reject('Token fetch failed (HTTP ' + res.statusCode + ' from ' + (res.headers.server || 'unknown') + ' via ' + (res.headers.via || 'unknown') + ' title=' + title + '). Safaricom is blocking the server network — see Railway logs DARAJA_BLOCKED.');
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
    _mpesaTokenInFlight.set(cacheKey, fetching);
    try { return await fetching; } finally { _mpesaTokenInFlight.delete(cacheKey); }
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
        // The health probe is public (Railway healthcheck + the client's
        // "server reachable" check), so it only ever carries the liveness
        // facts. Stream diagnostics are for signed-in staff only.
        const payload = {
            status: 'ok',
            uptime: process.uptime(),
            mpesaConfigured
        };
        const hUser = getRequestUser(req);
        if (hUser) {
            // `sse`/`lastBroadcast` are diagnostics for the live-update stream.
            payload.sse = sseClients.length;
            payload.sseWritable = sseClients.filter(c => c.res && !c.res.writableEnded && !c.res.destroyed).length;
            payload.lastBroadcast = __lastBroadcast;
        }
        return json(res, 200, payload);
    }

    // GET /api/session — session health: who the server thinks you are.
    // 200 { authenticated, user } or 401. Lets the client detect dead sessions
    // (restart/expired) and force a clean re-login instead of failing writes.
    // Returns only the caller's own identity. Strictly read-only.
    if (parts.length === 2 && parts[1] === 'session' && req.method === 'GET') {
        const su = getRequestUser(req);
        if (!su) return json(res, 401, { error: 'Not authenticated' });
        return json(res, 200, { authenticated: true, user: {
            username: su.username, role: su.role, country: (su.user && su.user.country) || '',
            accountType: (su.user && su.user.accountType) || 'student',
            alumniId: (su.user && su.user.alumniId) || '',
            studentId: (su.user && su.user.studentId) || ''
        } });
    }

    // GET /api/events â€” SSE stream for real-time updates (authenticated only)
    if (parts.length === 2 && parts[1] === 'events' && req.method === 'GET') {
        const qUser = sessionUserForToken(urlObj.searchParams.get('token'));
        const hUser = getSessionUser(req);
        if (!qUser && !hUser) return json(res, 401, { error: 'Not authenticated' });
        const sseHeaders = {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        };
        if (res.__corsOrigin) { sseHeaders['Access-Control-Allow-Origin'] = res.__corsOrigin; sseHeaders['Vary'] = 'Origin'; }
        res.writeHead(200, sseHeaders);
        res.write('\n');
        // Register the client IMMEDIATELY, using only values already resolved
        // above. This line used to read `user` — a name that does not exist in
        // this scope — so it threw a ReferenceError *after* the 200 headers had
        // already been sent. The throw was swallowed by the outer handler, the
        // browser saw a healthy open stream, and sseClients stayed permanently
        // empty: every broadcastEvent() delivered to 0 clients, so live updates
        // never arrived anywhere in the app. qUser/hUser are the session objects
        // ({ username, role, user }) that broadcastPrivateChange() filters on.
        const client = { res, id: Date.now(), user: qUser || hUser || null };
        sseClients.push(client);
        process.stderr.write('[sse] client registered: ' + (client.user && client.user.username || 'anon') + ' total=' + sseClients.length + '\n');
        const keepalive = setInterval(() => {
            if (!res.writableEnded) res.write(': keepalive\n\n');
            else clearInterval(keepalive);
        }, 15000);
        // Deregister on the RESPONSE closing, never on `req`. On current Node the
        // request stream for a bodyless GET completes immediately, so `req`'s
        // close event fires right away and used to remove this client from
        // sseClients milliseconds after it was added. The stream stayed open in
        // the browser while every broadcastEvent() found an empty list, so live
        // updates silently never arrived.
        res.on('close', () => {
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

    // Country self-service (coordinator-only, scoped to their OWN country):
    //   GET /api/country/:name/self  — branding + postal identity for the country
    //   PUT /api/country/:name/self  — update ONLY postalAddress + phone of the
    //                                  country's own record. Never touches the
    //                                  global settings fence, other countries,
    //                                  branding keys, or any other store.
    if (parts.length === 4 && parts[1] === 'country' && parts[3] === 'self') {
        const name = decodeURIComponent(parts[2]);
        const user = getRequestUser(req);
        if (!name) return json(res, 400, { error: 'Country name required' });
        if (req.method === 'GET') {
            // Any authenticated user may read their own country's brand identity
            // (cosmetic — same content anonymous visitors already see on the
            // login page brand name). Non-admins may only read their OWN country.
            if (!user) return json(res, 403, { error: 'Not authenticated' });
            const countriesSetting = (db.settings || []).find(s => s.key === 'countries');
            const countries = countriesSetting ? (countriesSetting.value || countriesSetting) : [];
            const entry = (Array.isArray(countries) ? countries : []).find(c => c && c.name === name) || null;
            if (!entry) return json(res, 404, { error: 'Country not found' });
            if (user.role !== 'admin' && !(user.role === 'coordinator' && countryScopeOf(user) === name)) {
                return json(res, 403, { error: 'You may only read your own country' });
            }
            return json(res, 200, { brandName: entry.brandName || name, initials: entry.initials || '', phone: entry.phone || '', postalAddress: entry.postalAddress || '', currencyCode: entry.currencyCode || '', currencySymbol: entry.currencySymbol || '', currencyDecimals: entry.currencyDecimals != null ? entry.currencyDecimals : 2 });
        }
        if (req.method === 'PUT') {
            // Strict: coordinators may edit ONLY their own country's postal
            // identity. Admins may edit any. No other fields are ever accepted.
            if (!user) return json(res, 403, { error: 'Not authenticated' });
            const isOwn = user.role === 'admin' || (user.role === 'coordinator' && countryScopeOf(user) === name);
            if (!isOwn) return json(res, 403, { error: 'You may only update your own country' });
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    const postalAddress = parsed && typeof parsed.postalAddress === 'string' ? parsed.postalAddress.trim().slice(0, 500) : undefined;
                    const phone = parsed && typeof parsed.phone === 'string' ? parsed.phone.trim().slice(0, 50) : undefined;
                    const currencyCode = parsed && typeof parsed.currencyCode === 'string' ? parsed.currencyCode.trim().toUpperCase().slice(0, 5) : undefined;
                    const currencySymbol = parsed && typeof parsed.currencySymbol === 'string' ? parsed.currencySymbol.trim().slice(0, 10) : undefined;
                    let currencyDecimals = undefined;
                    if (parsed && parsed.currencyDecimals !== undefined) {
                        const decimals = parseInt(parsed.currencyDecimals);
                        currencyDecimals = isFinite(decimals) ? Math.max(0, Math.min(4, decimals)) : 2;
                    }
                    if (postalAddress === undefined && phone === undefined && currencyCode === undefined && currencySymbol === undefined && currencyDecimals === undefined) {
                        return json(res, 400, { error: 'Nothing to update (postalAddress, phone, currencyCode, currencySymbol, currencyDecimals)' });
                    }
                    const countriesSetting = (db.settings || []).find(s => s.key === 'countries');
                    const countries = countriesSetting ? (countriesSetting.value || countriesSetting) : [];
                    const entry = (Array.isArray(countries) ? countries : []).find(c => c && c.name === name);
                    if (!entry) return json(res, 404, { error: 'Country not found' });
                    if (postalAddress !== undefined) entry.postalAddress = postalAddress;
                    if (phone !== undefined) entry.phone = phone;
                    if (currencyCode !== undefined) entry.currencyCode = currencyCode;
                    if (currencySymbol !== undefined) entry.currencySymbol = currencySymbol;
                    if (currencyDecimals !== undefined) entry.currencyDecimals = currencyDecimals;
                    auditLog('updated', 'country-self', { name, fields: Object.keys(parsed).filter(k => k === 'postalAddress' || k === 'phone' || k === 'currencyCode' || k === 'currencySymbol' || k === 'currencyDecimals') });
                    saveDB();
                    broadcastEvent('db-change', { store: 'settings' });
                    return json(res, 200, { ok: true, postalAddress: entry.postalAddress, phone: entry.phone, currencyCode: entry.currencyCode, currencySymbol: entry.currencySymbol, currencyDecimals: entry.currencyDecimals });
                } catch (e) { json(res, 400, { error: 'Invalid JSON' }); }
            });
            return true;
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // GET /api/countries — public list of configured countries (no auth)
    if (parts.length === 2 && parts[1] === 'countries' && req.method === 'GET') {
        const countriesSetting = (db.settings || []).find(s => s.key === 'countries');
        const countries = countriesSetting ? (countriesSetting.value || countriesSetting) : [];
        return json(res, 200, { countries: Array.isArray(countries) ? countries : [] });
    }

    // POST /api/countries — add a country (admin only)
    if (parts.length === 2 && parts[1] === 'countries' && req.method === 'POST') {
        const user = getRequestUser(req);
        if (!user || user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { name, code, brandName, initials, phone, postalAddress, currencyCode, currencySymbol, currencyDecimals } = JSON.parse(body);
                if (!name) return json(res, 400, { error: 'Country name required' });
                const countriesSetting = (db.settings || []).find(s => s.key === 'countries');
                const countries = countriesSetting ? (countriesSetting.value || countriesSetting) : [];
                if (countries.find(c => c.name === name || c.code === code)) return json(res, 400, { error: 'Country already exists' });
                const decimals = parseInt(currencyDecimals);
                const entry = { name, code: code || name.toUpperCase().replace(/\s+/g, '-'), brandName: brandName || name, initials: initials || name.substring(0, 2).toUpperCase(), phone: phone || '', postalAddress: postalAddress || '', currencyCode: (currencyCode || '').trim().toUpperCase(), currencySymbol: (currencySymbol || '').trim(), currencyDecimals: isFinite(decimals) ? Math.max(0, Math.min(4, decimals)) : 2 };
                db.settings = db.settings || [];
                if (!countriesSetting) {
                    db.settings.push({ key: 'countries', value: [entry] });
                } else {
                    countriesSetting.value = [...countries, entry];
                }
                auditLog('created', 'country', { name }); saveDB();
                json(res, 200, { ok: true, country: entry });
            } catch (e) { json(res, 400, { error: 'Invalid JSON' }); }
        });
        return true;
    }

    // DELETE /api/countries/:name — remove a country (admin only)
    if (parts.length >= 3 && parts[1] === 'countries' && req.method === 'DELETE') {
        const user = getRequestUser(req);
        if (!user || user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
        const name = decodeURIComponent(parts[2]);
        const countriesSetting = (db.settings || []).find(s => s.key === 'countries');
        if (countriesSetting) {
            const countries = countriesSetting.value || [];
            if (!countries.find(c => c.name === name)) return json(res, 404, { error: 'Country not found' });
            countriesSetting.value = countries.filter(c => c.name !== name);
            auditLog('deleted', 'country', { name }); saveDB();
        }
        return json(res, 200, { ok: true });
    }

    // PUT /api/countries/:name — update an existing country (admin only).
    // Accepts optional brandName, initials, phone, postalAddress, and per-country
    // currency settings (currencyCode, currencySymbol, currencyDecimals).
    if (parts.length >= 3 && parts[1] === 'countries' && req.method === 'PUT') {
        const user = getRequestUser(req);
        if (!user || user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
        const name = decodeURIComponent(parts[2]);
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body);
                const countriesSetting = (db.settings || []).find(s => s.key === 'countries');
                const countries = countriesSetting ? (countriesSetting.value || countriesSetting) : [];
                const entry = (Array.isArray(countries) ? countries : []).find(c => c && c.name === name);
                if (!entry) return json(res, 404, { error: 'Country not found' });
                if (parsed.brandName !== undefined) entry.brandName = String(parsed.brandName).trim().slice(0, 120) || entry.brandName;
                if (parsed.initials !== undefined) entry.initials = String(parsed.initials).trim().toUpperCase().slice(0, 4);
                if (parsed.phone !== undefined) entry.phone = String(parsed.phone).trim().slice(0, 50);
                if (parsed.postalAddress !== undefined) entry.postalAddress = String(parsed.postalAddress).trim().slice(0, 500);
                if (parsed.currencyCode !== undefined) entry.currencyCode = String(parsed.currencyCode).trim().toUpperCase().slice(0, 5);
                if (parsed.currencySymbol !== undefined) entry.currencySymbol = String(parsed.currencySymbol).trim().slice(0, 10);
                if (parsed.currencyDecimals !== undefined) {
                    const decimals = parseInt(parsed.currencyDecimals);
                    entry.currencyDecimals = isFinite(decimals) ? Math.max(0, Math.min(4, decimals)) : 2;
                }
                auditLog('updated', 'country', { name }); saveDB();
                json(res, 200, { ok: true, country: entry });
            } catch (e) { json(res, 400, { error: 'Invalid JSON' }); }
        });
        return true;
    }

    // POST /api/adopt — adopt an otherwise-unresolvable record into a country.
    // Admin only. Every student must fit in a country, region and study center;
    // untagged rows are hidden from every country coordinator until adopted.
    // For STUDENTS the adoption picks the country's study center (a supplied
    // studyCenterId wins, else the first center whose country resolves to the
    // target), stamps country+regionId+studyCenterId, and REGENERATES the
    // admission number in that country's format: NF/{CENTERCODE}/{MM}-{YY}/{SEQ}
    // using the country-wide roll so the new number never collides. For any
    // other store it simply stamps `country` on the record so it resolves.
    if (parts.length === 2 && parts[1] === 'adopt' && req.method === 'POST') {
        const user = getRequestUser(req);
        if (!user || user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { store, id, country, studyCenterId } = JSON.parse(body);
                if (!store || !id) return json(res, 400, { error: 'store and id required' });
                if (!country) return json(res, 400, { error: 'country required' });
                if (!Array.isArray(db[store])) return json(res, 404, { error: 'Unknown store' });
                const countryExists = ((db.settings || []).find(s => s.key === 'countries') || { value: [] }).value || [];
                if (!(Array.isArray(countryExists) ? countryExists : []).some(c => c && c.name === country)) {
                    return json(res, 400, { error: 'Country not configured: ' + country });
                }
                const rec = db[store].find(r => r && String(r.id) === String(id));
                if (!rec) return json(res, 404, { error: 'Record not found' });
                const idx = db[store].findIndex(r => r && String(r.id) === String(id));
                if (store === 'students') {
                    // Pick the study center for the target country.
                    let center = null;
                    if (studyCenterId) center = (db.studyCenters || []).find(c => c && String(c.id) === String(studyCenterId)) || null;
                    if (center && (center.country || ((center.regionId && (db.regions || []).find(r2 => r2.id === center.regionId) || {}).country)) !== country) center = null;
                    if (!center) {
                        const idx2 = buildCountryIndex();
                        center = (db.studyCenters || []).find(c => c && String(idx2.centerCountry[c.id] || c.country || '') === country) || null;
                    }
                    const centerCode = center && center.code ? String(center.code).trim().replace(/\//g,'') : (center && center.name ? (String(center.name).toUpperCase().replace(/[^A-Z0-9]/g,' ').trim().split(/\s+/).filter(Boolean).slice(0,2).map((p,i)=>p[0]).join('').substring(0,4) || 'CTR') : 'CTR');
                    const branding = (db.settings || []).find(s => s.key === 'branding');
                    const instituteCode = branding && branding.initials ? branding.initials : 'NF';
                    const prevCountry = rec.country || (rec.studyCenterId && buildCountryIndex().centerCountry[rec.studyCenterId]) || '';
                    // Country-wide sequence, mirrors the public signup path.
                    const counterKey = 'admissionLastSeqByCountry';
                    let counterRec = (db.settings || []).find(s => s.key === counterKey);
                    const cObj = counterRec && counterRec.value && typeof counterRec.value === 'object' ? counterRec.value : {};
                    let admSeq = typeof cObj[country] === 'number' ? cObj[country] : 0;
                    let maxSeq = 0;
                    (db.students || []).forEach(s => {
                        if (!s) return;
                        const sc = s.studyCenterId ? (db.studyCenters || []).find(c2 => c2 && String(c2.id) === String(s.studyCenterId)) : null;
                        const sCountry = s.country || (sc && sc.country) || '';
                        if (sCountry !== country) return;
                        if (s.admissionNumber && typeof s.admissionNumber === 'string') {
                            const segs = s.admissionNumber.split('/');
                            const n = parseInt(segs[segs.length - 1], 10);
                            if (!isNaN(n) && n > maxSeq) maxSeq = n;
                        }
                    });
                    const nextSeq = Math.max(admSeq, maxSeq) + 1;
                    cObj[country] = nextSeq;
                    if (!counterRec) {
                        db.settings = db.settings || [];
                        db.settings.push({ key: counterKey, value: cObj });
                    } else {
                        counterRec.value = cObj;
                    }
                    const year = new Date().getFullYear().toString().slice(-2);
                    const month = String(new Date().getMonth() + 1).padStart(2, '0');
                    const seqStr = String(nextSeq).padStart(3, '0');
                    const admissionNumber = `${instituteCode}/${centerCode}/${month}-${year}/${seqStr}`;
                    const updated = Object.assign({}, rec, {
                        country,
                        studyCenterId: center ? center.id : (rec.studyCenterId || ''),
                        regionId: center && center.regionId ? center.regionId : (rec.regionId || ''),
                        admissionNumber,
                        updatedAt: new Date().toISOString()
                    });
                    db[store][idx] = updated;
                    auditLog('adopted', 'student', { id, country, studyCenterId: updated.studyCenterId, admissionNumber, prevCountry });
                    invalidateCountryIndex();
                    saveDB();
                    broadcastEvent('db-change', { store });
                    return json(res, 200, { ok: true, admissionNumber, studyCenterId: updated.studyCenterId, country });
                }
                // Generic non-student adoption: just stamp the country so the
                // record resolves into that country's scope.
                const updated = Object.assign({}, rec, { country, updatedAt: new Date().toISOString() });
                db[store][idx] = updated;
                auditLog('adopted', store, { id, country });
                invalidateCountryIndex();
                saveDB();
                broadcastEvent('db-change', { store });
                return json(res, 200, { ok: true, country });
            } catch (e) { json(res, 400, { error: 'Invalid request: ' + (e && e.message) }); }
        });
        return true;
    }

    // GET /api/login-country?input=... — smart-filter helper for the login screen.
    // Returns ONLY { country: <name> | null }: the configured country bound to this
    // login identifier, if any. Unknown identifiers, unbound accounts and admin
    // accounts are indistinguishable (all null), so it cannot enumerate accounts.
    // Strictly read-only: never writes, never creates sessions, never audits.
    if (parts.length === 2 && parts[1] === 'login-country' && req.method === 'GET') {
        if (loginRateBlocked(req)) return json(res, 429, { error: 'Too many attempts. Please try again later.' });
        const lip = clientIp(req);
        const nowLc = Date.now();
        let recLc = loginCountryHits.get(lip);
        if (!recLc || nowLc - recLc.windowStart > 60000) recLc = { count: 0, windowStart: nowLc };
        recLc.count++;
        loginCountryHits.set(lip, recLc);
        if (recLc.count > LOGIN_COUNTRY_MAX) return json(res, 429, { error: 'Too many attempts. Please try again later.' });
        const q = (urlObj.searchParams.get('input') || '').trim();
        let found = null;
        if (q) {
            const users = db.users || [];
            const students = db.students || [];
            const qLower = q.toLowerCase();
            found = users.find(u => u.username === q) || users.find(u => String(u.username || '').toLowerCase() === qLower);
            if (!found) found = users.find(u => u.studentId === q);
            if (!found) {
                const st = students.find(s => s.phone === q && s.status !== 'pending');
                if (st) found = users.find(u => u.studentId === st.id || u.username === st.id || u.username === st.admissionNumber || u.username === st.phone || u.username === st.email);
            }
            if (!found) {
                const st = students.find(s => (s.admissionNumber === q || s.id === q) && s.status !== 'pending');
                if (st) found = users.find(u => u.studentId === st.id || u.username === st.id || u.username === st.admissionNumber || u.username === st.phone || u.username === st.email);
            }
            if (!found) {
                const st = students.find(s => s.phone === q || s.admissionNumber === q || s.id === q);
                if (st) found = users.find(u => u.role === 'student' && u.name && st.name && u.name.toLowerCase() === st.name.toLowerCase());
            }
        }
        const csSetting = (db.settings || []).find(s => s.key === 'countries');
        const csList = csSetting ? (csSetting.value || csSetting) : [];
        const csNames = (Array.isArray(csList) ? csList : []).map(c => (typeof c === 'string' ? c : c && c.name)).filter(Boolean);
        const bound = found && found.country ? String(found.country) : null;
        return json(res, 200, { country: (bound && csNames.includes(bound)) ? bound : null });
    }

    // GET /api/maintenance-events — public SSE stream for maintenance on/off (no auth)
    if (parts.length === 2 && parts[1] === 'maintenance-events' && req.method === 'GET') {
        const maintHeaders = {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        };
        if (res.__corsOrigin) { maintHeaders['Access-Control-Allow-Origin'] = res.__corsOrigin; maintHeaders['Vary'] = 'Origin'; }
        res.writeHead(200, maintHeaders);
        res.write('\n');
        const client = { res, id: Date.now() };
        maintClients.push(client);
        try { client.res.write(`event: maintenance\ndata: ${JSON.stringify({ active: isMaintenanceActive() })}\n\n`); } catch {}
        const keepalive = setInterval(() => {
            if (!res.writableEnded) res.write(': keepalive\n\n');
            else clearInterval(keepalive);
        }, 15000);
        // Same reasoning as /api/events above: use `res`, not `req`, so the
        // client stays subscribed for the life of the open stream.
        res.on('close', () => {
            clearInterval(keepalive);
            const idx = maintClients.indexOf(client);
            if (idx >= 0) maintClients.splice(idx, 1);
        });
        return true;
    }

    // GET /api/network  — list available network interfaces
    if (parts.length === 2 && parts[1] === 'network' && req.method === 'GET') {
        // Staff only: this exposes the container's internal IP and port, which
        // is useless on a hosted deployment and only useful to an attacker.
        const netUser = getRequestUser(req);
        if (!netUser) return json(res, 401, { error: 'Not authenticated' });
        if (netUser.role === 'student') return json(res, 403, { error: 'Not permitted' });
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
        const niUser = getRequestUser(req);
        if (!niUser) return json(res, 401, { error: 'Not authenticated' });
        if (niUser.role === 'student') return json(res, 403, { error: 'Not permitted' });
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
        // The runtime caches are not part of the data, so they stay out of the
        // download as well.
        const backup = JSON.stringify(persistableDB());
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
                purgeRuntimeCaches(data);
                const count = Object.keys(data).length;
                db = data;
                invalidateSettingsCache();
                invalidateCountryIndex();
                saveDB();
                auditLog('restore', 'database', { stores: count }, authUser.username);
                console.log('Database restored â€”', count, 'stores');
                broadcastEvent('db-restored', { stores: count });
                json(res, 200, { ok: true, stores: count });
            } catch { json(res, 400, { error: 'Invalid JSON in backup file' }); }
        });
        return true;
    }

// GET /api/db-size â€” report database stats
    if (parts.length === 2 && parts[1] === 'db-size' && req.method === 'GET') {
        const authUser = getRequestUser(req);
        if (!authUser) return json(res, 401, { error: 'Not authenticated' });
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

// Document delivery for issued certificates.
//   GET /api/certificate/:id/pdf[?v=CODE] -> the real PDF bytes
//   GET /api/certificate/:id[?v=CODE]     -> a small student download page
// `:id` accepts either the record id (CERT-...) or the printed Document ID
// (DIP-/CMP-/TRX-...). Generated diploma/completion PDFs are externalised to
// disk at boot, so `content` is usually empty — the stored PDF is served
// directly and Puppeteer is only used for HTML-bodied letters.
// Access: a public request must present the document's verification code (?v=),
// which is the same secret printed on the document. Staff who can already read
// the certificates store do not need it. Without either, the page explains how
// to get the code instead of leaking the document.
    if (parts.length >= 3 && parts[0] === 'api' && parts[1] === 'certificate' && req.method === 'GET') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const certId = decodeURIComponent(parts[2]);
        const wantPdf = parts.length >= 4 && parts[3] === 'pdf';
        const cert = (db.certificates || []).find(c => c && (String(c.id) === certId || String(c.docId || '') === certId));
        if (!cert) return json(res, 404, { error: 'Certificate not found' });
        const code = String(urlObj.searchParams.get('v') || urlObj.searchParams.get('code') || '').trim();
        const hasCode = !!cert.vCode && code && String(cert.vCode).toUpperCase() === code.toUpperCase();
        const authUser = getRequestUser(req);
        const isStaff = !!authUser && canAccessStore(authUser, 'certificates', 'GET');
        const branding = (db.settings || []).find(s => s.key === 'branding');
        const schoolName = (branding && branding.schoolName) || 'Net Foundation';
        const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
        const titleOf = (c) => ({ diploma: 'Diploma Certificate', completion: 'Completion Certificate', transcript: 'Official Transcript', 'final-transcript': 'Final Academic Transcript', admission: 'Admission Letter', enrollment: 'Enrollment Letter', recommendation: 'Recommendation Letter', 'fee-statement': 'Fee Statement' }[c.type] || c.docTitle || 'Document');
        const pdfFile = docPathByKey(cert.id);
        const hasPdf = !!(pdfFile && fs.existsSync(pdfFile));

        // ---- raw PDF
        if (wantPdf) {
            if (!hasCode && !isStaff) return json(res, 403, { error: 'This document link is missing its verification code.' });
            if (hasPdf) {
                try {
                    const buf = fs.readFileSync(pdfFile);
                    res.writeHead(200, {
                        'Content-Type': 'application/pdf',
                        'Content-Length': buf.length,
                        'Content-Disposition': 'inline; filename="' + docSafeKey(cert.docId || cert.id) + '.pdf"',
                        'X-Content-Type-Options': 'nosniff',
                        'Cache-Control': 'private, no-store'
                    });
                    res.end(buf);
                } catch (e) { json(res, 500, { error: 'Could not read the stored document' }); }
                return true;
            }
            // HTML-bodied letter: render it (or serve the HTML when Puppeteer is unavailable).
            const html = (maybeReinjectArchived(cert).content) || '';
            if (!html) return json(res, 404, { error: 'No document content stored for this record' });
            (async () => {
                try {
                    const puppeteer = require('puppeteer-core');
                    const browser = await puppeteer.launch({ headless: 'new', executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
                    const page = await browser.newPage();
                    await page.setContent(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:A4;margin:12mm}body{font-family:Georgia,serif;margin:0;background:#fff;color:#111}</style></head><body>${html}</body></html>`, { waitUntil: 'networkidle0', timeout: 60000 });
                    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
                    await browser.close();
                    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdfBuffer.length, 'Content-Disposition': 'inline; filename="' + docSafeKey(cert.docId || cert.id) + '.pdf"' });
                    res.end(pdfBuffer);
                } catch (e) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(html);
                }
            })();
            return true;
        }

        // ---- landing page
        const stu = (db.students || []).find(s => s && String(s.id) === String(cert.studentId));
        const alumni = !stu ? (db.alumni || []).find(a => a && String(a.id) === String(cert.studentId)) : null;
        const person = stu || alumni;
        const verified = hasCode || isStaff;
        const page = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(titleOf(cert))} — ${escHtml(schoolName)}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;color:#0f172a;border-radius:16px;padding:28px;max-width:520px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.45)}
h1{font-size:20px;margin:0 0 4px}.sub{color:#64748b;font-size:13px;margin-bottom:18px}
.ok{background:#ecfdf5;border:1px solid #6ee7b7;color:#065f46;border-radius:10px;padding:10px 14px;font-weight:700;font-size:14px;margin-bottom:18px}
.warn{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:10px;padding:10px 14px;font-weight:600;font-size:14px;margin-bottom:18px}
dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;font-size:14px;margin:0 0 22px}dt{color:#64748b}dd{margin:0;font-weight:600;word-break:break-word}
.btn{display:block;text-align:center;background:#1e3c72;color:#fff;text-decoration:none;padding:13px 18px;border-radius:10px;font-weight:700;font-size:15px}
.btn.sec{background:#0f766e;margin-top:10px}.muted{color:#64748b;font-size:12px;margin-top:16px;text-align:center}</style></head><body><div class="card">
<h1>${escHtml(titleOf(cert))}</h1><div class="sub">${escHtml(schoolName)}</div>
${verified ? '<div class="ok">✓ This document is authentic</div>' : '<div class="warn">This link is missing its verification code — ask the office for the full link from your message.</div>'}
<dl><dt>Student</dt><dd>${escHtml((cert.studentName || (person && (person.name || person.fullName))) || '—')}</dd>
<dt>Admission No.</dt><dd>${escHtml((cert.admission || (person && (person.admissionNumber || person.admissionNo))) || '—')}</dd>
<dt>Document ID</dt><dd>${escHtml(cert.docId || '—')}</dd>
<dt>Issued</dt><dd>${escHtml(cert.generatedAt ? new Date(cert.generatedAt).toDateString() : '—')}</dd></dl>
${verified && hasPdf ? `<a class="btn" href="/api/certificate/${encodeURIComponent(cert.id)}/pdf${hasCode ? '?v=' + encodeURIComponent(cert.vCode) : ''}" download>⬇ Download PDF</a>` : ''}
${verified ? `<a class="btn sec" href="/#verify">✓ Verify this document</a>` : ''}
<div class="muted">Keep this link private — it opens this specific document.</div>
</div></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(page);
        return true;
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
                try { fs.writeFileSync(DB_BACKUP, JSON.stringify(data), 'utf8'); } catch {}
                db = wrapDBObject(data);
                invalidateSettingsCache();
                if (DB_STORAGE_MODE === 'files') {
                    // A restore replaces EVERYTHING: mark all stores dirty and
                    // drop the log archives, so nothing older survives.
                    Object.keys(db).forEach(k => markStoreDirty(k));
                    Object.keys(LOG_STORES).forEach(k => clearLogArchive(k));
                    flushStores();
                } else {
                    saveDB();
                }
                auditLog('restore-from-backup', 'database', { name }, authUser.username);
                console.log('Database restored from backup:', name);
                broadcastEvent('db-restored', { stores: Object.keys(data).length });
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
let { input, password, country } = JSON.parse(body);
                process.stderr.write('LOGIN_TRY input=' + String(input).slice(0, 40) + ' country=' + String(country).slice(0, 20) + ' ip=' + (req.socket && req.socket.remoteAddress || '') + ' maint=' + isMaintenanceActive() + '\n');
                if (!input || !password) return json(res, 400, { error: 'Enter username and password' });
                const countriesSetting = (db.settings || []).find(s => s.key === 'countries');
                const countriesList = countriesSetting ? (countriesSetting.value || countriesSetting) : [];
                // Country validation is done AFTER user lookup so admin can bypass (see below)

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
user = { username: candidate.phone, password: hashPassword(candidate.admissionNumber), name: candidate.name, role: 'student', status: 'active', studentId: candidate.id, createdAt: new Date().toISOString() };
                            db.users.push(user);
                            saveDB();
                        }
                    }
                }

                if (!user) { loginRateFail(req); auditLog('login-failed', 'user', { username: input }, 'anonymous'); return json(res, 401, { error: 'Invalid username or password' }); }

                // The owner is authorised as an admin; the stored record keeps role 'owner'.
                if (user.role === 'owner') user = Object.assign({}, user, { role: 'admin', isOwner: true });
                const storedUser = (db.users || []).find(u => u.username === user.username) || user;

                let pwMatch = verifyPassword(password, user.password) || user.password === password;

                if (!pwMatch && user.role === 'student') {
                    const s = students.find(s => s.id === user.studentId || s.phone === user.username || s.email === user.username || (user.name && s.name === user.name));
                    if (s && s.admissionNumber) pwMatch = verifyPassword(s.admissionNumber, user.password) || s.admissionNumber === password;
                }

                if (!pwMatch) { process.stderr.write('LOGIN_FAIL_PW input=' + String(input).slice(0, 40) + '\n'); loginRateFail(req); auditLog('login-failed', 'user', { username: input }, 'anonymous'); return json(res, 401, { error: 'Invalid username or password' }); }

                // Lifelong learners keep their original student id as the link
                // to academic history, but the login is marked as alumni so the
                // hub and course catalogue use alumni rules. No student row,
                // admission number or registration is created here.
                if (user.role === 'student') markAlumniAccount(user, storedUser);

                // Upgrade a legacy digest to PBKDF2 the first time the owner signs in.
                if (!String(storedUser.password || '').startsWith('pbkdf2$')) {
                    storedUser.password = hashPassword(password);
                    saveDB();
                }
                if (user.status === 'locked') {
                    // Allow grace period for reactivated accounts
                    if (user.inactivityGraceUntil && Date.now() < user.inactivityGraceUntil) {
                        // Still allow access during grace period
                    } else {
                        return json(res, 403, { error: 'Account locked due to inactivity. Contact administration to reactivate.' });
                    }
                }
                if (user.status === 'inactive') return json(res, 403, { error: 'Account is inactive. Contact administration.' });
                if (user.status === 'pending') return json(res, 403, { error: 'Account pending approval. Please wait for admin confirmation.' });

                // Maintenance mode: only admins can sign in
                if (isMaintenanceActive() && user.role !== 'admin') {
                    return json(res, 503, { error: 'The system is currently under maintenance. Please check back later.' });
                }

                // Country validation: main admin (role === 'admin') is GLOBAL and never needs a country.
                // All other roles must select a valid country if countries are configured.
                // countriesList holds entry OBJECTS {name,code,...} — compare against names.
                // (Array.includes(country) against objects would reject every login.)
                        const countryNames = (Array.isArray(countriesList) ? countriesList : []).map(c => (typeof c === 'string' ? c : c && c.name)).filter(Boolean);
                        const countryNamesLower = countryNames.map(c => String(c).toLowerCase());
                        let countryLower = country ? String(country).toLowerCase() : '';
                        try { process.stderr.write('LOGIN_DUMP input=' + String(input).slice(0, 30) + ' country=' + JSON.stringify(country) + ' countryLen=' + String(country || '').length + ' names=' + JSON.stringify(countryNames) + ' role=' + (user.role || '?') + ' ip=' + (req.socket && req.socket.remoteAddress || '') + ' maint=' + isMaintenanceActive() + '\n'); } catch {}
                        if (user.role !== 'admin') {
                            if (countryNames.length > 0) {
                                if (!country || !countryNamesLower.includes(countryLower)) {
                                    // If still missing, try to default to first configured country for compatibility
                                    if (countryNames.length > 0) {
                                        country = countryNames[0];
                                        countryLower = String(country).toLowerCase();
                                    } else {
                                        auditLog('login-country-rejected', 'user', { username: user.username, country: country || null, valid: countryNames }, 'anonymous');
                                        return json(res, 400, { error: 'Please select a valid country' });
                                    }
                                } else {
                                    const idxn = countryNamesLower.indexOf(countryLower);
                                    if (idxn >= 0) country = countryNames[idxn];
                                }
                            }
                        }

                user.lastLogin = new Date().toISOString();
                storedUser.lastLogin = user.lastLogin;
                // Main admin stays global — never set/overwrite country. Others get country from login.
                if (user.role !== 'admin' && country) {
                    if (!user.country) user.country = country;
                    if (user.country !== country) user.country = country;
                }
                saveDB(); // debounced, non-blocking — never hold up the login response with a 9MB rewrite

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
                const parsed = JSON.parse(body);
                // "password" is the original field name; "value" is accepted as
                // well so that any string can be hashed (document hashes).
                const input = parsed && parsed.value !== undefined ? parsed.value : (parsed ? parsed.password : undefined);
                if (input === undefined || input === null) return json(res, 400, { error: 'Missing password' });
                const hash = crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
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
                    broadcastEvent('db-change', { store: 'settings' });
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
                    broadcastEvent('db-change', { store: 'settings' });
                    return json(res, 200, { ok: true, regionId: rid });
                }
                return json(res, 403, { error: 'Forbidden' });
            } catch (e) { return json(res, 400, { error: 'Invalid request' }); }
        });
        return true;
    }

    // GET /api/lesson-pacing — per-course pace configuration for the caller's
    // scope. Admins see everything; country coordinators see their country and
    // its regions/centers/students; regional coordinators see their region,
    // its centers/students, plus the country course defaults they inherit.
    if (parts.length === 2 && parts[1] === 'lesson-pacing' && req.method === 'GET') {
        const lpUser = getRequestUser(req);
        if (!lpUser) return json(res, 401, { error: 'Not authenticated' });
        const role = pacingRoleOf(lpUser);
        if (!role) return json(res, 403, { error: 'Forbidden' });
        const scopeInfo = pacingScopeInfo(lpUser, role);
        const cfg = dripEngine.dripPaceConfig(db);
        const courses = (db.courses || []).filter(Boolean).map(c => ({
            id: String(c.id),
            code: c.code || '',
            name: c.name || '',
            order: c.order == null ? null : c.order,
            dripDaysBetween: c.dripDaysBetween == null || c.dripDaysBetween === '' ? null : c.dripDaysBetween,
            dripPaceUnit: c.dripPaceUnit === 'hours' ? 'hours' : 'days',
            defaultPace: dripEngine.dripCoursePace(c)
        })).sort((a, b) => {
            const ao = a.order == null ? 9999 : Number(a.order);
            const bo = b.order == null ? 9999 : Number(b.order);
            return ao - bo || String(a.code).localeCompare(String(b.code));
        });
        return json(res, 200, {
            ok: true,
            role: role,
            scope: scopeInfo,
            config: pacingFilterConfig(cfg, role, scopeInfo),
            options: pacingOptionsFor(role, scopeInfo),
            courses: courses
        });
    }

    // PUT /api/lesson-pacing — set or clear one course pace at one scope.
    // Body: { scope, scopeId?, courseId, value?, unit?, clear? }
    // `scope: course` edits the admin-owned course default. Coordinators may
    // never write the course default or another country's records.
    if (parts.length === 2 && parts[1] === 'lesson-pacing' && req.method === 'PUT') {
        const lpUser = getRequestUser(req);
        if (!lpUser) return json(res, 401, { error: 'Not authenticated' });
        const role = pacingRoleOf(lpUser);
        if (!role) return json(res, 403, { error: 'Forbidden' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const scope = String(data.scope || '');
                const courseId = String(data.courseId || '').trim();
                if (!courseId) return json(res, 400, { error: 'courseId required' });
                const course = (db.courses || []).find(c => c && String(c.id) === courseId);
                if (!course) return json(res, 404, { error: 'Course not found' });
                const clearing = !!data.clear || data.value === null || data.value === undefined || String(data.value).trim() === '';

                if (scope === 'course') {
                    if (role !== 'admin') return json(res, 403, { error: 'Only an administrator can change the course default' });
                    let pace = null;
                    if (!clearing) {
                        pace = dripEngine.dripNormalizePace(data.value, data.unit);
                        if (!pace) return json(res, 400, { error: 'Pace must be between 0 and 60 days (or 1,440 hours)' });
                    }
                    if (pace) {
                        course.dripDaysBetween = pace.ms / 86400000;
                        course.dripPaceUnit = pace.unit;
                    } else {
                        course.dripDaysBetween = null;
                        course.dripPaceUnit = null;
                    }
                    course.updatedAt = new Date().toISOString();
                    saveDB();
                    try { broadcastEvent('db-change', { store: 'courses' }); } catch (e) {}
                    auditLog('lesson-pacing-course', 'course', { courseId: courseId, value: pace ? pace.value : null, unit: pace ? pace.unit : null }, lpUser.username);
                    return json(res, 200, { ok: true, scope: 'course', courseId: courseId, pace: pace });
                }

                if (!['country', 'region', 'center', 'student'].includes(scope)) {
                    return json(res, 400, { error: 'Unknown pacing scope' });
                }
                const canonical = pacingCanonicalScope(scope, data.scopeId);
                if (!canonical) return json(res, 404, { error: 'Pacing scope record not found' });
                if (!pacingCanEdit(lpUser, role, scope, canonical)) return json(res, 403, { error: 'Outside your pacing scope' });
                let pace = null;
                if (!clearing) {
                    pace = dripEngine.dripNormalizePace(data.value, data.unit);
                    if (!pace) return json(res, 400, { error: 'Pace must be between 0 and 60 days (or 1,440 hours)' });
                }
                const level = scope === 'country' ? 'countries' : scope === 'region' ? 'regions' : scope === 'center' ? 'centers' : 'students';
                const cfg = dripEngine.dripPaceConfig(db);
                if (clearing) {
                    if (cfg[level][canonical.id]) {
                        delete cfg[level][canonical.id][courseId];
                        if (!Object.keys(cfg[level][canonical.id]).length) delete cfg[level][canonical.id];
                    }
                } else {
                    cfg[level][canonical.id] = cfg[level][canonical.id] || {};
                    cfg[level][canonical.id][courseId] = { value: pace.value, unit: pace.unit };
                }
                pacingSaveConfig(cfg, lpUser);
                auditLog('lesson-pacing', 'settings', { scope: scope, scopeId: canonical.id, courseId: courseId, value: pace ? pace.value : null, unit: pace ? pace.unit : null, clear: clearing }, lpUser.username);
                return json(res, 200, { ok: true, scope: scope, scopeId: canonical.id, courseId: courseId, pace: pace });
            } catch (e) {
                return json(res, 400, { error: 'Invalid request' });
            }
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
                if (String(newPw).length < 8) return json(res, 400, { error: 'New password must be at least 8 characters' });
                const user = (db.users || []).find(u => u.username === authUser.username);
                if (!user) return json(res, 404, { error: 'Account not found' });
                const okCurrent = verifyPassword(currentPw, user.password) || user.password === currentPw;
                if (!okCurrent) return json(res, 403, { error: 'Current password is incorrect' });
                if (currentPw === newPw) return json(res, 400, { error: 'New password must differ from current' });
                user.password = hashPassword(newPw);
                delete user.mustChangePassword;
                saveDB();
                const revoked = revokeUserSessions(user.username, requestToken(req));
                auditLog('change-password', 'user', { username: user.username, revoked }, user.username);
                return json(res, 200, { ok: true, revoked });
            } catch { return json(res, 400, { error: 'Invalid request' }); }
        });
        return true;
    }

    // ---- Owner-only security actions -------------------------------------
    // The owner (the author of the system) is the only account that can run
    // these. They exist because the whole database was once downloadable by
    // anyone, which also exposed the live session tokens.
    if (parts.length === 3 && parts[1] === 'owner' && parts[2] === 'revoke-sessions' && req.method === 'POST') {
        const authUser = getRequestUser(req);
        if (!isOwnerUser(authUser)) return json(res, 403, { error: 'Only the owner can do this' });
        let count = 0;
        try {
            count = sessions.size;
            sessions.clear();
            for (const f of [SESSION_FILE, '/data/sessions.json']) {
                try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
            }
            auditLog('revoke-sessions', 'security', { revoked: count }, authUser.username);
            return json(res, 200, { ok: true, revoked: count, message: count + ' session(s) revoked. Everyone must sign in again.' });
        } catch (e) {
            return json(res, 500, { error: e.message || 'Could not revoke sessions' });
        }
    }
    if (parts.length === 3 && parts[1] === 'owner' && parts[2] === 'require-password-reset' && req.method === 'POST') {
        const authUser = getRequestUser(req);
        if (!isOwnerUser(authUser)) return json(res, 403, { error: 'Only the owner can do this' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const scope = String(parsed.scope || 'students');
                const only = String(parsed.username || '').trim();
                const users = db.users || [];
                const flagged = [];
                for (const u of users) {
                    if (scope === 'students' && u.role !== 'student') continue;
                    if (scope === 'staff' && u.role === 'student') continue;
                    if (only && String(u.username || '').toLowerCase() !== only.toLowerCase()) continue;
                    u.mustChangePassword = true;
                    flagged.push(u);
                }
                saveDB();
                // A flagged account may have a stolen session: end it now, so
                // the next sign-in is forced through the new password. The
                // owner's own session is kept (the owner is never locked out
                // of the screen they are using).
                let revoked = 0;
                for (const u of flagged) {
                    if (isOwnerUser(u)) continue;
                    revoked += revokeUserSessions(u.username, '');
                }
                auditLog('require-password-reset', 'user', { scope, only, count: flagged.length, revoked }, authUser.username);
                return json(res, 200, { ok: true, count: flagged.length, revoked });
            } catch { return json(res, 400, { error: 'Invalid request' }); }
        });
        return true;
    }
    if (parts.length === 3 && parts[1] === 'owner' && parts[2] === 'encrypt-secrets' && req.method === 'POST') {
        const authUser = getRequestUser(req);
        if (!isOwnerUser(authUser)) return json(res, 403, { error: 'Only the owner can do this' });
        if (!ENC_KEY) return json(res, 400, { error: 'Set DATA_ENCRYPTION_KEY in the environment first, then run this.' });
        let changed = 0;
        const SECRET_RE = /^(consumerKey|consumerSecret|passkey|apiKey|secret|password|token|passcode|pin)$/i;
        const walk = (o) => {
            if (!o || typeof o !== 'object') return;
            for (const k of Object.keys(o)) {
                const v = o[k];
                if (typeof v === 'string' && SECRET_RE.test(k) && v && !v.startsWith('enc:')) {
                    o[k] = encryptSecret(v);
                    changed++;
                } else if (v && typeof v === 'object') walk(v);
            }
        };
        for (const rec of (db.settings || [])) {
            if (!rec) continue;
            const v = rec.value || rec;
            if (v && typeof v === 'object') walk(v);
        }
        saveDB();
        auditLog('encrypt-secrets', 'settings', { changed }, authUser.username);
        return json(res, 200, { ok: true, changed });
    }
    // POST /api/reset-password — decentralized, country-aware password reset.
    //   - Overall admin: may reset ANY user's password (coordinator or student).
    //   - Country coordinator: may reset their OWN password, and the password of
    //     any STUDENT who resolves to their own country (student.country, or via
    //     study center -> region). Students of other countries are rejected.
    //   - Body: { username, newPassword }  OR  { username, resetToAdmission: true }
    //     (resetToAdmission sets the student's password to their admission number).
    // The users store itself stays write-blocked for non-admins; this is the
    // only sanctioned path, so decentralization never widens the attack surface.
    if (parts.length === 2 && parts[1] === 'reset-password' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const authUser = getRequestUser(req);
                if (!authUser || !authUser.user) return json(res, 401, { error: 'Not authenticated' });
                const parsed = JSON.parse(body);
                const username = parsed && parsed.username ? String(parsed.username).trim() : '';
                const newPassword = parsed && parsed.newPassword ? String(parsed.newPassword) : '';
                const resetToAdmission = !!(parsed && parsed.resetToAdmission);
                if (!username) return json(res, 400, { error: 'Enter the account username' });
                if (!resetToAdmission && newPassword.length < 8) return json(res, 400, { error: 'New password must be at least 8 characters' });
                const target = (db.users || []).find(u => u.username === username || u.studentId === username || u.phone === username);
                if (!target) return json(res, 404, { error: 'Account not found' });
                const isAdmin = authUser.role === 'admin';
                const scope = countryScopeOf(authUser);
                if (!isAdmin && !scope) return json(res, 403, { error: 'Only admins and country administrators may reset passwords' });
                if (!isAdmin && target.username !== authUser.username) {
                    // Coordinator resetting someone else: they may ONLY reset a
                    // student of their OWN country, and only via country-scoping.
                    if (target.role !== 'student') return json(res, 403, { error: 'You may only reset passwords for students of your country' });
                    const student = (db.students || []).find(s => String(s.id) === String(target.studentId) || s.phone === target.username || s.email === target.username || (s.admissionNumber && s.admissionNumber === target.username));
                    const tCountry = recordCountryOf('students', student || {});
                    if (tCountry !== scope) return json(res, 403, { error: 'You may only reset passwords for students of your own country' });
                }
                let finalPw = newPassword;
                if (resetToAdmission) {
                    const student = (db.students || []).find(s => String(s.id) === String(target.studentId) || s.phone === target.username || s.email === target.username || (s.admissionNumber && s.admissionNumber === target.username));
                    if (!student || !student.admissionNumber) return json(res, 400, { error: 'Student has no admission number to reset to' });
                    finalPw = String(student.admissionNumber);
                }
                target.password = hashPassword(finalPw);
                delete target.mustChangePassword;
                target.status = 'active';
                saveDB();
                // A reset is how a compromised account is recovered, so every
                // existing session for it ends. A user changing their OWN
                // password keeps the session they are using.
                const self = String(target.username).toLowerCase() === String(authUser.username).toLowerCase();
                const revoked = revokeUserSessions(target.username, self ? requestToken(req) : '');
                auditLog('reset-password', 'user', { username: target.username, method: resetToAdmission ? 'to-admission' : 'custom', revoked }, authUser.username);
                return json(res, 200, { ok: true, resetToAdmission, revoked });
            } catch { return json(res, 400, { error: 'Invalid request' }); }
        });
        return true;
    }

    // POST /api/terms-accept — any authenticated user records their OWN
    // acceptance of the current Terms & Conditions. The server stamps only
    // termsAccepted/termsAcceptedAt/termsVersion on the caller's own user
    // record — no generic users-store write is ever exposed to non-admins.
    // The version stored is the one the gates compute client-side
    // (termsContent ? (termsVersion || 1) : 0), so a mismatch after a fresh
    // browser / device is impossible once accepted at the current version.
    if (parts.length === 2 && parts[1] === 'terms-accept' && req.method === 'POST') {
        try {
            const authUser = getRequestUser(req);
            if (!authUser || !authUser.user) return json(res, 401, { error: 'Not authenticated' });
            const rec = (db.settings || []).find(s => s.key === 'branding');
            const branding = rec ? (rec.value || rec) : null;
            const termsVersion = branding && branding.termsContent ? (branding.termsVersion || 1) : 0;
            const userRec = (db.users || []).find(u => String(u.username) === String(authUser.username));
            if (!userRec) return json(res, 404, { error: 'Account not found' });
            userRec.termsAccepted = true;
            userRec.termsAcceptedAt = new Date().toISOString();
            userRec.termsVersion = termsVersion;
            saveDB();
            auditLog('terms-accepted', 'user', { username: userRec.username, termsVersion }, userRec.username);
            return json(res, 200, { ok: true, termsVersion });
        } catch { return json(res, 400, { error: 'Invalid request' }); }
    }

    // GET /api/public-contact — admin phone for login screen (public, no secrets)
    if (parts.length === 2 && parts[1] === 'public-contact' && req.method === 'GET') {
        try {
            return json(res, 200, { phone: getContactPhone() });
        } catch { return json(res, 200, { phone: '' }); }
    }

    // Google Translate HTML-escapes its output (&amp;, &#39;, &quot; ...). Convert
// those back to real characters so the Swahili reads naturally in the UI.
function decodeHtmlEntities(s) {
    return String(s == null ? '' : s)
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

// GET /api/translate — lightweight provider self-test (also used to confirm
    // the route is reachable without spending a translation call).
    if (parts.length === 2 && parts[1] === 'translate' && req.method === 'GET') {
        const s = db.settings ? (db.settings.find(x => x && x.key === 'translation') || {}) : {};
        const v = s.value && typeof s.value === 'object' ? s.value : s;
        return json(res, 200, { ok: true, provider: v.provider || 'mymemory', libreUrlConfigured: !!(v.libreUrl || process.env.LIBRETRANSLATE_URL), googleKeyConfigured: !!(v.googleApiKey || process.env.TRANSLATE_API_KEY) });
    }

    // POST /api/translate — Swahili translation for the question bank.
    //
    // Uses the Google Cloud Translation v2 API. The key is read from the
    // TRANSLATE_API_KEY environment variable and is NEVER sent to the browser:
    // the client posts English text here and receives Swahili back.
    //
    // With no key configured the endpoint returns 501 with a clear reason, so
    // the UI can fall back to the English text instead of failing silently.
    if (parts.length === 2 && parts[1] === 'translate' && req.method === 'POST') {
        // This route answers from an async provider call. Mark the request so the
        // static /api fall-through at the end of the listener cannot answer first.
        req._asyncApi = true;
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            const translateUser = getRequestUser(req);
            const translationSetting = db.settings ? (db.settings.find(s => s && s.key === 'translation') || {}) : {};
            const trVal = translationSetting && (translationSetting.value && typeof translationSetting.value === 'object') ? translationSetting.value : translationSetting;
            const key = trVal.googleApiKey || process.env.TRANSLATE_API_KEY || '';
            // No hard Google-only check now: fall back to free providers below.
            if (!translateUser || translateUser.role === 'student') {
                return json(res, 403, { ok: false, error: 'Only staff can translate questions.' });
            }
            let parsed;
            try { parsed = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: 'Invalid body' }); }
            // Accept a single string or an array of strings.
            const items = Array.isArray(parsed.texts) ? parsed.texts : [parsed.text];
            const texts = items.map(t => String(t == null ? '' : t)).filter(t => t.trim());
            if (!texts.length) return json(res, 200, { ok: true, translations: [] });
            if (texts.length > 60) return json(res, 400, { ok: false, error: 'Too many strings in one request (max 60).' });
            const target = parsed.target === 'en' ? 'en' : 'sw';
const provider = String(trVal.provider || process.env.TRANSLATE_PROVIDER || 'mymemory').toLowerCase();
            const pair = target === 'sw' ? 'en|sw' : 'sw|en';
            // Public LibreTranslate instances now answer with an HTML error page
            // (they require an API key), so it is only ever called when the admin
            // has explicitly supplied their own URL. MyMemory is the free default.
            const libreUrl = trVal.libreUrl || process.env.LIBRETRANSLATE_URL || '';
            const libreKey = trVal.libreApiKey || process.env.LIBRETRANSLATE_API_KEY || '';
            const myMemoryEmail = trVal.contactEmail || process.env.TRANSLATE_CONTACT_EMAIL || 'translation@netfoundation.ke';

            if (provider === 'google') {
                if (!key) return json(res, 400, { ok: false, error: 'missing_key', message: 'Google mode is selected but no Google API key is saved. Switch the provider to MyMemory or add the key.' });
                try {
                    const r = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ q: texts, target, format: 'text', source: 'en' }),
                        signal: AbortSignal.timeout(20000)
                    });
                    if (!r.ok) {
                        console.error('translate API error', r.status, (await r.text().catch(() => '')).slice(0, 200));
                        return json(res, 502, { ok: false, error: 'upstream_error', message: 'Google rejected the request.' });
                    }
                    const out = await r.json();
                    const data = (out && out.data && out.data.translations) || [];
                    let list = data.map(d => String((d.translatedText || '')).split('\u0001')[0]);
                    if (texts.length > 1 && list.length === 1) list = list[0].split('\u0001');
                    return json(res, 200, { ok: true, provider: 'google', translations: list.map(t => decodeHtmlEntities(t)) });
                } catch (e) {
                    console.error('google translate failed:', e && e.message);
                    return json(res, 502, { ok: false, error: 'network_error', message: 'Could not reach Google Translate.' });
                }
            }

            if (provider === 'libretranslate' && libreUrl) {
                try {
                    const r = await fetch(libreUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ q: texts, source: 'en', target, format: 'text', api_key: libreKey || undefined }),
                        signal: AbortSignal.timeout(20000)
                    });
                    if (!r.ok) {
                        console.error('libretranslate error', r.status, (await r.text().catch(() => '')).slice(0, 200));
                        throw new Error('libretranslate http ' + r.status);
                    }
                    const out = await r.json();
                    let list = [];
                    if (Array.isArray(out.translatedText)) list = out.translatedText;
                    else if (Array.isArray(out.translations)) list = out.translations.map(t => t.translatedText || '');
                    else list = [out.translatedText || ''];
                    if (list.length === texts.length) {
                        return json(res, 200, { ok: true, provider: 'libretranslate', translations: list.map(t => decodeHtmlEntities(String(t))) });
                    }
                    throw new Error('libretranslate returned ' + list.length + ' of ' + texts.length);
                } catch (e) { console.error('libretranslate failed, falling back to MyMemory:', e && e.message); }
            }

            // MyMemory: free, no key, reliable. Newlines separate the segments,
            // so one request covers a whole question (prompt + options + pairs).
            try {
                const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(texts.join('\n'))}&langpair=${pair}&de=${encodeURIComponent(myMemoryEmail)}`;
                const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
                if (!r.ok) throw new Error('mymemory http ' + r.status);
                const out = await r.json();
                if (out && out.quotaFinished) throw new Error('mymemory daily quota reached');
                const t = out && out.responseData && out.responseData.translatedText;
                if (!t) throw new Error('mymemory empty response');
                let list = decodeHtmlEntities(String(t)).split('\n').map(s => s.trim()).filter(Boolean);
                if (list.length === texts.length) {
                    return json(res, 200, { ok: true, provider: 'mymemory', translations: list });
                }
                // Segment counts can drift on very long strings: fall back to
                // translating one string per request so nothing is lost.
                const singles = [];
                for (const one of texts) {
                    const rr = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(one)}&langpair=${pair}&de=${encodeURIComponent(myMemoryEmail)}`, { signal: AbortSignal.timeout(30000) });
                    if (!rr.ok) { singles.push(one); continue; }
                    const jj = await rr.json();
                    const tt = jj && jj.responseData && jj.responseData.translatedText;
                    singles.push(tt ? decodeHtmlEntities(String(tt)).split('\n')[0].trim() || one : one);
                    await new Promise(s => setTimeout(s, 250));
                }
                return json(res, 200, { ok: true, provider: 'mymemory', translations: singles });
            } catch (e) {
                console.error('mymemory failed:', e && e.message);
                return json(res, 502, { ok: false, error: 'upstream_error', message: 'No translation provider is available right now. Try again shortly.' });
            }
        });
        return;
    }

    // POST /api/analytics/event — privacy-safe anonymous usage event
    if (parts.length === 3 && parts[1] === 'analytics' && parts[2] === 'event' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const event = JSON.parse(body || '{}') || {};
                const user = getRequestUser(req);
                const ua = String(req.headers['user-agent'] || '');
                function classifyBrowser() {
                    if (/Edg\//i.test(ua)) return 'Edge';
                    if (/Chrome\//i.test(ua) && !/Edg|OPR|Brave/i.test(ua)) return 'Chrome';
                    if (/Firefox\//i.test(ua)) return 'Firefox';
                    if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
                    if (/OPR\//i.test(ua)) return 'Opera';
                    return 'Unknown';
                }
                function classifyOS() {
                    if (/Windows/i.test(ua)) return 'Windows';
                    if (/Android/i.test(ua)) return 'Android';
                    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
                    if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
                    if (/Linux/i.test(ua)) return 'Linux';
                    return 'Unknown';
                }
                const device = /Mobi|Android/i.test(ua) ? (/iPad|Tablet/i.test(ua) ? 'Tablet' : 'Mobile') : 'Desktop';
                const edgeCountry = String(req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country-code'] || '').toUpperCase().slice(0, 2);
                const country = user && user.user && user.user.country ? String(user.user.country).slice(0, 80) : (edgeCountry && edgeCountry !== 'XX' ? edgeCountry : 'Unknown');
                const role = user && user.role ? String(user.role) : 'public';
                const rec = {
                    id: 'AE-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
                    at: new Date().toISOString(),
                    event: String(event.event || event.type || 'page').slice(0, 60),
                    path: String(event.path || event.screen || '/').slice(0, 120),
                    referrer: String(event.referrer || req.headers.referer || '').slice(0, 140),
                    source: String(event.source || '').slice(0, 80),
                    country,
                    role,
                    browser: classifyBrowser(),
                    os: classifyOS(),
                    device,
                    authenticated: !!user
                };
                if (!db.analyticsEvents) db.analyticsEvents = [];
                db.analyticsEvents.push(rec);
                if (db.analyticsEvents.length > 50000) db.analyticsEvents = db.analyticsEvents.slice(-50000);
                saveDB();
                return json(res, 200, { ok: true });
            } catch (e) {
                return json(res, 400, { ok: false, error: 'Invalid analytics event' });
            }
        });
        return true;
    }

    // GET /api/media — list media uploads (student sees their own; admins see all)
    if (parts.length === 2 && parts[1] === 'media' && req.method === 'GET') {
        const authUser = getRequestUser(req);
        if (!authUser) return json(res, 401, { error: 'Not authenticated' });
        const rows = (db.mediaUploads || []).slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        const filtered = authUser.role === 'student'
            ? rows.filter(r => r && r.uploaderUsername === authUser.username)
            : rows;
        return json(res, 200, { media: filtered.slice(-200) });
    }

    // DELETE /api/media/:id — remove a media upload
    if (parts.length === 3 && parts[1] === 'media' && req.method === 'DELETE') {
        const authUser = getRequestUser(req);
        if (!authUser || !['admin', 'assistant', 'coordinator'].includes(authUser.role)) return json(res, 403, { error: 'Admin access required' });
        const id = decodeURIComponent(parts[2] || '');
        const before = (db.mediaUploads || []).length;
        db.mediaUploads = (db.mediaUploads || []).filter(r => r && String(r.id) !== id);
        if (before === (db.mediaUploads || []).length) return json(res, 404, { error: 'Media not found' });
        saveDB();
        return json(res, 200, { ok: true });
    }

    // PATCH /api/media/:id — move an upload to another study center in its region
    if (parts.length === 3 && parts[1] === 'media' && req.method === 'PATCH') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const authUser = getRequestUser(req);
                if (!authUser || !['admin', 'assistant', 'coordinator'].includes(authUser.role)) return json(res, 403, { error: 'Admin access required' });
                const id = decodeURIComponent(parts[2] || '');
                const p = JSON.parse(body || '{}');
                const rec = (db.mediaUploads || []).find(r => r && String(r.id) === id);
                if (!rec) return json(res, 404, { error: 'Media not found' });
                rec.studyCenterId = p.studyCenterId || rec.studyCenterId;
                rec.studyCenterName = p.studyCenterName || rec.studyCenterName;
                rec.updatedAt = new Date().toISOString();
                saveDB();
                return json(res, 200, { ok: true, media: rec });
            } catch (e) {
                return json(res, 400, { error: 'Invalid update' });
            }
        });
        return true;
    }

    // POST /api/media — upload a compressed photo or short video as base64
    if (parts.length === 2 && parts[1] === 'media' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const authUser = getRequestUser(req);
                if (!authUser) return json(res, 401, { error: 'Not authenticated' });
                const p = JSON.parse(body || '{}');
                if (!p.dataUrl || typeof p.dataUrl !== 'string') return json(res, 400, { error: 'Missing file data' });
                const isImage = p.dataUrl.startsWith('data:image/');
                const isVideo = p.dataUrl.startsWith('data:video/');
                if (!isImage && !isVideo) return json(res, 400, { error: 'Only image or video data URLs are accepted' });
                const approxBytes = Math.floor((p.dataUrl.length - (p.dataUrl.indexOf(',') + 1)) * 0.75);
                if (approxBytes > 8 * 1024 * 1024) return json(res, 413, { error: 'File too large' });
                const su = authUser.user || {};
                const student = authUser.role === 'student' ? ((db.students || []).find(s => s.id === su.studentId || String(s.phone || '').replace(/[^0-9]/g, '') === String(authUser.username || '').replace(/[^0-9]/g, '') || String(s.phone || '') === authUser.username) || {}) : {};
                const studentRegion = (db.regions || []).find(r => r && r.id === (student.regionId || su.regionId || ''));
                const studentCenter = (db.studyCenters || []).find(c => c && c.id === (student.studyCenterId || su.studyCenterId || su.campusId || ''));
                const rec = {
                    id: 'MED-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
                    uploaderUsername: authUser.username,
                    uploaderRole: authUser.role,
                    uploaderName: su.name || su.fullName || authUser.username || '',
                    studentId: su.studentId || '',
                    country: student.country || su.country || '',
                    regionId: student.regionId || su.regionId || '',
                    regionName: studentRegion ? (studentRegion.name || studentRegion.id) : '',
                    studyCenterId: student.studyCenterId || su.studyCenterId || su.campusId || '',
                    studyCenterName: studentCenter ? (studentCenter.name || studentCenter.id) : '',
                    type: isImage ? 'image' : 'video',
                    dataUrl: p.dataUrl,
                    title: String(p.title || '').slice(0, 120),
                    notes: String(p.notes || '').slice(0, 300),
                    createdAt: new Date().toISOString()
                };
                if (!db.mediaUploads) db.mediaUploads = [];
                db.mediaUploads.push(rec);
                if (db.mediaUploads.length > 2000) db.mediaUploads = db.mediaUploads.slice(-2000);
                saveDB();
                return json(res, 200, { ok: true, media: rec });
            } catch (e) {
                return json(res, 400, { error: 'Invalid upload' });
            }
        });
        return true;
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
                let studyCountry = '';
                try {
                    const cid = stu ? (stu.studyCenterId || '') : '';
                    if (cid) {
                        const center = (db.studyCenters || []).find(c => String(c.id) === String(cid));
                        studyCenter = center ? (center.name || '') : String(cid);
                        studyCountry = center ? String(center.country || '') : '';
                    }
                } catch {}
                const country = String(stu && stu.country ? stu.country : (studyCountry || record.country || ''));
                let institutionName = '';
                try {
                    if (country) {
                        const countriesSetting = (db.settings || []).find(s => s.key === 'countries');
                        const countries = countriesSetting ? (countriesSetting.value || countriesSetting) : [];
                        const entry = (Array.isArray(countries) ? countries : []).find(c => c && String(c.name) === String(country));
                        if (entry && entry.brandName) institutionName = String(entry.brandName);
                    }
                } catch {}
                return json(res, 200, { ok: true, isTranscript,
                    studentName: (stu && stu.name) || record.studentName || record.name || '',
                    admission: (stu && (stu.admissionNumber || stu.id)) || record.admission || record.admissionNumber || '',
                    program: (stu && stu.program) || record.program || '',
                    studyCenter,
                    country,
                    institutionName,
                    docId: record.docId || did,
                    docTitle: record.docTitle || (isTranscript ? 'Official Transcript' : (record.type ? ({ diploma: 'Diploma Certificate', completion: 'Completion Certificate', transcript: 'Official Transcript', admission: 'Admission Letter', enrollment: 'Enrollment Letter', recommendation: 'Recommendation Letter', 'fee-statement': 'Fee Statement' }[record.type] || (String(record.type)[0].toUpperCase() + String(record.type).slice(1))) : 'Certificate')),
                    generatedAt: record.generatedAt || record.createdAt || '',
                    issueDate: record.issueDate || '',
                    issueDateFormatted: record.issueDateFormatted || '',
                    revoked: record.docStatus === 'revoked',
                    revokedBy: record.revokedBy || '',
                    revokedAt: record.revokedAt || '',
                    revokeReason: record.revokeReason || '',
                    cgpa: (typeof record.cgpa === 'number' ? record.cgpa : undefined),
                    classification: record.classification || '',
                    courseHash: record.courseHash || ''
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
                broadcastEvent('db-change', { store: 'mpesaSettings' });
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
                const payAccount = data.account === 'graduation' ? 'graduation' : 'tuition';
                let studentId = String(data.studentId || '');
                if (stkUser.role === 'student') {
                    const ownId = String((stkUser.user || {}).studentId || stkUser.username || '');
                    const stu = (db.students || []).find(x => String(x.id) === ownId || String(x.phone) === String(stkUser.username));
                    studentId = stu ? stu.id : ownId;
                }
                if (!studentId) return json(res, 400, { error: 'Missing student.' });
                // Cap at the remaining balance for the selected account. Tuition
                // honors the fee ceiling + waivers; graduation honors its own
                // amount/ceiling and never waivers. Rejects overpaying pushes.
                try {
                    const rules = (() => { try { const r = (db.settings || []).find(s => s.key === 'feeRules'); return (r && r.value) || {}; } catch { return {}; } })();
                    const num = (v) => { const n = Number(v); return n > 0 ? n : 0; };
                    if (payAccount === 'graduation') {
                        const stuG = (db.students || []).find(x => String(x.id) === String(studentId)) || null;
                        const gf = (stuG && stuG.gradSponsored) ? 0 : (num(rules.graduationCeiling) > 0 ? Math.min(num(rules.graduationFee), num(rules.graduationCeiling)) : num(rules.graduationFee));
                        const gpaid = (db.payments || []).filter(p => String(p.studentId) === String(studentId) && p.account === 'graduation').reduce((s, p) => s + (Number(p.amount) || 0), 0);
                        const grem = Math.max(0, gf - gpaid);
                        if (grem <= 0) return json(res, 400, { error: 'Graduation fee fully paid. Nothing due.' });
                        if (amount > grem) return json(res, 400, { error: 'Amount exceeds the remaining graduation balance of KES ' + Math.round(grem) + '.' });
                    } else {
                        const stuRec = (db.students || []).find(x => String(x.id) === String(studentId)) || null;
                        let courseFee = Number(stuRec && stuRec.feeAmount) || 0;
                        if (!(courseFee > 0) && stuRec && stuRec.program) {
                            const acad = (db.settings || []).find(s => s.key === 'academic');
                            const av = acad ? (acad.value || acad) : null;
                            if (av && av.programFees && Number(av.programFees[stuRec.program]) > 0) courseFee = Number(av.programFees[stuRec.program]);
                        }
                        if (num(rules.ceiling) > 0) courseFee = Math.min(courseFee, num(rules.ceiling));
                        if (courseFee > 0) {
                            const paidSoFar = (db.payments || []).filter(p => String(p.studentId) === String(studentId) && (!p.account || p.account === 'tuition')).reduce((s, p) => s + (Number(p.amount) || 0), 0)
                                + (db.waivers || []).filter(w => String(w.studentId) === String(studentId)).reduce((s, w) => s + (Number(w.amount) || 0), 0);
                            const remaining = Math.max(0, courseFee - paidSoFar);
                            if (remaining <= 0) return json(res, 400, { error: 'Program fee fully paid. Nothing due.' });
                            if (amount > remaining) return json(res, 400, { error: 'Amount exceeds your remaining program balance of KES ' + Math.round(remaining) + '.' });
                        }
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
                    db.mpesaTransactions.push({ id: 'STK-' + Date.now(), checkoutRequestId: result.CheckoutRequestID, merchantRequestId: result.MerchantRequestID || '', studentId, amount, phone: digits, status: 'pending', account: payAccount, initiatedBy: stkUser.username, createdAt: new Date().toISOString() });
                    saveDB();
                    broadcastEvent('db-change', { store: 'mpesaTransactions' });
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
                            const _pStu = (db.students || []).find(x => String(x.id) === String(studentId));
                            db.payments.push({ id: 'PMT-' + Date.now().toString(36).toUpperCase(), studentId, amount: amountPaid, account: (txn && txn.account) || 'tuition', method: 'M-Pesa STK', reference: mpesaReceipt, mpesaCheckout: checkoutId, notes: 'Paid via ' + payerPhone, receiptNo, date: d.toISOString().split('T')[0], createdAt: d.toISOString(), country: (_pStu && _pStu.country) || '' });
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
                            const _pStu2 = (db.students || []).find(x => String(x.id) === String(txn.studentId));
                            db.payments.push({ id: 'PMT-' + Date.now().toString(36).toUpperCase(), studentId: txn.studentId, amount: txn.amount, account: txn.account || 'tuition', method: 'M-Pesa STK', reference: txn.mpesaReceipt || cid, mpesaCheckout: cid, notes: 'Paid via ' + (txn.phone || '') + ' (confirmed by query)', receiptNo: prefix + String(seq).padStart(4, '0'), date: d.toISOString().split('T')[0], createdAt: d.toISOString(), country: (_pStu2 && _pStu2.country) || '' });
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


    // -----------------------------------------------------------
    // WhatsApp Cloud API — status / broadcast / template submit
    // -----------------------------------------------------------
    // Sender identity lives in settings key \`whatsappCloud\`, never in code.
    // The access token is encrypted at rest (AES-256-GCM) like M-Pesa/SMS keys.
    // These routes are inert until an admin saves the credentials; the browser
    // keeps using the free wa.me flow until then.
    function waCloudSettings() {
        const rec = (db.settings || []).find(x => x.key === 'whatsappCloud');
        const v = rec ? (rec.value || {}) : {};
        return {
            phoneNumberId: String(v.phoneNumberId || '').trim(),
            wabaId: String(v.wabaId || '').trim(),
            accessToken: decryptSecret(v.accessToken),
            templateLanguage: String(v.templateLanguage || 'en').trim() || 'en',
            senderNumber: String(v.senderNumber || '').trim(),
            apiVersion: String(v.apiVersion || 'v21.0').trim() || 'v21.0'
        };
    }
    function waCloudReady(c) { return c && c.phoneNumberId && c.wabaId && c.accessToken; }
    function waGraphPost(c, path, body) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(body);
            const opts = {
                hostname: 'graph.facebook.com', port: 443,
                path: '/' + c.apiVersion + path, method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + c.accessToken,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            };
            const rq = https.request(opts, rs => {
                let out = '';
                rs.on('data', ch => out += ch);
                rs.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ _raw: out }); } });
            });
            rq.on('error', reject);
            rq.write(data);
            rq.end();
        });
    }
    // {{name}} -> {{1}}, {{2}}... in order of first appearance, plus the
    // variable list the caller must supply in that same order.
    function waNumberBody(body) {
        const seen = [], re = /\\{\\{(\\w+)\\}\\}/g;
        let m; while ((m = re.exec(String(body)))) if (!seen.includes(m[1])) seen.push(m[1]);
        let out = String(body);
        seen.forEach((v, i) => { out = out.split('{{' + v + '}}').join('{{' + (i + 1) + '}}'); });
        return { numbered: out, vars: seen };
    }
    // Resolve one {{variable}} for one recipient using live records.
    function waResolveVar(name, st, ctx) {
        const p = ctx.payments || [];
        const tuition = p.filter(x => String(x.studentId) === String(st.id) && (!x.account || x.account === 'tuition'))
            .reduce((a, b) => a + (Number(b.amount) || 0), 0);
        const fee = Number(st.feeAmount || 0);
        switch (name) {
            case 'name': return st.name || '';
            case 'balance': return String(Math.max(0, fee - tuition));
            case 'school': return ctx.schoolName || 'College';
            case 'admissionNumber':
            case 'admission': return st.admissionNumber || st.id || '';
            case 'username':
            case 'login':
            case 'phone': return st.phone || '';
            case 'program': return st.program || 'program';
            case 'year': return st.year || '1';
            case 'portal': return 'www.nefoundation.ke';
            case 'date': return new Date().toISOString().split('T')[0];
            default: return '';
        }
    }

    // GET /api/whatsapp-cloud/status — never returns the token itself.
    if (parts.length === 3 && parts[1] === 'whatsapp-cloud' && parts[2] === 'status' && req.method === 'GET') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const su = getRequestUser(req);
        if (!su) return json(res, 401, { error: 'Not authenticated' });
        if (su.role === 'student') return json(res, 403, { error: 'Not available to students' });
        const c = waCloudSettings();
        return json(res, 200, {
            configured: waCloudReady(c),
            senderNumber: c.senderNumber || c.phoneNumberId,
            templateLanguage: c.templateLanguage,
            phoneNumberId: c.phoneNumberId,
            wabaId: c.wabaId,
            apiVersion: c.apiVersion
        });
    }

    // POST /api/whatsapp-cloud/send — send one template message.
    if (parts.length === 3 && parts[1] === 'whatsapp-cloud' && parts[2] === 'send' && req.method === 'POST') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const su = getRequestUser(req);
        if (!su) return json(res, 401, { error: 'Not authenticated' });
        if (!canAccessStore(su, 'whatsappLog', 'POST')) return json(res, 403, { error: 'Insufficient permissions' });
        let body = '';
        req.on('data', ch => body += ch);
        req.on('end', async () => {
            try {
                const c = waCloudSettings();
                if (!waCloudReady(c)) return json(res, 400, { configured: false, error: 'WhatsApp Cloud API is not configured.' });
                const d = JSON.parse(body);
                const to = String(d.to || '').replace(/[^0-9]/g, '');
                if (!to) return json(res, 400, { error: 'Recipient number required' });
                if (to.startsWith('0')) to = '254' + to.substring(1);
                const payload = {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to: to,
                    type: 'text',
                    text: { preview_url: false, body: String(d.message || '') }
                };
                if (d.templateName) {
                    const bd = waNumberBody(d.templateBody || '');
                    payload.type = 'template';
                    delete payload.text;
                    payload.template = {
                        name: String(d.templateName),
                        language: { code: c.templateLanguage },
                        components: (bd.vars || []).length ? [{
                            type: 'body',
                            parameters: (d.variables || []).map(v => ({ type: 'text', text: String(v == null ? '' : v) }))
                        }] : []
                    };
                }
                const r = await waGraphPost(c, '/' + c.phoneNumberId + '/messages', payload);
                const ok = !!(r && r.messages && r.messages[0] && r.messages[0].id);
                if (su.user) {
                    db.whatsappLog = db.whatsappLog || [];
                    db.whatsappLog.push({
                        id: 'WA-' + Date.now(), phone: to, name: d.name || '',
                        message: String(d.message || '').substring(0, 200),
                        date: new Date().toISOString().split('T')[0],
                        time: new Date().toLocaleTimeString(), template: d.templateName || '',
                        status: ok ? 'sent' : 'failed',
                        sentBy: su.username, createdAt: new Date().toISOString(),
                        country: su.user.country
                    });
                    saveDB();
                }
                if (!ok) return json(res, 502, { error: (r && (r.error && r.error.message)) || 'WhatsApp rejected the message' });
                return json(res, 200, { id: r.messages[0].id });
            } catch (e) { json(res, 500, { error: e.message || e }); }
        });
        return true;
    }


    // GET /api/whatsapp-cloud/templates — status of registered templates
    if (parts.length === 3 && parts[1] === 'whatsapp-cloud' && parts[2] === 'templates' && req.method === 'GET') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const su = getRequestUser(req);
        if (!su) return json(res, 401, { error: 'Not authenticated' });
        if (su.role === 'student') return json(res, 403, { error: 'Not available to students' });
        (async () => {
            try {
                const c = waCloudSettings();
                if (!waCloudReady(c)) return json(res, 200, { configured: false, templates: [] });
                const out = await new Promise((resolve, reject) => {
                    const opts = {
                        hostname: 'graph.facebook.com', port: 443,
                        path: '/' + c.apiVersion + '/' + c.wabaId + '/message_templates?limit=100',
                        method: 'GET',
                        headers: { 'Authorization': 'Bearer ' + c.accessToken }
                    };
                    const rq = https.request(opts, rs => {
                        let d = ''; rs.on('data', ch => d += ch);
                        rs.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d }); } });
                    });
                    rq.on('error', reject);
                    rq.end();
                });
                if (!out || !Array.isArray(out.data)) {
                    return json(res, 200, { configured: true, templates: [], error: (out && out.error && out.error.message) || 'Could not read templates' });
                }
                return json(res, 200, {
                    configured: true, templates: out.data.map(t => ({ name: t.name, status: t.status, category: t.category, language: t.language })),
                    error: null
                });
            } catch (e) { return json(res, 200, { configured: true, templates: [], error: e.message || String(e) }); }
        })();
        return true;
    }

    if (parts.length === 3 && parts[1] === 'whatsapp-cloud' && parts[2] === 'templates' && req.method === 'POST') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const su = getRequestUser(req);
        if (!su) return json(res, 401, { error: 'Not authenticated' });
        if (!canAccessStore(su, 'whatsappTemplates', 'POST')) return json(res, 403, { error: 'Insufficient permissions' });
        let body = '';
        req.on('data', ch => body += ch);
        req.on('end', async () => {
            try {
                const c = waCloudSettings();
                if (!waCloudReady(c)) return json(res, 400, { configured: false, error: 'WhatsApp Cloud API is not configured.' });
                const d = JSON.parse(body);
                const bd = waNumberBody(d.body || '');
                const payload = {
                    name: String(d.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                    language: c.templateLanguage,
                    category: String(d.category || 'UTILITY').toUpperCase(),
                    components: [
                        { type: 'BODY', text: bd.numbered, example: bd.vars.length ? { body_text: [bd.vars.map(() => 'sample')] } : undefined }
                    ]
                };
                if (d.footer) payload.components.push({ type: 'FOOTER', text: String(d.footer).slice(0, 60) });
                const r = await waGraphPost(c, '/' + c.wabaId + '/message_templates', payload);
                if (!r || !r.id) return json(res, 502, { error: (r && r.error && r.error.message) || 'Meta rejected the template' });
                auditLog('whatsapp-template-submit', 'whatsappTemplates', { name: payload.name, id: r.id }, su.username);
                return json(res, 200, { id: r.id, status: r.status || 'PENDING' });
            } catch (e) { json(res, 500, { error: e.message || e }); }
        });
        return true;
    }


// POST /api/send-sms â€” send bulk SMS via Africa's Talking
    // -----------------------------------------------------------
    // Automatic WhatsApp sender — status / pairing code / queue / unpair
    // -----------------------------------------------------------

    // -----------------------------------------------------------
    // GET /api/report — institutional report (scope x period x window)
    // scope: country | region | center   (id = the entity id)
    // period: monthly | quarterly | biannual | annual
    // start/end: YYYY-MM-DD window; vision: optional free-text plan
    // type: summary | detailed  (controls how much the client renders)
    // -----------------------------------------------------------
    if (parts.length === 3 && parts[1] === 'report' && parts[2] === 'data' && req.method === 'GET') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const su = getRequestUser(req);
        if (!su) return json(res, 401, { error: 'Not authenticated' });
        if (su.role === 'student') return json(res, 403, { error: 'Not available to students' });
        try {
            const u = new URL(req.url, 'http://localhost');
            const get = k => (u.searchParams.get(k) || '').trim();
            let rep;
            try {
                rep = require('./report-engine').generateReport(db, {
                    scope: get('scope') || 'country',
                    id: get('id'),
                    period: get('period') || 'annual',
                    start: get('start'),
                    end: get('end'),
                    vision: get('vision')
                });
            } catch (e) { return json(res, 500, { error: 'Report failed: ' + (e.message || e) }); }
            rep.requestedBy = su.username;
            return json(res, 200, rep);
        } catch (e) { return json(res, 500, { error: e.message || e }); }
    }

    // POST /api/report/scope-options — entities the admin may report on,
    // already filtered to what this user is allowed to see.
    if (parts.length === 3 && parts[1] === 'report' && parts[2] === 'scope-options' && req.method === 'GET') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const su = getRequestUser(req);
        if (!su) return json(res, 401, { error: 'Not authenticated' });
        if (su.role === 'student') return json(res, 403, { error: 'Not available to students' });
        const countries = ((db.settings || []).find(x => x.key === 'countries') || { value: [] }).value || [];
        let centers = db.studyCenters || [], regions = db.regions || [];
        const vsu = su.user || {};
        if (vsu.country) { centers = centers.filter(c => String(c.country) === String(vsu.country)); regions = regions.filter(r => String(r.country) === String(vsu.country)); }
        if (vsu.regionId) { centers = centers.filter(c => String(c.regionId) === String(vsu.regionId)); }
        return json(res, 200, {
            countries: countries.map(c => ({ id: c.code, name: c.brandName || c.name })),
            regions: regions.map(r => ({ id: r.id, name: r.name })),
            centers: centers.map(c => ({ id: c.id, name: c.name, regionId: c.regionId, country: c.country }))
        });
    }

    // GET /api/wa-auto/status — engine state for the pairing card.
    if (parts.length === 3 && parts[1] === 'wa-auto' && parts[2] === 'status' && req.method === 'GET') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const su = getRequestUser(req);
        if (!su) return json(res, 401, { error: 'Not authenticated' });
        if (su.role === 'student') return json(res, 403, { error: 'Not available to students' });
        return json(res, 200, waAuto().status());
    }
    // GET /api/wa-auto/qr — fresh pairing code as a data URL, only while unpaired.
    if (parts.length === 3 && parts[1] === 'wa-auto' && parts[2] === 'qr' && req.method === 'GET') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const su = getRequestUser(req);
        if (!su) return json(res, 401, { error: 'Not authenticated' });
        if (su.role === 'student') return json(res, 403, { error: 'Not available to students' });
        waAuto().qrDataUrl().then(function (q) {
            if (!q) return json(res, 404, { error: 'No pairing code right now - already paired or engine starting' });
            return json(res, 200, { qr: q });
        }).catch(function (e) { json(res, 500, { error: e.message || e }); });
        return true;
    }
    // POST /api/wa-auto/enqueue — queue resolved messages for automatic sending.
    if (parts.length === 3 && parts[1] === 'wa-auto' && parts[2] === 'enqueue' && req.method === 'POST') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const su = getRequestUser(req);
        if (!su) return json(res, 401, { error: 'Not authenticated' });
        if (!canAccessStore(su, 'whatsappLog', 'POST')) return json(res, 403, { error: 'Insufficient permissions' });
        let body = '';
        req.on('data', function (ch) { body += ch; });
        req.on('end', async function () {
            try {
                const d = JSON.parse(body);
                const r = waAuto().enqueue(d.jobs, su.username, { label: d.label, template: d.template });
                return json(res, 200, { queued: r.queued, runId: r.runId, pending: waAuto().pendingCount() });
            } catch (e) { json(res, 500, { error: e.message || e }); }
        });
        return true;
    }
    // POST /api/wa-auto/logout — unpair this server from WhatsApp.
    if (parts.length === 3 && parts[1] === 'wa-auto' && parts[2] === 'logout' && req.method === 'POST') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const su = getRequestUser(req);
        if (!su) return json(res, 401, { error: 'Not authenticated' });
        if (!canAccessStore(su, 'whatsappLog', 'POST')) return json(res, 403, { error: 'Insufficient permissions' });
        waAuto().logout().then(function () {
            auditLog('whatsapp-auto-logout', 'whatsappOutbox', {}, su.username);
            return json(res, 200, { ok: true });
        }).catch(function (e) { json(res, 500, { error: e.message || e }); });
        return true;
    }
    // GET /api/whatsapp-activity/recent — one small call powers the whole
    // WhatsApp screen: newest runs, newest log lines (slim), queue depth and
    // store totals. Reading this instead of the full stores is what keeps bulk
    // feedback light no matter how many thousands of messages have been sent.
    if (parts.length === 3 && parts[1] === 'whatsapp-activity' && parts[2] === 'recent' && req.method === 'GET') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const su = getRequestUser(req);
        if (!su) return json(res, 401, { error: 'Not authenticated' });
        if (su.role === 'student') return json(res, 403, { error: 'Not available to students' });
        const slimLog = function (e) {
            return {
                id: e.id, phone: e.phone, name: e.name,
                message: String(e.message || '').substring(0, 120),
                date: e.date, time: e.time, template: e.template,
                status: e.status || 'sent', sentBy: e.sentBy || ''
            };
        };
        const slimRun = function (r) {
            return {
                id: r.id, label: r.label, template: r.template, channel: r.channel,
                total: r.total, sent: r.sent, failed: r.failed,
                by: r.by, startedAt: r.startedAt, completedAt: r.completedAt, status: r.status
            };
        };
        let runs = [], log = [], outbox = [];
        try { runs = filterStoreForUser(su, 'whatsappRuns', db.whatsappRuns || []); } catch (e) { runs = []; }
        try { log = filterStoreForUser(su, 'whatsappLog', db.whatsappLog || []); } catch (e) { log = []; }
        try { outbox = filterStoreForUser(su, 'whatsappOutbox', db.whatsappOutbox || []); } catch (e) { outbox = []; }
        runs.sort(function (a, b) { return String(a.startedAt) < String(b.startedAt) ? 1 : -1; });
        log.sort(function (a, b) { return String(a.createdAt) < String(b.createdAt) ? 1 : -1; });
        const pending = outbox.filter(function (j) { return j && (j.status === 'queued' || j.status === 'sending'); }).length;
        return json(res, 200, {
            runs: runs.slice(0, 20).map(slimRun),
            log: log.slice(0, 60).map(slimLog),
            pending: pending,
            totals: { runs: runs.length, log: log.length, outbox: outbox.length }
        });
    }
    // POST /api/send-sms - send bulk SMS via Africa's Talking
    if (parts.length === 2 && parts[1] === 'send-sms' && req.method === 'POST') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const smsUser = getRequestUser(req);
        if (!smsUser) return json(res, 401, { error: 'Not authenticated' });
        if (!canAccessStore(smsUser, 'sms', 'POST')) return json(res, 403, { error: 'Insufficient permissions to send SMS' });
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

                // Send in waves of 10 so a big recipient list doesn't stall the event loop, and
                // never block the response, but keep ordering of the totals exact.
                async function sendOne(phone, message) {
                    if (!phone || !message) { return false; }
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
                            return !!(r && (r.status === 'Success' || r.statusCode === '101'));
                        }
                        return false;
                    } catch { return false; }
                }
                for (let i = 0; i < recipients.length; i += 10) {
                    const wave = recipients.slice(i, i + 10).map(({ phone, message }) => sendOne(phone, message));
                    const results = await Promise.all(wave);
                    results.forEach(ok => { if (ok) sent++; else failed++; });
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
                    const { name, email, phone, program: prog, country, studyCenterId, regionId } = data;
                    if (!name || !phone || !prog) return json(res, 400, { error: 'Name, phone, and program are required' });
                    const postedCountry = typeof country === 'string' ? country.trim().slice(0, 120) : '';
                    // Check duplicate phone
                    if (!db.students) db.students = [];
                    const existing = db.students.find(s => s.phone && s.phone.replace(/[^0-9]/g,'') === phone.replace(/[^0-9]/g,'') && s.status !== 'rejected');
                    if (existing) return json(res, 409, { error: 'Phone already registered' });
                    // Generate admission number using the COUNTRY-WIDE sequence.
                    // First segment is ALWAYS the global institute code ("NF");
                    // the middle is the study-center code, which carries the
                    // country identity (e.g. "UNSC"); sequence rolls across all
                    // centers of one country and is stored per country.
                    const center = studyCenterId ? db.studyCenters?.find(c => c.id === studyCenterId) : null;
                    const centerCode = center && center.code ? String(center.code).trim().replace(/\//g,'') : (center && center.name ? (String(center.name).toUpperCase().replace(/[^A-Z0-9]/g,' ').trim().split(/\s+/).filter(Boolean).slice(0,2).map(p=>p[0]).join('').substring(0,4) || 'CTR') : 'CTR');
                    // The signup request carries the country explicitly (login-screen
                    // country dropdown); it must agree with the selected center/region.
                    const derivedCountry = (center && center.country) || (regionId ? (db.regions || []).find(r => r.id === regionId)?.country : '') || '';
                    if (center && center.country && postedCountry && String(center.country) !== postedCountry) {
                        return json(res, 400, { error: 'Selected study center is not in the chosen country' });
                    }
                    const centerCountry = postedCountry || derivedCountry;
                    const branding = db.settings ? db.settings.find(s => s.key === 'branding') : null;
                    const instituteCode = branding && branding.initials ? branding.initials : 'NF';
                    const counterKey = centerCountry ? 'admissionLastSeqByCountry' : 'admissionLastSeq';
                    const counterRec = db.settings ? db.settings.find(s => s.key === counterKey) : null;
                    let admSeq = 0;
                    if (centerCountry) {
                        const cObj = counterRec && counterRec.value && typeof counterRec.value === 'object' ? counterRec.value : {};
                        if (typeof cObj[centerCountry] === 'number') admSeq = cObj[centerCountry];
                    } else if (counterRec && typeof counterRec.value === 'number') {
                        admSeq = counterRec.value;
                    }
                    // Max seq among existing students of THIS country only
                    // (untagged students never count toward a country roll).
                    let maxSeq = 0;
                    db.students.forEach(s => {
                        if (centerCountry) {
                            const sCenter = s.studyCenterId ? db.studyCenters?.find(c => c.id === s.studyCenterId) : null;
                            const sCountry = s.country || (sCenter && sCenter.country) || '';
                            if (sCountry !== centerCountry) return;
                        }
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
                    if (centerCountry) {
                        const idx2 = db.settings.findIndex(s => s.key === counterKey);
                        const cObj = idx2 >= 0 && db.settings[idx2].value && typeof db.settings[idx2].value === 'object' ? db.settings[idx2].value : {};
                        cObj[centerCountry] = nextSeq;
                        if (idx2 >= 0) db.settings[idx2] = { key: counterKey, value: cObj };
                        else db.settings.push({ key: counterKey, value: cObj });
                    } else {
                        const idx3 = db.settings.findIndex(s => s.key === counterKey);
                        if (idx3 >= 0) db.settings[idx3] = { key: counterKey, value: nextSeq };
                        else db.settings.push({ key: counterKey, value: nextSeq });
                    }
                    // Build admission number
                    const year = new Date().getFullYear().toString().slice(-2);
                    const month = String(new Date().getMonth() + 1).padStart(2, '0');
                    const seqStr = String(nextSeq).padStart(3, '0');
                    const admissionNumber = `${instituteCode}/${centerCode}/${month}-${year}/${seqStr}`;
                    const studentId = 'STU-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
                    const student = {
                        id: studentId, name, email, phone, program: prog, studyCenterId: studyCenterId || '', regionId: regionId || '',
                        admissionNumber, country: centerCountry, status: 'pending', year: 1, feeAmount: 0,
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

    // Lesson drip engine â€” POST /api/drip/sync
    // action state | read | video | evaluate | manual. Server-authoritative: recomputes
    // completions (read seconds + lesson video watched >= 90% of its duration + linked-
    // quiz best >= 50), enforces the drip chain with per-course pacing
    // (course.dripDaysBetween; 0 = instant; default 3.5d) and the weekly fee gate,
    // then persists the authoritive unlock/completion records. Students act on their
    // own record only; staff may name any learner.
    if (parts.length === 3 && parts[1] === 'drip' && parts[2] === 'sync' && req.method === 'POST') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const user = getRequestUser(req);
        if (!user) return json(res, 401, { error: 'Unauthorized' });
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', () => {
            try {
                const parsed = JSON.parse(raw || '{}');
                const action = parsed.action || 'state';
                let sid = null;
                if (user.role === 'student') {
                    const su = user.user || {};
                    const own = String(su.studentId || user.username || '');
                    if (parsed.studentId && String(parsed.studentId) !== own) return json(res, 403, { error: 'Students may only manage their own drip state' });
                    sid = own;
                } else {
                    if (!parsed.studentId) return json(res, 400, { error: 'studentId required for staff requests' });
                    sid = String(parsed.studentId);
                }
                if (!sid) return json(res, 400, { error: 'Student not identified' });
                db.lessonUnlocks = db.lessonUnlocks || [];
                db.lessonCompletions = db.lessonCompletions || [];
                const E = dripEngine;
                const persist = (stores) => {
                    (Array.isArray(stores) ? stores : [stores]).forEach(s => { try { broadcastEvent('db-change', { store: s }); } catch (e) {} });
                    saveDB();
                };
                let result = { ok: true, action };
                if (action === 'state') {
                    const sweep = E.dripSweep(db, sid, parsed.courseId ? String(parsed.courseId) : null);
                    if (sweep.changed) persist(['lessonUnlocks', 'lessonCompletions']);
                    const maps = E.dripMapsFor(db, sid);
                    result.unlocks = maps.unlocks;
                    result.completions = maps.completions;
                    result.paces = maps.paces;
                    result.fee = sweep.fee;
                    if (parsed.courseId) result.next = E.dripNextInfo(db, sid, String(parsed.courseId), null);
                } else if (action === 'read') {
                    if (!parsed.lessonId) return json(res, 400, { error: 'lessonId required' });
                    const lesson = (db.lessons || []).find(l => String(l.id) === String(parsed.lessonId));
                    if (!lesson) return json(res, 404, { error: 'Lesson not found' });
                    const add = Math.max(0, Math.min(86400, parseInt(parsed.readSecs, 10) || 0));
                    const reqSecs = E.dripReadEstimateSecs(E.dripLessonContent(db, lesson));
                    let comp = db.lessonCompletions.find(r => String(r.studentId) === String(sid) && String(r.lessonId) === String(lesson.id));
                    if (!comp) {
                        comp = { id: E.dripRecId('LC', sid, lesson.id), studentId: String(sid), lessonId: String(lesson.id), courseId: String(lesson.courseId || ''), readSecs: 0 };
                        db.lessonCompletions.push(comp);
                    }
                    if (parsed.reset === true) {
                        comp.readSecs = 0; comp.readDoneAt = null; comp.quizPassedAt = null; comp.quizBest = undefined; comp.completedAt = null;
                    } else {
                        comp.readSecs = Math.min((comp.readSecs || 0) + add, 86400);
                    }
                    comp.requiredSecs = reqSecs;
                    // Re-evaluate authoritatively so read time alone can complete a
                    // lesson (reading is tracked for EVERY lesson now, not just
                    // sequenced ones) and the chain can advance without waiting for
                    // a separate client 'evaluate' round trip.
                    const evaled = E.dripEvalCompletion(db, sid, lesson);
                    const sweepR = E.dripSweep(db, sid, String(lesson.courseId || ''));
                    if (sweepR.changed) persist(['lessonCompletions', 'lessonUnlocks']); else persist('lessonCompletions');
                    result.completion = evaled;
                    result.justCompleted = !!evaled.justCompleted;
                    result.videoRequired = !!evaled.videoRequired;
                    if (sweepR.changed) {
                        const maps = E.dripMapsFor(db, sid);
                        result.unlocks = maps.unlocks;
                        result.completions = maps.completions;
                        result.paces = maps.paces;
                    }
                } else if (action === 'video') {
                    // Watched-video seconds for one lesson. The client only credits
                    // FORWARD playback, and the server re-checks the duration ratio,
                    // so dragging the scrubber to the end does not complete a lesson.
                    if (!parsed.lessonId) return json(res, 400, { error: 'lessonId required' });
                    const lesson = (db.lessons || []).find(l => String(l.id) === String(parsed.lessonId));
                    if (!lesson) return json(res, 404, { error: 'Lesson not found' });
                    // Videos are tracked individually so Video 2 only opens
                    // after Video 1 has been watched.
                    const videos = E.dripLessonVideos(lesson);
                    const wanted = String(parsed.videoId || '');
                    const target = videos.find(v => String(v.id) === wanted) || videos[0];
                    if (!target || !E.dripVideoTrackable(target.url)) return json(res, 400, { error: 'This lesson has no trackable video' });
                    // Never credit a video that is still locked behind the previous one.
                    const statesNow = E.dripVideoStates(lesson, db.lessonCompletions.find(r => String(r.studentId) === String(sid) && String(r.lessonId) === String(lesson.id)));
                    const targetState = statesNow.find(x => String(x.id) === String(target.id));
                    if (targetState && targetState.state === 'locked') return json(res, 409, { error: 'Finish the previous video first', videos: statesNow });
                    const add = Math.max(0, Math.min(86400, Math.round(Number(parsed.addSecs) || 0)));
                    const dur = Math.max(0, Math.min(60 * 60 * 12, Math.round(Number(parsed.durationSecs) || 0)));
                    let comp = db.lessonCompletions.find(r => String(r.studentId) === String(sid) && String(r.lessonId) === String(lesson.id));
                    if (!comp) {
                        comp = { id: E.dripRecId('LC', sid, lesson.id), studentId: String(sid), lessonId: String(lesson.id), courseId: String(lesson.courseId || ''), readSecs: 0 };
                        db.lessonCompletions.push(comp);
                    }
                    if (parsed.reset === true) {
                        comp.videoSecs = 0; comp.videoDoneAt = null;
                    } else {
                        // Cap credited seconds at the real duration (plus a small
                        // tolerance for player rounding) so a looping embed cannot
                        // bank unlimited credit.
                        const ceiling = dur > 0 ? dur * 1.25 : 86400;
                        // Credit accumulates: take the seconds already banked for
                        // THIS video, add the forward playback reported by the
                        // player, then cap at the real duration.
                        const banked = (comp.videoProgress && comp.videoProgress[target.id] && Number(comp.videoProgress[target.id].secs)) || (target.id === 'V1' ? Number(comp.videoSecs) || 0 : 0);
                        const total = Math.min(banked + add, ceiling);
                        E.dripRecordVideoProgress(comp, target.id, total, dur);
                        // Keep the legacy lesson-level fields in step so older
                        // screens keep reporting the same progress.
                        if (target.id === 'V1') comp.videoSecs = total;
                    }
                    if (dur > 0) comp.videoDurationSecs = dur;
                    const evaled = E.dripEvalCompletion(db, sid, lesson);
                    const sweepV = E.dripSweep(db, sid, String(lesson.courseId || ''));
                    if (sweepV.changed) persist(['lessonCompletions', 'lessonUnlocks']); else persist('lessonCompletions');
                    result.completion = evaled;
                    result.videoDone = !!evaled.videoDoneAt;
                    result.videos = evaled.videoStates || E.dripVideoStates(lesson, evaled);
                    result.justCompleted = !!evaled.justCompleted;
                    result.requiredRatio = E.DRIP_VIDEO_RATIO;
                    if (dur > 0) result.videoPct = Math.min(100, Math.round(((evaled.videoSecs || 0) / dur) * 100));
                    const maps = E.dripMapsFor(db, sid);
                    result.unlocks = maps.unlocks;
                    result.completions = maps.completions;
                    result.paces = maps.paces;
                } else if (action === 'evaluate') {
                    if (!parsed.lessonId) return json(res, 400, { error: 'lessonId required' });
                    const lesson = (db.lessons || []).find(l => String(l.id) === String(parsed.lessonId));
                    if (!lesson) return json(res, 404, { error: 'Lesson not found' });
                    const comp = E.dripEvalCompletion(db, sid, lesson);
                    const sweep = E.dripSweep(db, sid, String(lesson.courseId || ''));
                    if (sweep.changed) persist(['lessonUnlocks']);
                    persist('lessonCompletions');
                    result.completion = comp;
                    result.justCompleted = !!comp.justCompleted;
                    result.videoRequired = !!comp.videoRequired;
                    result.videoDone = !!comp.videoDoneAt;
                    result.videos = comp.videoStates || E.dripVideoStates(lesson, comp);
                    result.quiz = E.dripQuizBestForLesson(db, sid, lesson.id);
                    result.next = E.dripNextInfo(db, sid, String(lesson.courseId || ''), lesson.id);
                    result.fee = sweep.fee;
                    const maps = E.dripMapsFor(db, sid);
                    result.unlocks = maps.unlocks;
                    result.completions = maps.completions;
                    result.paces = maps.paces;
                } else if (action === 'manual') {
                    // Staff-only, except the learner's own choice to continue past a
                    // lesson quiz they have not passed.
                    const learnerOps = { 'quiz-overlook': true };
                    if (user.role === 'student' && !learnerOps[String(parsed.op)]) return json(res, 403, { error: 'Only staff can manage learner drip states' });
                    if (!parsed.lessonId || !parsed.op) return json(res, 400, { error: 'lessonId and op required' });
                    const lesson = (db.lessons || []).find(l => String(l.id) === String(parsed.lessonId));
                    if (!lesson) return json(res, 404, { error: 'Lesson not found' });
                    if (parsed.op === 'unlock') {
                        if (!db.lessonUnlocks.some(r => String(r.studentId) === String(sid) && String(r.lessonId) === String(lesson.id))) {
                            db.lessonUnlocks.push({ id: E.dripRecId('LU', sid, lesson.id), studentId: String(sid), lessonId: String(lesson.id), courseId: String(lesson.courseId || ''), unlockedAt: new Date().toISOString(), by: 'manual' });
                        }
                        persist('lessonUnlocks');
                    } else if (parsed.op === 'complete') {
                        const comp = E.dripEvalCompletion(db, sid, lesson);
                        const now = new Date().toISOString();
                        comp.readDoneAt = comp.readDoneAt || now; comp.quizPassedAt = comp.quizPassedAt || now; comp.completedAt = comp.completedAt || now;
                        if (E.dripVideoRequired(lesson)) comp.videoDoneAt = comp.videoDoneAt || now;
                        comp.manualBy = 'staff';
                        const sweep = E.dripSweep(db, sid, String(lesson.courseId || ''));
                        if (sweep.changed) persist(['lessonUnlocks', 'lessonCompletions']); else persist('lessonCompletions');
                        result.completion = comp;
                    } else if (parsed.op === 'repeat') {
                        const comp = E.dripEvalCompletion(db, sid, lesson, { resetForRepeat: true });
                        persist('lessonCompletions');
                        result.completion = comp;
                    } else if (parsed.op === 'reset') {
                        db.lessonCompletions = db.lessonCompletions.filter(r => !(String(r.studentId) === String(sid) && String(r.lessonId) === String(lesson.id)));
                        db.lessonUnlocks = db.lessonUnlocks.filter(r => !(String(r.studentId) === String(sid) && String(r.lessonId) === String(lesson.id)));
                        persist(['lessonCompletions', 'lessonUnlocks']);
                    } else if (parsed.op === 'quiz-overlook') {
                        // A learner who failed this lesson's quiz can choose to
                        // continue anyway. Recorded on the completion row so the
                        // attempt is auditable and the next lesson can open.
                        if (!parsed.allow && user.role === 'student') {
                            return json(res, 403, { error: 'Overlooking a lesson quiz requires your choice to be recorded' });
                        }
                        const comp = E.dripEvalCompletion(db, sid, lesson);
                        const q = E.dripQuizBestForLesson(db, sid, lesson.id);
                        if (q.passed) return json(res, 400, { error: 'This quiz is already passed' });
                        comp.quizSkippedAt = new Date().toISOString();
                        comp.quizOverlookedBy = 'student';
                        comp.quizAttemptsAtSkip = q.attemptsUsed || 0;
                        const sweep2 = E.dripSweep(db, sid, String(lesson.courseId || ''));
                        if (sweep2.changed) persist(['lessonCompletions', 'lessonUnlocks']); else persist('lessonCompletions');
                        result.completion = comp;
                        result.quiz = E.dripQuizBestForLesson(db, sid, lesson.id);
                        result.next = E.dripNextInfo(db, sid, String(lesson.courseId || ''), lesson.id);
                        auditLog('overlooked-quiz', 'lessonCompletions', { lessonId: lesson.id, attempts: q.attemptsUsed }, user && user.username);
                    } else if (parsed.op === 'quiz-retry') {
                        // Granting a further attempt after the retries ran out.
                        if (user.role === 'student') return json(res, 403, { error: 'Only staff can grant extra attempts' });
                        const comp2 = E.dripEvalCompletion(db, sid, lesson);
                        comp2.quizSkippedAt = null;
                        comp2.extraAttemptsGranted = (comp2.extraAttemptsGranted || 0) + 1;
                        persist('lessonCompletions');
                        result.completion = comp2;
                    } else {
                        return json(res, 400, { error: 'Unknown op' });
                    }
                    const maps = E.dripMapsFor(db, sid);
                    result.unlocks = maps.unlocks;
                    result.completions = maps.completions;
                    result.paces = maps.paces;
                } else {
                    return json(res, 400, { error: 'Unknown action' });
                }
                json(res, 200, result);
            } catch (e) {
                console.error('drip sync error:', e && e.message);
                json(res, 500, { error: e.message || 'Drip sync failed' });
            }
        });
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

    // Raw PDF template stream — bypasses the settings JSON/base64 pipeline so the
    // generator always loads the authoritative bytes from disk (docs/settings-<key>-template.pdf).
    if (parts.length === 3 && parts[1] === 'settings-template' && req.method === 'GET') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const key = parts[2];
        if (!SETTINGS_BLOBS[key]) return json(res, 404, { error: 'Unknown template' });
        const user = getRequestUser(req);
        if (!canAccessStore(user, 'certificates', 'GET')) return json(res, 403, { error: 'Forbidden' });
        const tplType = key === 'completionPdfConfig' ? 'completion' : key === 'diplomaPdfConfig' ? 'diploma' : null;
        if (tplType && !docTypeEnabledFor(user, tplType)) {
            return json(res, 403, { error: 'Generate ' + tplType + ' is disabled for your country by the administrator' });
        }
        const file = settingsBlobPath(key);
        if (!fs.existsSync(file)) return json(res, 404, { error: 'No template stored. Upload a PDF template in Settings.' });
        try {
            const buf = fs.readFileSync(file);
            res.writeHead(200, {
                'Content-Type': 'application/pdf',
                'Content-Length': buf.length,
                'Content-Disposition': 'inline; filename="template.pdf"',
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'no-store'
            });
            res.end(buf);
        } catch (e) { json(res, 500, { error: e.message || e }); }
        return true;
    }

    // -----------------------------------------------------------
    // Security & cleanup endpoints â€” /api/security/*
    // (admin only)
    // -----------------------------------------------------------
    if (parts.length >= 2 && parts[1] === 'security') {
        const secUser = getRequestUser(req);
        if (!secUser || (secUser.role !== 'admin' && secUser.role !== 'assistant')) return json(res, 403, { error: 'Admin only' });
        if (secUser.role === 'assistant' && parts[2] !== 'status') return json(res, 403, { error: 'Admin only' });
        if (parts.length === 2 || parts[2] === 'status') {
            const blocked = [];
            SECURE.blockedFiles.forEach(p => blocked.push(relTracked(p)));
            const secAudit = (db.audit || []).filter(a => String(a.action || '').indexOf('tamper') !== -1 || String(a.entity || '') === 'security').slice(-15);
            return json(res, 200, {
                ok: true,
                baseline: SECURE.manifest ? { createdAt: SECURE.manifest.createdAt, updatedAt: SECURE.manifest.updatedAt, files: Object.keys(SECURE.manifest.files).length } : null,
                lastCheck: SECURE.lastCheck,
                blockedFiles: blocked,
                candidates: collectCleanupCandidates(),
                candidatesAt: SECURE.candidatesAt,
                recentSecurityAudit: secAudit
            });
        }
        if (parts[2] === 'check' && req.method === 'POST') {
            runIntegrityCheck();
            return json(res, 200, { ok: true, lastCheck: SECURE.lastCheck, blockedFiles: Array.from(SECURE.blockedFiles).map(relTracked) });
        }
        if (parts[2] === 'rebaseline' && req.method === 'POST') {
            createIntegrityBaseline();
            auditLog('rebaselined', 'security', { files: Object.keys(SECURE.manifest.files).length }, secUser.username);
            return json(res, 200, { ok: true, message: 'Baseline updated — all served code files are now trusted.' });
        }
        if (parts[2] === 'cleanup' && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body) || {};
                    const confirmations = Array.isArray(parsed.confirmations) ? parsed.confirmations : [];
                    const results = applyCleanupConfirmations(confirmations);
                    json(res, 200, results);
                } catch (e) { json(res, 400, { error: 'Invalid JSON' }); }
            });
            return true;
        }
        return json(res, 404, { error: 'Unknown security action' });
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
            const previewB = (user && user.role === 'admin') ? (urlObj.searchParams.get('preview') || '') : '';
            if (previewB) {
                try { console.log('[preview] admin ' + user.username + ' viewing as ' + previewB + ' store=' + name); } catch {}
                rows = filterStoreForUser({ role: 'coordinator', username: user.username, user: { role: 'coordinator', country: previewB } }, name, rows);
            }
            if (name === 'settings' && (!user || user.role !== 'admin')) {
                rows = rows.filter(r => r && r.key !== 'smsSettings');
            }
            rows = backfillCertIdentifiers(name, rows);
            rows = externalizeStoreRecords(name, rows);
            if (name === 'settings') rows = rows.map(injectSettingsBlobs);
            if (name === 'settings' && (!user || user.role !== 'admin')) {
                rows = rows.map(r => (r && r.key === 'mpesa') ? { key: 'mpesa', payButtonEnabled: !!((r.value || r).payButtonEnabled) } : r);
            }
            // Anonymous callers only ever see the public slice of these stores.
            if (!user) {
                if (name === 'settings') rows = publicSettingsView(rows);
                else if (name === 'studyCenters') rows = rows.map(r => projectRecord(r, PUBLIC_CENTER_FIELDS));
                else if (name === 'regions') rows = rows.map(r => projectRecord(r, PUBLIC_REGION_FIELDS));
            }
            result[name] = rows;
        }
return json(res, 200, result);
    }

    // POST /api/db/batch — upsert many records in ONE request: one broadcast, one debounced
    // save. Used by attendance save (was N sequential PUTs + N broadcasts per student).
    if (parts.length === 3 && parts[1] === 'db' && parts[2] === 'batch' && req.method === 'POST') {
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);
        const user = getRequestUser(req);
        if (!user) return json(res, 401, { error: 'Not authenticated' });
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body);
                const store = parsed.store;
                const records = parsed.records;
                if (!store || !Array.isArray(records)) return json(res, 400, { error: 'Expected { store, records[] }' });
                if (!canAccessStore(user, store, 'PUT')) return json(res, 403, { error: 'Insufficient permissions for this resource' });
                const KEY_PATHS = { settings: 'key', counters: 'key', users: 'username', transcriptVerifications: 'docId', manuals: 'id' };
                const keyPath = KEY_PATHS[store] || 'id';
                if (!db[store]) db[store] = [];
                const result = { ok: 0, errors: [] };
                const isDocStore = store === 'certificates' || store === 'idCards' || store === 'idcards';
                for (const rec of records) {
                    if (!rec || typeof rec !== 'object') { result.errors.push({ error: 'Not an object' }); continue; }
                    if ((store === 'alumniEnrollments' || store === 'enrollments') && user && user.role === 'student' && (store === 'alumniEnrollments' || isAlumniAccount(user))) {
                        result.errors.push({ error: store === 'alumniEnrollments' ? 'Use single-record alumni enrollment' : 'Alumni course access is managed through alumni enrolment' });
                        continue;
                    }
                    if (store === 'settings') {
                        const extErr = externalizeSettingsRecord(rec);
                        if (extErr) { result.errors.push({ error: extErr }); continue; }
                    }
                    let r = rec;
                    if (isDocStore) {
                        r = archiveHtmlContent(externalizeCertificate(rec).record);
                    }
                    if (isDocStore && (r.type === 'diploma' || r.type === 'completion') && !docTypeEnabledFor(user, r.type)) {
                        result.errors.push({ error: 'Generate ' + r.type + ' is disabled for your country by the administrator' });
                        continue;
                    }
                    sanitizeBodyFields(r, 20000, isDocStore ? ['content'] : (store === 'settings' ? brandingImageKeys(rec) : null));
                    const pk = r[keyPath];
                    if (pk === undefined || pk === null) { result.errors.push({ error: 'Missing key field "' + keyPath + '"' }); continue; }
                    const _exB = db[store].find(x => x[keyPath] === pk) || null;
                    preserveDocIdentity(store, r, _exB);
                    const _scB = scopeWrite(user, store, r, _exB);
                    if (_scB) { result.errors.push({ error: _scB }); continue; }
                    if (store === 'alumniEnrollments' && user && user.role === 'student') {
                        const alumniBatchErr = studentAlumniEnrollmentError(user, r, _exB);
                        if (alumniBatchErr) { result.errors.push({ error: alumniBatchErr }); continue; }
                    }
                    const idx = db[store].findIndex(x => x[keyPath] === pk);
                    if (idx >= 0) db[store][idx] = r;
                    else db[store].push(r);
                    result.ok++;
                }
                if (result.ok) { broadcastEvent('db-change', { store }); saveDB(); }
                return json(res, 200, result);
            } catch (e) { return json(res, 400, { error: 'Invalid JSON' }); }
        });
        return true;
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
        // Pruning is an explicit instruction, so the archive goes with it.
        clearLogArchive('audit');
        saveDB();
        broadcastEvent('db-change', { store: 'audit' });
        return json(res, 200, { ok: true, remaining: db.audit.length });
    }

    if (parts.length >= 2 && parts[1] === 'db') {
        const store = decodeURIComponent(parts[2]);
        const key = parts[3] ? decodeURIComponent(parts[3]) : null;

        // Maintenance mode: only admins can touch data
        if (isMaintenanceActive() && !isAdminRequest(req)) return maintenanceBlocked(res);

        // Authorization check
        const user = getRequestUser(req);
        // Students may NOT write users — EXCEPT their own terms-acceptance record,
        // which is read by the Terms modal at login. The PUT handler below still
        // verifies ownership and limits the mutated fields.
        const studentSelfTerms = req.method === 'PUT' && store === 'users' && user && user.role === 'student';
        // Branding is public/cosmetic (school name, logo, terms) and is already
        // injected into every served HTML page for ANONYMOUS visitors (see the
        // branding injection in serveIndex). Therefore any authenticated user —
        // including a coordinator — may always READ the branding key; it contains
        // nothing sensitive and mirrors what anonymous visitors already get.
        // The academic key (program names + fees) is likewise read-only operational
        // config that coordinators need to open the Add Student / Quick Enroll
        // forms (program feeds + fee auto-fill); it is never granted for writes.
        // The PDF generator configs (diploma/completion template + field layout) and
        // the per-country documentGenFlags toggles are readable by anyone who can
        // access the certificates store (coordinators generate these documents
        // themselves). Per-country OFF flags are enforced server-side on writes.
        const certCapableRead = !!user && canAccessStore(user, 'certificates', 'GET');
        const settingsReadExempt = req.method === 'GET' && store === 'settings' && (
            key === 'branding' || key === 'academic' ||
            (certCapableRead && (key === 'completionPdfConfig' || key === 'diplomaPdfConfig' || key === 'documentGenFlags'))
        );
        if (!studentSelfTerms && !settingsReadExempt && !canAccessStore(user, store, req.method)) {
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

        // Stores whose records may be pushed over the live stream to EVERY signed-in
// browser so screens can update without refetching. Only non-personal teaching
// content belongs here. Stores holding personal or secret data (users incl.
// password hashes/session tokens, students, messages, whatsappLog, smsLog,
// payments, grades, certificates, idCards, attendance, enrollments,
// examRegistrations, retakeRequests) are deliberately EXCLUDED and keep the
// signal-only broadcast, so no record can ever leak to the wrong person.
const LIVE_PUSH_STORES = new Set([
    'exams', 'quizzes', 'lessons', 'notes', 'courses',
    'questionBank', 'studyCenters', 'regions', 'announcements',
    'categories', 'programs', 'manuals'
]);

// Helper to save DB after mutations â€” broadcast FIRST so clients get instant notification
        function mutate(record, action) {
            // Invalidate derived-country index whenever its inputs change so
            // new students/centers/regions are resolvable immediately.
            if (store === 'students' || store === 'studyCenters' || store === 'regions') {
                invalidateCountryIndex();
            }
            if (store === 'settings') {
                invalidateSettingsCache();
                // Which tabs the owner grants the overall admin is a security
                // decision: every change is written to the audit trail.
                if (record && record.key === 'adminAccess') {
                    const acc = record.value !== undefined ? record.value : record;
                    const off = Object.keys(acc || {}).filter(k => k !== 'key' && k !== 'value' && acc[k] === false);
                    auditLog(action === 'delete' ? 'access-cleared' : 'access-change', 'adminAccess',
                        { disabledTabs: off, role: 'admin' }, user && user.username);
                }
            }
            if (record && record._cleared) record = null;            // whole-store clear: signal only
            if (record && LIVE_PUSH_STORES.has(store)) {
                broadcastStoreChange(store, record, action || (record._deleted ? 'delete' : 'upsert'));
            } else {
                broadcastEvent('db-change', { store });
            }
            saveDB();
        }

        // GET /api/db/:store   â€” return all records (with optional ?index=&value= filter, ?page=&limit=)
        if (req.method === 'GET' && !key) {
            let results = db[store] || [];

            // The alerts store grows continuously. The dashboard only shows the
            // newest ones, so cap the RESPONSE - the full history stays on disk.
            if (store === 'alerts' && results.length > 500) {
                results = results.slice().sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || ''))).slice(0, 500);
            }
            
            // The audit trail also grows without bound. Show the newest entries;
            // the full history stays on disk and the prune endpoint still works.
            if (store === 'audit' && results.length > 800) {
                results = results.slice().sort((x, y) => String(y.timestamp || y.date || '').localeCompare(String(x.timestamp || x.date || ''))).slice(0, 800);
            }
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
            // Overall-admin deep dive: ?preview=<country> re-scopes this read
            // exactly as that country's coordinator sees it. Admin only, read-only,
            // console-logged; it can only narrow, never widen.
            const previewA = (user && user.role === 'admin') ? (urlObj.searchParams.get('preview') || '') : '';
            if (previewA) {
                try { console.log('[preview] admin ' + user.username + ' viewing as ' + previewA + ' store=' + store); } catch {}
                results = filterStoreForUser({ role: 'coordinator', username: user.username, user: { role: 'coordinator', country: previewA } }, store, results);
            }

            // Non-admins must not read credential-bearing settings records
            if (store === 'settings' && (!user || user.role !== 'admin')) {
                results = results.filter(r => r && r.key !== 'smsSettings');
            }
            // For a country-scoped viewer (or admin previewing a country), the
            // branding record they receive is the country's own identity merged
            // over the global branding (brandName, initials, phone, postal).
            if (store === 'settings') {
                const effUser = previewA ? { role: 'coordinator', username: user.username, user: { role: 'coordinator', country: previewA } } : user;
                results = results.map(r => (r && r.key === 'branding') ? applyCountryBranding(effUser, r) : r);
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
            // Anonymous callers only ever see the public slice of these stores.
            if (!user) {
                if (store === 'settings') results = publicSettingsView(results);
                else if (store === 'studyCenters') results = results.map(r => projectRecord(r, PUBLIC_CENTER_FIELDS));
                else if (store === 'regions') results = results.map(r => projectRecord(r, PUBLIC_REGION_FIELDS));
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
            // Anonymous callers may only read the public settings keys. Every
            // other settings record (M-Pesa/SMS credentials, WhatsApp sender,
            // fee rules, admission sequence, PDF templates, ...) is staff-only.
            if (!user && store === 'settings' && !PUBLIC_SETTING_KEYS.has(key)) {
                return json(res, 401, { error: 'Not authenticated' });
            }
            const previewC = (user && user.role === 'admin') ? (urlObj.searchParams.get('preview') || '') : '';
            if (previewC) { try { console.log('[preview] admin ' + user.username + ' viewing as ' + previewC + ' store=' + store); } catch {} }
            if (item && ((user && user.role !== 'admin') || previewC)) {
                const effUser = previewC ? { role: 'coordinator', username: user.username, user: { role: 'coordinator', country: previewC } } : user;
                const filtered = filterStoreForUser(effUser, store, [item]);
                item = filtered.length ? filtered[0] : null;
            }
            if (item && store === 'settings' && key === 'smsSettings' && (!user || user.role !== 'admin')) {
                item = null;
            }
            if (item) {
                if (store === 'settings' && key === 'branding') {
                    const effUser = previewC ? { role: 'coordinator', username: user.username, user: { role: 'coordinator', country: previewC } } : user;
                    item = applyCountryBranding(effUser, item);
                }
                const list = externalizeStoreRecords(store, [item]);
                item = list[0] || null;
                if (store === 'settings') item = injectSettingsBlobs(item);
                // Anonymous callers never receive the signature images, the
                // college stamp or the tax PIN from the branding record.
                if (!user && store === 'settings' && item) item = stripPrivateBranding(item);
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
                    // PDF templates are externalized to disk BEFORE the generic 20k
                    // field cap would truncate their base64 (this silently corrupted
                    // every stored template and made generation fail).
                    if (store === 'settings') {
                        const extErr = externalizeSettingsRecord(value);
                        if (extErr) return json(res, 400, { error: extErr });
                    }
                    // Document records get their PDF content parked on disk and their
                    // long HTML content archived to disk (re-injected on read) so the
                    // field cap NEVER truncates a generated letter mid-image-tag.
                    const isDocStore = store === 'certificates' || store === 'idCards' || store === 'idcards';
                    let toStore = value;
                    if (isDocStore) {
                        toStore = archiveHtmlContent(externalizeCertificate(value).record);
                    }
                    if (isDocStore && (toStore.type === 'diploma' || toStore.type === 'completion') && !docTypeEnabledFor(user, toStore.type)) {
                        return json(res, 403, { error: 'Generate ' + toStore.type + ' is disabled for your country by the administrator' });
                    }
                    const preserveFields = isDocStore ? ['content'] : (store === 'settings' ? brandingImageKeys(value) : null);
                    sanitizeBodyFields(toStore, 20000, preserveFields);
                    if (store === 'settings' && value.key === 'maintenance' && (!user || user.role !== 'admin')) {
                        return json(res, 403, { error: 'Only administrators can change maintenance mode' });
                    }
                    if (store === 'settings' && value.key === 'assistantAccess' && (!user || user.role !== 'admin')) {
                        return json(res, 403, { error: 'Only administrators can change assistant access' });
                    }
                    if (store === 'settings' && value.key === 'adminAccess' && !isOwnerUser(user)) {
                        return json(res, 403, { error: 'Only the owner can change which tabs the administrator may open' });
                    }
                    if (store === 'settings' && value.key === 'owner' && !isOwnerUser(user)) {
                        return json(res, 403, { error: 'Only the owner can change the owner account' });
                    }
                    // One attempt has ONE grade record. If the browser sends a
                    // fresh id for an attempt that already has one, the existing
                    // record is reused - otherwise a retry would leave two
                    // grades for the same paper.
                    if (store === 'grades' && user && user.role === 'student' && toStore.quizId) {
                        try {
                            const priorRec = (db.grades || []).find(x => x && String(x.studentId) === String(toStore.studentId) && String(x.quizId) === String(toStore.quizId));
                            if (priorRec && priorRec.id && String(priorRec.id) !== String(toStore.id)) toStore.id = priorRec.id;
                        } catch {}
                    }
                    if (store === 'alumniEnrollments' && user && user.role === 'student') {
                        const prior = (db.alumniEnrollments || []).find(x => x && String(x.id) === String(toStore.id)) || null;
                        const alumniErr = studentAlumniEnrollmentError(user, toStore, prior);
                        if (alumniErr) return json(res, 403, { error: alumniErr });
                    }
                    if (store === 'enrollments' && user && user.role === 'student' && isAlumniAccount(user)) {
                        return json(res, 403, { error: 'Alumni course access is managed through alumni enrolment' });
                    }
                    const pk = toStore[keyPath];
                    if (pk === undefined || pk === null) {
                        console.log('PUT ' + store + ' FAILED - missing ' + keyPath + ' bodyKeys:', Object.keys(toStore));
                        return json(res, 400, { error: `Record missing key field "${keyPath}"` });
                    }
                    const _exPut = db[store].find(r => r[keyPath] === pk) || null;
                    preserveDocIdentity(store, toStore, _exPut);
                    const _scPut = scopeWrite(user, store, toStore, _exPut);
                    if (_scPut) return json(res, 403, { error: _scPut });
                    // A student may only record a grade that the SERVER scored.
                    // The submitted answers are re-marked here against the answer
                    // key, so a tampered client cannot award itself marks.
                    // A submitted paper must fall inside its scheduled window.
                    let subMark = null;
                    if (store === 'submissions') {
                        const target = (db.exams || []).find(e => e && (String(e.id) === String(toStore.quizId) || String(e.id) === String(toStore.examId)))
                            || (db.quizzes || []).find(q => q && String(q.id) === String(toStore.quizId));
                        if (target) {
                            const w = assessmentWindowServer(target, user);
                            if (w.closed) {
                                console.warn('[assessment-window] closed', target.id, w.closesAtISO, w.timeZone);
                                return json(res, 403, { error: 'This assessment closed on ' + w.closesAt + (w.closesAtISO ? ' at ' + w.closesAtISO.slice(11, 16) : '') + ' and can no longer be submitted.' });
                            }
                            if (w.notYetOpen && user && user.role === 'student') {
                                console.warn('[assessment-window] not yet open', target.id, w.opensAtISO, w.timeZone);
                                return json(res, 403, { error: 'This assessment opens on ' + w.opensAtISO.slice(0, 10) + ' at ' + w.opensAtISO.slice(11, 16) + '.' });
                            }
                        }
                        // A learner's own paper is marked HERE, not in the browser:
                        // the server re-marks the answers against the answer key,
                        // writes the authoritative score onto the submission and
                        // creates the grade record, so a submitted exam reaches
                        // the transcript in ONE write (a lost second write can no
                        // longer leave the score out of the results).
                        if (user && user.role === 'student') {
                            const sid = serverStudentId(user);
                            if (!sid) {
                                return json(res, 403, { error: 'Your session is not linked to a student record - please sign in again' });
                            }
                            // The server owns the identity of the paper.
                            toStore.studentId = sid;
                            const quizId = String(toStore.quizId || toStore.examId || '');
                            const assessment = (db.quizzes || []).find(q => q && String(q.id) === quizId)
                                || (db.exams || []).find(e => e && String(e.id) === quizId);
                            // Re-sending the SAME paper is always allowed (that is
                            // a retry after a dropped connection); a NEW attempt is
                            // capped by the assessment's retake allowance.
                            const samePaper = (db.submissions || []).find(x => x && String(x.id) === String(toStore.id));
                            const myAttempts = (db.submissions || []).filter(x => x && String(x.quizId || x.examId || '') === quizId && String(x.studentId || '') === sid);
                            if (!samePaper && assessment) {
                                const allowed = Math.max(1, Number(assessment.maxRetakes || 1));
                                if (myAttempts.length >= allowed) {
                                    return json(res, 409, { error: 'You have already used all ' + allowed + ' attempt' + (allowed === 1 ? '' : 's') + ' for this assessment.' });
                                }
                            }
                            const marked = scoreSubmissionOnServer(toStore);
                            if (marked) {
                                const band = gradeBandForScore(marked.score);
                                const passMark = Number(assessment && assessment.passMark != null ? assessment.passMark : 50);
                                toStore.score = marked.score;
                                toStore.pointsEarned = marked.pointsEarned;
                                toStore.totalPoints = marked.totalPoints;
                                toStore.grade = band.grade;
                                toStore.gpa = band.gpa;
                                toStore.status = marked.score >= passMark ? 'pass' : 'fail';
                                toStore.scoredBy = 'server';
                                subMark = { marked: marked, band: band, assessment: assessment, scoredBy: 'server' };
                            } else {
                                // The server could not mark this paper: a written
                                // answer is marked by staff, and a question that
                                // no longer exists cannot be marked at all.
                                // NO marks are awarded here - the paper goes to
                                // review and the score the browser claimed is
                                // dropped, so a tampered client cannot mark
                                // itself.
                                toStore.status = 'pending_review';
                                toStore.needsReview = true;
                                delete toStore.score;
                                delete toStore.grade;
                                delete toStore.gpa;
                                delete toStore.pointsEarned;
                                delete toStore.totalPoints;
                                delete toStore.scoredBy;
                            }
                        } else if (user) {
                            // Staff write: a reviewer marking a paper. The marks
                            // are the reviewer's, the letter and the grade
                            // record are the server's.
                            const a2 = (db.quizzes || []).find(q => q && String(q.id) === String(toStore.quizId))
                                || (db.exams || []).find(e => e && String(e.id) === String(toStore.quizId));
                            const reviewScore = Number(toStore.score);
                            const reviewDone = toStore.needsReview === false && Number.isFinite(reviewScore)
                                && !!toStore.studentId && !!a2;
                            if (reviewDone) {
                                const band = gradeBandForScore(reviewScore);
                                const passMark = Number(a2.passMark != null ? a2.passMark : 50);
                                toStore.grade = band.grade;
                                toStore.gpa = band.gpa;
                                toStore.status = reviewScore >= passMark ? 'pass' : 'fail';
                                toStore.needsReview = false;
                                subMark = { marked: { score: reviewScore }, band: band, assessment: a2, scoredBy: 'staff' };
                            } else if (toStore.needsReview === true) {
                                // Still waiting for a reviewer: no letter and no
                                // marks on the paper.
                                toStore.status = 'pending_review';
                                delete toStore.grade;
                                delete toStore.gpa;
                            }
                        }
                    }
                    if (store === 'grades' && user && user.role === 'student') {
                        // The session may not carry studentId, so resolve it from
                        // the users record before comparing.
                        const myAliases = studentAliases(user);
                        const claimed = String(toStore.studentId || '');
                        if (!myAliases.size || !myAliases.has(claimed)) {
                            return json(res, 403, { error: 'You can only record your own grade' });
                        }
                        if (toStore.submissionId === undefined || toStore.submissionId === null || toStore.submissionId === '') {
                            return json(res, 400, { error: 'A grade must reference the submission it was scored from' });
                        }
                        const sub = (db.submissions || []).find(x => x && String(x.id) === String(toStore.submissionId));
                        const owns = sub && Array.from(myAliases).some(a => String(sub.studentId) === a);
                        if (!owns) {
                            return json(res, 403, { error: 'That submission is not yours' });
                        }
                        if (sub.needsReview || (Array.isArray(sub.answers) && sub.answers.some(a => a && a.type === 'essay'))) {
                            return json(res, 400, { error: 'Written answers are marked by staff, not automatically' });
                        }
                        const marked = scoreSubmissionOnServer(sub);
                        if (marked === null) {
                            return json(res, 400, { error: 'This attempt cannot be scored automatically' });
                        }
                        toStore.score = marked.score;
                        toStore.pointsEarned = marked.pointsEarned;
                        toStore.totalPoints = marked.totalPoints;
                        const quizRec = (db.quizzes || []).find(q => q && String(q.id) === String(sub.quizId))
                            || (db.exams || []).find(e => e && String(e.id) === String(sub.quizId));
                        const passMark = Number((quizRec && quizRec.passMark) != null ? quizRec.passMark : 50);
                        toStore.status = marked.score >= passMark ? 'pass' : 'fail';
                        const band = gradeBandForScore(marked.score);
                        toStore.grade = band.grade;
                        toStore.gpa = band.gpa;
                        toStore.scoredBy = 'server';
                        // The server owns the score, so it also owns the grade
                        // record: upsert into the grades store so every marked
                        // attempt is reflected in the learner's transcript.
                        try {
                            const gRec = (db.exams || []).find(e => e && String(e.id) === String(toStore.quizId))
                                || (db.quizzes || []).find(q => q && String(q.id) === String(toStore.quizId));
                            const gRes = upsertGradeFromSubmission(Object.assign({}, sub || toStore, { id: sub ? sub.id : toStore.submissionId }), marked, band, gRec);
                            try {
                                if (gRec && gRec.courseId) syncCourseGradeFromAssessments(toStore.studentId, gRec.courseId, gRec.semester || toStore.semester);
                                else if (gRes && gRes.courseId) syncCourseGradeFromAssessments(toStore.studentId, gRes.courseId, toStore.semester);
                            } catch (se) { console.error('auto-sync course grade failed:', se.message); }
                        } catch (ge) { console.error('server grade upsert failed:', ge.message); }
                    }
                    if (store === 'grades') {
                        // The SERVER owns the letter. The score is the fact; the
                        // letter and the grade points follow the institution's
                        // ACTIVE scale. A browser that still carries an old
                        // grading table can never store a letter that
                        // disagrees with the scale the transcripts are printed
                        // from. The score itself is never touched.
                        const score = Number(toStore.score);
                        if (Number.isFinite(score) && score >= 0 && score <= 100) {
                            const band = gradeBandForScore(score);
                            toStore.grade = band.grade;
                            toStore.gpa = band.gpa;
                        }
                        // Ensure course-level grades are properly tagged for transcript
                        try {
                            if (toStore.courseId && (toStore.weighted === true || /^GRD-/.test(String(toStore.id || '')))) {
                                // Mark as course level for transcript
                                toStore.weighted = true;
                            }
                        } catch (e) {}
                    }
                    if (store === 'studyCenters') {
                        const _dupCode = studyCenterCodeConflict(toStore);
                        if (_dupCode) return json(res, 400, { error: 'Center code already in use: ' + _dupCode });
                    }
                    // Every student must fit in a country, region and study
                    // center. When a student is written with a study center that
                    // resolves to a country, stamp that country + its region onto
                    // the record even when the caller omitted them — a student
                    // may NEVER silently remain in the untagged/admin-only pool.
                    if (store === 'students') {
                        const idxC = buildCountryIndex();
                        const centerC = toStore.studyCenterId ? (db.studyCenters || []).find(c2 => c2 && String(c2.id) === String(toStore.studyCenterId)) : null;
                        const countryC = (centerC && idxC.centerCountry[centerC.id]) || '';
                        if (countryC) {
                            if (!toStore.country) toStore.country = countryC;
                            if (!toStore.regionId && centerC && centerC.regionId) toStore.regionId = centerC.regionId;
                        }
                    }
                    const idx = db[store].findIndex(r => r[keyPath] === pk);
                    if (idx >= 0) db[store][idx] = toStore;
                    else db[store].push(toStore);
                    mutate(toStore, idx >= 0 ? 'update' : 'insert');
                    if (store === 'settings' && toStore.key === 'maintenance') {
                        try { broadcastMaintenance(!!((toStore.value || toStore).active)); } catch {}
                    }
                    // Attendance and course weightage are course-result inputs,
                    // so refresh any automatic result that already exists.
                    if (store === 'attendance' && toStore.studentId && toStore.courseId) {
                        try { syncExistingCourseGradesFor(String(toStore.studentId), String(toStore.courseId)); } catch (e) { console.error('attendance course-grade refresh failed:', e.message); }
                    }
                    if (store === 'courses' && toStore.id) {
                        try { syncExistingCourseGradesForCourse(String(toStore.id)); } catch (e) { console.error('course-weight course-grade refresh failed:', e.message); }
                    }
                    // A marked paper also creates its grade record here, so the
                    // exam is on the transcript after this single write.
                    let gradeId = null, gradeCreated = false;
                    if (store === 'submissions' && subMark) {
                        try {
                            const g = upsertGradeFromSubmission(toStore, subMark.marked, subMark.band, subMark.assessment, subMark.scoredBy);
                            if (g) { gradeId = g.id; gradeCreated = g.created; }
                            // Auto-sync course-level grade to transcript
                            try {
                                if (subMark.assessment && subMark.assessment.courseId) {
                                    syncCourseGradeFromAssessments(toStore.studentId, subMark.assessment.courseId, subMark.assessment.semester || toStore.semester);
                                } else if (g && g.courseId) {
                                    syncCourseGradeFromAssessments(toStore.studentId, g.courseId, g.semester || toStore.semester);
                                }
                            } catch (se) { console.error('auto-sync course grade failed:', se.message); }
                        } catch (ge) { console.error('server grade upsert failed:', ge.message); }
                    }
                    json(res, 200, { ok: true, key: pk, gradeId: gradeId, gradeCreated: gradeCreated });
                } catch (e) {
                    // Do not let a server-side failure look like malformed JSON:
                    // log the real cause while keeping the learner-facing reply
                    // short and free of internal details.
                    console.error('PUT ' + store + ' failed:', e && (e.stack || e.message || e));
                    json(res, 400, { error: 'Invalid JSON' });
                }
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
if (store === 'settings') {
                        const extErr = externalizeSettingsRecord(value);
                        if (extErr) return json(res, 400, { error: extErr });
                    }
const isDocStore = store === 'certificates' || store === 'idCards' || store === 'idcards';
                    let toStore = value;
                    if (isDocStore) {
                        toStore = archiveHtmlContent(externalizeCertificate(value).record);
                    }
                    if (isDocStore && (toStore.type === 'diploma' || toStore.type === 'completion') && !docTypeEnabledFor(user, toStore.type)) {
                        return json(res, 403, { error: 'Generate ' + toStore.type + ' is disabled for your country by the administrator' });
                    }
                    const preserveFields = isDocStore ? ['content'] : (store === 'settings' ? brandingImageKeys(value) : null);
                    if (store === 'settings' && value.key === 'maintenance' && (!user || user.role !== 'admin')) {
                        return json(res, 403, { error: 'Only administrators can change maintenance mode' });
                    }
if (store === 'settings' && value.key === 'assistantAccess' && (!user || user.role !== 'admin')) {
                        return json(res, 403, { error: 'Only administrators can change assistant access' });
                    }
                    if (store === 'settings' && value.key === 'adminAccess' && !isOwnerUser(user)) {
                        return json(res, 403, { error: 'Only the owner can change which tabs the administrator may open' });
                    }
                    if (store === 'settings' && value.key === 'owner' && !isOwnerUser(user)) {
                        return json(res, 403, { error: 'Only the owner can change the owner account' });
                    }
                    // Students updating only their own terms acceptance (allowed past the gate above)
                    if (store === 'users' && user && user.role === 'student') {
                        if (String(toStore[keyPath]) !== String(user.username)) return json(res, 403, { error: 'Students may only update their own account' });
                        const existing = (db[store] || []).find(r => r[keyPath] === toStore[keyPath]);
                        if (!existing) return json(res, 404, { error: 'Account not found' });
                        const termsKeys = ['username', 'termsAccepted', 'termsAcceptedAt', 'termsVersion'];
                        for (const k of termsKeys) {
                            if (k in toStore) existing[k] = toStore[k];
                        }
                        mutate(existing);
                        return json(res, 200, { ok: true, key: existing[keyPath] });
                    }
                    const pk = toStore[keyPath];
                    if (pk === undefined || pk === null) return json(res, 400, { error: `Record missing key field "${keyPath}"` });
                    const exists = db[store].some(r => r[keyPath] === pk);
                    if (exists) return json(res, 409, { error: `Record with ${keyPath}="${pk}" already exists` });
                    const _scAdd = scopeWrite(user, store, toStore, null);
                    if (_scAdd) return json(res, 403, { error: _scAdd });
                    preserveDocIdentity(store, toStore, null);
                    if (store === 'studyCenters') {
                        const _dupCode = studyCenterCodeConflict(toStore);
                        if (_dupCode) return json(res, 400, { error: 'Center code already in use: ' + _dupCode });
                    }
                    db[store].push(toStore);
                    mutate(toStore, 'insert');
                    if (store === 'settings' && toStore.key === 'maintenance') {
                        try { broadcastMaintenance(!!((toStore.value || toStore).active)); } catch {}
                    }
                    json(res, 200, { ok: true, key: pk });
                } catch (e) { json(res, 400, { error: 'Invalid JSON' }); }
            });
            return true;
        }

        // DELETE /api/db/:store  â€” clear entire store
        if (req.method === 'DELETE' && !key) {
            if (!user || user.role !== 'admin') return json(res, 403, { error: 'Admin only' });
            const before = db[store].length;
            db[store] = [];
            if (isLogStore(store)) clearLogArchive(store);
            mutate({ _cleared: true });
            auditLog('clear-store', store, { records: before }, user && user.username);
            return json(res, 200, { ok: true });
        }

        // DELETE /api/db/:store/:key  â€” remove single record
        if (req.method === 'DELETE' && key) {
            const idx = db[store].findIndex(r => String(r[keyPath]) === key);
            const doomed = idx >= 0 ? db[store][idx] : null;
            if (store === 'alumniEnrollments' && user && user.role === 'student' && doomed) {
                const alumniDelErr = studentAlumniGrantDeleteError(user, doomed);
                if (alumniDelErr) return json(res, 403, { error: alumniDelErr });
            }
            if (store === 'enrollments' && user && user.role === 'student' && isAlumniAccount(user)) {
                return json(res, 403, { error: 'Alumni academic records cannot be removed here' });
            }
            const _scDel = scopeWrite(user, store, doomed, doomed);
            if (_scDel) return json(res, 403, { error: _scDel });
            if (idx >= 0) {
                db[store].splice(idx, 1);
                // A log store is append-only, so a deletion is recorded as a
                // tombstone; otherwise the record would come back on restart.
                if (isLogStore(store) && doomed) tombstoneLogArchive(store, doomed);
            }
            // Removing a paper can make its course result incomplete. Refresh
            // the course-level mark from the submissions that remain; if this
            // engine wrote the result, remove it rather than leaving a stale
            // transcript entry for a component that no longer exists.
            if (doomed && store === 'submissions') {
                try {
                    const assessmentId = String(doomed.quizId || doomed.examId || '');
                    const assessment = (db.exams || []).find(a => a && String(a.id) === assessmentId)
                        || (db.quizzes || []).find(a => a && String(a.id) === assessmentId);
                    if (assessment && assessment.courseId) {
                        const semester = Number(doomed.semester != null ? doomed.semester
                            : (assessment.semester != null ? assessment.semester : 1)) || 1;
                        syncCourseGradeFromAssessments(String(doomed.studentId || ''), String(assessment.courseId), semester, { removeIfIncomplete: true });
                    }
                } catch (e) { console.error('submission course-grade refresh failed:', e.message); }
            }
            if (doomed && store === 'attendance' && doomed.studentId && doomed.courseId) {
                try { syncExistingCourseGradesFor(String(doomed.studentId), String(doomed.courseId)); } catch (e) { console.error('attendance course-grade refresh failed:', e.message); }
            }
            // Remove orphaned doc files for deleted certificates/idCards (docs + volume).
            if (doomed && (store === 'certificates' || store === 'idCards' || store === 'idcards')) {
                try {
                    const delPaths = [docPathByKey(doomed.id || doomed.docId || doomed.vCode || key), docVolPathByKey(doomed.id || doomed.docId || doomed.vCode || key)];
                    for (const f of delPaths) {
                        try { if (typeof f === 'string' && f && fs.existsSync(f)) { fs.unlinkSync(f); } } catch {}
                    }
                } catch (e) { console.error('DEL-CLEAN err:', e && e.message); }
            }
            mutate({ [keyPath]: key, _deleted: true }, 'delete');
            auditLog('delete', store, { key }, user && user.username);
            return json(res, 200, { ok: true, deleted: idx >= 0 });
        }

        return json(res, 405, { error: 'Method not allowed' });
    }

    // Discussion API endpoints
if (parts[1] === 'discussions') {
        const courseId = parts[2];
        const dUser = getRequestUser(req);

        // Auth guard: no anonymous read/write on discussions, ever.
        if (!dUser) return json(res, 401, { error: 'Not authenticated' });
        if (dUser.role !== 'student' && !canAccessStore(dUser, 'discussions', req.method)) {
            return json(res, 403, { error: 'Insufficient permissions' });
        }
        const isModerator = ['admin', 'lecturer', 'registrar', 'coordinator', 'assistant'].includes(dUser.role);
        const dUid = dUser.user.studentId || dUser.username;

        // GET /api/discussions/:courseId â€” get messages for a course (students: course-enrollment required)
        if (parts.length === 3 && req.method === 'GET') {
            if (dUser.role === 'student') {
                const enrolled = (db.enrollments || []).some(e => String(e.courseId) === String(courseId) && String(e.studentId) === String(dUid));
                if (!enrolled) return json(res, 403, { error: 'Enrollment required to view this discussion' });
            }
            const discussions = db.discussions || [];
            return json(res, 200, { messages: discussions.filter(d => d.courseId === courseId) });
        }

        // POST /api/discussions/:courseId â€” post a new message (identity from the session, never the body)
        if (parts.length === 3 && req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const { content } = JSON.parse(body);
                    const text = String(content || '').trim();
                    if (!text) return json(res, 400, { error: 'Message content required' });
                    const discussions = db.discussions || [];
                    const message = {
                        id: 'DISC-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
                        courseId,
                        userId: dUid,
                        userName: dUser.user.name || dUser.username,
                        userRole: dUser.role,
                        content: text.slice(0, 5000),
                        pinned: false,
                        locked: false,
                        likes: [],
                        replies: [],
                        timestamp: new Date().toISOString()
                    };
                    discussions.push(message);
                    db.discussions = discussions;
                    saveDB();
                    broadcastEvent('discussion-new', message);
                    json(res, 200, { ok: true, message });
                } catch (e) { json(res, 400, { error: 'Invalid JSON' }); }
            });
            return true;
        }

        // PUT /api/discussions/:courseId/:messageId â€” moderate (staff only, role from session) or reply/like
        if (parts.length === 4 && req.method === 'PUT') {
            const messageId = parts[3];
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    const { action, content } = parsed;
                    if (!['pin', 'lock', 'unpin', 'unlock', 'delete', 'reply', 'like'].includes(action)) return json(res, 400, { error: 'Invalid action' });
                    if (!isModerator && !['reply', 'like'].includes(action)) return json(res, 403, { error: 'Insufficient permissions' });
                    const discussions = db.discussions || [];
                    const idx = discussions.findIndex(d => d.id === messageId && d.courseId === courseId);
                    if (idx === -1) return json(res, 404, { error: 'Message not found' });
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
                        const text = String(content || '').trim();
                        if (!text) return json(res, 400, { error: 'Reply content required' });
                        discussions[idx].replies.push({
                            id: 'REP-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
                            messageId,
                            userId: dUid,
                            userName: dUser.user.name || dUser.username,
                            userRole: dUser.role,
                            content: text.slice(0, 5000),
                            timestamp: new Date().toISOString()
                        });
                    } else if (action === 'like') {
                        const likeIdx = discussions[idx].likes.indexOf(dUid);
                        if (likeIdx >= 0) discussions[idx].likes.splice(likeIdx, 1);
                        else discussions[idx].likes.push(dUid);
                    }
                    db.discussions = discussions;
                    saveDB();
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
    // Security headers applied to every response (harmless over plain HTTP,
    // honored over HTTPS). CSP keeps the app functional (inline styles/handlers,
    // same-origin + https) while blocking cross-origin script injection.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data: https:; connect-src 'self' https: http://localhost:8080 ws: wss:; media-src 'self' blob: https:; frame-src 'self' https: blob:; object-src 'self' blob:; worker-src 'self' blob:;");
    // The one CORS decision for this request; every response helper reuses it.
    res.__corsOrigin = allowedOrigin(req);

    if (req.method === 'OPTIONS') {
        const preflight = {
            'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '600'
        };
        if (res.__corsOrigin) {
            preflight['Access-Control-Allow-Origin'] = res.__corsOrigin;
            preflight['Vary'] = 'Origin';
        }
        res.writeHead(204, preflight);
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

    // The externalised document store (issued certificate PDFs, blank
    // diploma/completion templates) lives INSIDE the web root, so without this
    // guard every issued document and the blank templates are world-readable
    // and the ids are guessable from their timestamp. Documents are served only
    // through the authenticated /api/doc-content route or the code-gated
    // /api/certificate/:id route.
    if (url === '/docs' || url.indexOf('/docs/') === 0) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('404 Not Found');
    }

    // Integrity watchdog: refuse to serve files that were modified while the
    // server was running (tamper detection). Admin must rebaseline or restore.
    if (SECURE.blockedFiles.size && SECURE.blockedFiles.has(path.resolve(filePath))) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('403 Forbidden — This file is blocked by security integrity checks. Contact the administrator to rebaseline or restore it.');
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
            const headerLogoData = branding && branding.logo ? branding.logo : '';
            const loginLogoData = branding && (branding.receiptLogo || branding.logo) ? (branding.receiptLogo || branding.logo) : '';
            const logoData = headerLogoData;
            let logoCss = '';
            if (headerLogoData || loginLogoData) {
                logoCss = '<style>';
                if (loginLogoData) logoCss += '#login-logo{background:transparent url(\'' + loginLogoData + '\') no-repeat center / cover !important;text-indent:-9999px!important;background-color:transparent!important}';
                if (headerLogoData) logoCss += '#header-logo-img{display:block}#header-logo-placeholder{display:none}.terms-logo{background:transparent url(\'' + headerLogoData + '\') no-repeat center / cover}';
                logoCss += '</style>';
            }
            const maintSetting = getMaintenanceSetting();
            const maintMsg = maintSetting.message && String(maintSetting.message).trim()
                ? String(maintSetting.message).trim()
                : 'We are carrying out scheduled maintenance and improvements. The system will be back shortly. Thank you for your patience.';
            // The contact number is part of the branding configuration, so it is
            // rendered into the login screen with the rest of the branding. The
            // page therefore shows the number immediately, even if the client
            // cannot reach /api/public-contact.
            const contactPhone = getContactPhone();
            const contactPhoneHtml = contactPhone
                ? '\uD83D\uDCDE <a href="tel:' + contactPhone + '" style="color:var(--accent);font-weight:600;text-decoration:none;">' + contactPhone.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</a>'
                : '';
            html = html.replace(/\{\{CONTACT_PHONE_STYLE\}\}/g, contactPhone
                ? 'display:block;text-align:center;margin-top:10px;font-size:13px;'
                : 'display:none;text-align:center;margin-top:10px;font-size:13px;')
                       .replace(/\{\{CONTACT_PHONE\}\}/g, () => contactPhoneHtml)
                       .replace(/\{\{SCHOOL_NAME\}\}/g, schoolName)
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

    // API paths must never fall through to static file serving. Several routes
    // (e.g. POST /api/translate) answer from inside an async provider callback,
    // so the static handler used to race them and its 404 HTML page won before
    // the real JSON arrived. Anything unmatched under /api/ returns JSON 404.
    if (/^\/api(\/|$)/.test(url)) {
        if (res.headersSent || req._asyncApi) return;
        return json(res, 404, { ok: false, error: 'not_found', path: url });
    }

    // Only the files on the static allowlist are downloadable. The app
    // directory also holds the server source, the live database, dependency
    // manifests and the deployment config - none of those may be served.
    // An unknown path answers 404 exactly as if the file did not exist.
    if (!isPublicStaticAsset(url)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('404 Not Found');
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

// Automatic WhatsApp sender ("linked device"). Lazy-loaded so the server always
// boots even if the engine library is unavailable; inert until paired.
let _waAuto = null;
function waAuto() {
    if (!_waAuto) {
        try {
            const mk = require('./wa-auto');
            _waAuto = mk({ getDb: function () { return db; }, saveDB: function () { saveDB(); }, broadcastEvent: broadcastEvent, auditLog: auditLog, DATA_ROOT: DATA_ROOT });
        } catch (e) {
            _waAuto = { _dead: true, status: function () { return { supported: false, bootError: e.message, connected: false, phone: '', hasQr: false, queue: 0, lastError: '', senderNumber: '', lastSentAt: '' }; }, boot: async function () {}, enqueue: function () { return 0; }, logout: async function () {}, qrDataUrl: async function () { return ''; }, pendingCount: function () { return 0; } };
        }
    }
    return _waAuto;
}
try { waAuto().boot(); } catch (e) { console.error('wa-auto boot failed:', e.message); }

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



