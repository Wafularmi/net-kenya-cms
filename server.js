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

// SSE clients for real-time updates
const sseClients = [];

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


// Online user tracking — heartbeat every 30s, expires after 90s
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
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
    return true;
}

// Financial stores that require special authorization
const FINANCIAL_STORES = new Set(['payments', 'income', 'expenses', 'fees', 'invoices']);

// Roles allowed to access ALL financial data
const FINANCE_ADMIN_ROLES = new Set(['admin', 'finance', 'registrar']);

// Extract user from request headers (sent by client)
function getRequestUser(req) {
    const role = req.headers['x-user-role'];
    const username = req.headers['x-user-id'] || req.headers['x-user-name'];
    if (!role || !username) return null;
    return { role, username };
}

// Check if user can access a store
function canAccessStore(user, store, method) {
    // Allow unauthenticated reads of settings (branding, academic config) for login screen
    if (!user && store === 'settings' && method === 'GET') return true;
    if (!user) return false;
    if (FINANCE_ADMIN_ROLES.has(user.role)) return true;
    if (!FINANCIAL_STORES.has(store)) return true;
    
    // Students can only read their own payment records
    if (user.role === 'student' && store === 'payments' && method === 'GET') {
        return true; // Filtering happens in the handler
    }
    return false;
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

async function mpesaToken(env, key, secret) {
    const isSandbox = env === 'sandbox';
    const baseURL = isSandbox ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';
    const auth = Buffer.from(key + ':' + secret).toString('base64');
    return new Promise((resolve, reject) => {
        const u = new URL(baseURL + '/oauth/v1/generate?grant_type=client_credentials');
        const opts = {
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'GET',
            headers: { 'Authorization': 'Basic ' + auth }
        };
        const req = http.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { const j = JSON.parse(data); resolve(j.access_token); } catch { reject('Token fetch failed'); }
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
                'Content-Length': Buffer.byteLength(body)
            }
        };
        const req = http.request(opts, res => {
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

    // GET /api/events — SSE stream for real-time updates
    if (parts.length === 2 && parts[1] === 'events' && req.method === 'GET') {
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

    // GET /api/network-info — get IPs and URLs for device connection
    if (parts.length === 2 && parts[1] === 'network-info' && req.method === 'GET') {
        const ips = getNetworkIPs();
        const urls = ips.flatMap(ip => buildUrls(ip.address));
        console.log('network-info request, ips:', ips);
        return json(res, 200, { port: PORT, httpsPort: _httpsPort, ips, urls, hostname: os.hostname() });
    }

    // GET /api/qr?url=... — generate QR code for the given URL
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

    // GET /api/backup — download full database JSON
    if (parts.length === 2 && parts[1] === 'backup' && req.method === 'GET') {
        flushDB();
        const backup = JSON.stringify(db, null, 2);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="backup-${ts}.json"`,
            'Content-Length': Buffer.byteLength(backup)
        });
        return res.end(backup);
    }

    // POST /api/restore — upload full database JSON (replaces all data)
    if (parts.length === 2 && parts[1] === 'restore' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (!data || typeof data !== 'object') return json(res, 400, { error: 'Invalid backup file' });
                const count = Object.keys(data).length;
                db = data;
                flushDB();
                console.log('Database restored —', count, 'stores');
                json(res, 200, { ok: true, stores: count });
            } catch { json(res, 400, { error: 'Invalid JSON in backup file' }); }
        });
        return true;
    }

    // GET /api/db-size — report database stats
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

    // GET /api/backups — list available timestamped backups
    if (parts.length === 2 && parts[1] === 'backups' && req.method === 'GET') {
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

    // POST /api/restore-from-backup — restore from a named timestamped backup
    if (parts.length === 3 && parts[1] === 'restore-from-backup' && req.method === 'POST') {
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
                console.log('Database restored from backup:', name);
                json(res, 200, { ok: true, stores: Object.keys(data).length });
            } catch { json(res, 400, { error: 'Restore failed' }); }
        });
        return true;
    }

    // POST /api/login — server-side login (single round trip)
    if (parts.length === 2 && parts[1] === 'login' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { input, password } = JSON.parse(body);
                if (!input || !password) return json(res, 400, { error: 'Enter username and password' });

                const hash = pw => crypto.createHash('sha256').update(pw, 'utf8').digest('hex');
                const users = db.users || [];
                const students = db.students || [];

                // Lookup user by username, studentId, phone, email, or admission number
                let user = users.find(u => u.username === input);
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

                if (!user) return json(res, 401, { error: 'Invalid username or password' });

                const pwHash = hash(password);
                let pwMatch = user.password === pwHash || user.password === password;

                if (!pwMatch && user.role === 'student') {
                    const s = students.find(s => s.id === user.studentId || s.phone === user.username || s.email === user.username || (user.name && s.name === user.name));
                    if (s && s.admissionNumber) pwMatch = hash(s.admissionNumber) === pwHash || s.admissionNumber === password;
                }

                if (!pwMatch) return json(res, 401, { error: 'Invalid username or password' });

                if (user.password !== pwHash) { user.password = pwHash; safeWriteJSON(db); }
                if (user.status === 'locked') return json(res, 403, { error: 'Account locked due to inactivity. Contact administration to reactivate.' });
                if (user.status === 'inactive') return json(res, 403, { error: 'Account is inactive. Contact administration.' });
                if (user.status === 'pending') return json(res, 403, { error: 'Account pending approval. Please wait for admin confirmation.' });

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

                json(res, 200, { user: safeUser });
            } catch (e) { process.stderr.write('LOGIN_ERROR: ' + (e && e.stack || e) + '\n'); json(res, 500, { error: 'Login failed' }); }
        });
        return true;
    }

    // POST /api/hash — SHA-256 hashing (for phones where crypto.subtle is unavailable)
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

    // POST /api/heartbeat — client sends username every 30s
    if (parts.length === 2 && parts[1] === 'heartbeat' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { username, name, role } = JSON.parse(body);
                if (username) onlineUsers.set(username, { name: name || username, role: role || 'unknown', lastSeen: Date.now(), ip: req.connection.remoteAddress || req.socket.remoteAddress });
                json(res, 200, { ok: true, online: onlineUsers.size });
            } catch { json(res, 400, { error: 'Invalid' }); }
        });
        return true;
    }

    // GET /api/online — returns list of users active in last 90s
    if (parts.length === 2 && parts[1] === 'online' && req.method === 'GET') {
        cleanOnlineUsers();
        const list = [];
        for (const [username, data] of onlineUsers) {
            list.push({ username, name: data.name, role: data.role, lastSeen: data.lastSeen });
        }
        list.sort((a, b) => b.lastSeen - a.lastSeen);
        return json(res, 200, { count: list.length, users: list });
    }

    // POST /api/mpesa/settings
    if (parts.length >= 3 && parts[1] === 'mpesa' && parts[2] === 'settings' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                db.mpesaSettings = data;
                saveDB();
                json(res, 200, { success: true });
            } catch { json(res, 400, { error: 'Invalid JSON' }); }
        });
        return true;
    }

    // GET /api/mpesa/settings
    if (parts.length >= 3 && parts[1] === 'mpesa' && parts[2] === 'settings' && req.method === 'GET') {
        json(res, 200, db.mpesaSettings || {});
        return true;
    }

    // POST /api/mpesa/stkpush
    if (parts.length >= 3 && parts[1] === 'mpesa' && parts[2] === 'stkpush' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const s = db.mpesaSettings || {};
                if (!s.shortcode || !s.consumerKey || !s.consumerSecret || !s.passkey) {
                    return json(res, 400, { error: 'M-Pesa not configured. Save settings first.' });
                }
                const ts = timestamp();
                const pw = Buffer.from(s.shortcode + s.passkey + ts).toString('base64');
                const txnType = s.transactionType === 'till' ? 'BuyGoodsOnline' : 'CustomerPayBillOnline';
                const partyB = s.shortcode;
                const payload = {
                    BusinessShortCode: s.shortcode,
                    Password: pw,
                    Timestamp: ts,
                    TransactionType: txnType,
                    Amount: Math.round(data.amount),
                    PartyA: data.phone,
                    PartyB: partyB,
                    PhoneNumber: data.phone,
                    CallBackURL: 'https://localhost:3000/api/mpesa/callback',
                    AccountReference: data.reference || 'CollegeFee',
                    TransactionDesc: data.description || 'Fee Payment'
                };
                const result = await mpesaRequest('/mpesa/stkpush/v1/processrequest', payload, s.environment, s.consumerKey, s.consumerSecret);
                json(res, 200, result);
            } catch (e) { json(res, 500, { error: e.message || e }); }
        });
        return true;
    }

    // POST /api/mpesa/query
    if (parts.length >= 3 && parts[1] === 'mpesa' && parts[2] === 'query' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const s = db.mpesaSettings || {};
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
                json(res, 200, result);
            } catch (e) { json(res, 500, { error: e.message || e }); }
        });
        return true;
    }

    // POST /api/send-sms — send bulk SMS via Africa's Talking
    if (parts.length === 2 && parts[1] === 'send-sms' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { recipients, logEntries } = JSON.parse(body);
                const smsSettings = db.settings && db.settings.find(s => s.key === 'smsSettings');
                if (!smsSettings || !smsSettings.value) return json(res, 400, { error: 'SMS not configured. Save settings first.' });
                const cfg = smsSettings.value;
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
    // Generic DB CRUD endpoints — /api/db/:store[/:key]
    // -----------------------------------------------------------
    // GET /api/db/batch?stores=users,students,courses  — batch fetch multiple stores
    if (parts.length >= 3 && parts[1] === 'db' && parts[2] === 'batch' && req.method === 'GET') {
        const names = (urlObj.searchParams.get('stores') || '').split(',').filter(Boolean);
        const result = {};
        for (const name of names) {
            if (!db[name]) db[name] = [];
            result[name] = db[name];
        }
        return json(res, 200, result);
    }

    if (parts.length >= 2 && parts[1] === 'db') {
        const store = decodeURIComponent(parts[2]);
        const key = parts[3] ? decodeURIComponent(parts[3]) : null;

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

        // Helper to save DB after mutations — broadcast FIRST so clients get instant notification
        function mutate(record) { broadcastEvent('db-change', { store, record }); saveDB(); }

        // GET /api/db/:store   — return all records (with optional ?index=&value= filter, ?page=&limit=)
        if (req.method === 'GET' && !key) {
            let results = db[store] || [];
            
            // Students can only see their own payments
            if (user && user.role === 'student' && store === 'payments') {
                const student = (db.students || []).find(s => s.phone === user.username || s.id === user.username || s.email === user.username);
                if (student) {
                    results = results.filter(r => r.studentId === student.id || r.studentPhone === student.phone);
                } else {
                    results = [];
                }
            }
            
            const indexParam = urlObj.searchParams.get('index');
            const valueParam = urlObj.searchParams.get('value');
            if (indexParam && valueParam !== null) {
                results = results.filter(r => String(r[indexParam]) === valueParam);
            }
            const page = parseInt(urlObj.searchParams.get('page')) || 0;
            const limit = parseInt(urlObj.searchParams.get('limit')) || 0;
            if (limit > 0 && page > 0) {
                const start = (page - 1) * limit;
                const total = results.length;
                results = results.slice(start, start + limit);
                return json(res, 200, { data: results, page, limit, total, pages: Math.ceil(total / limit) });
            }
            return json(res, 200, results);
        }

        // GET /api/db/:store/:key  — return single record or null
        if (req.method === 'GET' && key) {
            const item = db[store].find(r => String(r[keyPath]) === key) || null;
            return json(res, 200, item);
        }

        // PUT /api/db/:store  — upsert (create or replace)
        if (req.method === 'PUT') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    const value = parsed.value || parsed;
                    if (!value || typeof value !== 'object') return json(res, 400, { error: 'Invalid body' });
                    const pk = value[keyPath];
                    if (pk === undefined || pk === null) {
                        console.log('PUT ' + store + ' FAILED - missing ' + keyPath + ' bodyKeys:', Object.keys(value));
                        return json(res, 400, { error: `Record missing key field "${keyPath}"` });
                    }
                    const idx = db[store].findIndex(r => r[keyPath] === pk);
                    if (idx >= 0) db[store][idx] = value;
                    else db[store].push(value);
                    mutate(value);
                    json(res, 200, { ok: true, key: pk });
                } catch (e) { json(res, 400, { error: 'Invalid JSON' }); }
            });
            return true;
        }

        // POST /api/db/:store  — add only (error if key exists)
        if (req.method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    const value = parsed.value || parsed;
                    if (!value || typeof value !== 'object') return json(res, 400, { error: 'Invalid body' });
                    const pk = value[keyPath];
                    if (pk === undefined || pk === null) return json(res, 400, { error: `Record missing key field "${keyPath}"` });
                    const exists = db[store].some(r => r[keyPath] === pk);
                    if (exists) return json(res, 409, { error: `Record with ${keyPath}="${pk}" already exists` });
                    db[store].push(value);
                    mutate(value);
                    json(res, 200, { ok: true, key: pk });
                } catch (e) { json(res, 400, { error: 'Invalid JSON' }); }
            });
            return true;
        }

        // DELETE /api/db/:store  — clear entire store
        if (req.method === 'DELETE' && !key) {
            db[store] = [];
            mutate({ _cleared: true });
            return json(res, 200, { ok: true });
        }

        // DELETE /api/db/:store/:key  — remove single record
        if (req.method === 'DELETE' && key) {
            const idx = db[store].findIndex(r => String(r[keyPath]) === key);
            if (idx >= 0) db[store].splice(idx, 1);
            mutate({ [keyPath]: key, _deleted: true });
            return json(res, 200, { ok: true, deleted: idx >= 0 });
        }

        return json(res, 405, { error: 'Method not allowed' });
    }

    // Discussion API endpoints
    if (parts[1] === 'discussions') {
        const courseId = parts[2];
        
        // GET /api/discussions/:courseId — get messages for a course
        if (parts.length === 3 && req.method === 'GET') {
            const discussions = db.discussions || [];
            const courseDiscussions = discussions.filter(d => d.courseId === courseId);
            return json(res, 200, { messages: courseDiscussions });
        }
        
        // POST /api/discussions/:courseId — post a new message
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
        
        // PUT /api/discussions/:courseId/:messageId — moderate (pin/lock/delete) or reply/like
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

    // Inject branding into index.html at serve-time for zero-flash rendering
    if (filePath.endsWith('index.html')) {
        fs.readFile(filePath, 'utf8', (err, html) => {
            if (err) {
                res.writeHead(500);
                return res.end('Server error');
            }
            const branding = db.settings ? db.settings.find(s => s.key === 'branding') : null;
            const schoolName = branding && branding.schoolName ? branding.schoolName : 'College Management System';
            const initials = branding && branding.initials ? branding.initials : 'CM';
            let logoCss = '';
            if (branding && branding.logo) {
                logoCss = '<style>#login-logo{background:transparent url(\'' + branding.logo + '\') no-repeat center / cover;text-indent:-9999px}#header-logo-img{display:block}#header-logo-placeholder{display:none}.terms-logo{background:transparent url(\'' + branding.logo + '\') no-repeat center / cover}</style>';
            }
            html = html.replace(/\{\{SCHOOL_NAME\}\}/g, schoolName).replace(/\{\{INITIALS\}\}/g, initials).replace(/\{\{LOGO_CSS\}\}/g, logoCss);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (url.includes('bundle.js') || url.includes('.css') || url.includes('.js')) {
                res.setHeader('CDN-Cache-Control', 'no-store');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            }
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
    console.log('  ╔══════════════════════════════════════════════════╗');
    console.log('  ║      College Management System Server           ║');
    console.log('  ╠══════════════════════════════════════════════════╣');
    console.log(`  ║  HTTP:   ${local.padEnd(43)}║`);
    if (_httpsPort) console.log(`  ║  HTTPS:  https://127.0.0.1:${String(_httpsPort).padEnd(28)}║`);
    urls.forEach(u => {
        const isHttps = u.startsWith('https');
        const isConnect = u.includes('connect.html');
        let label;
        if (isConnect && isHttps) label = '  ║  Sec-C:';
        else if (isConnect) label = '  ║  Connect:';
        else if (isHttps) label = '  ║  SecNet:';
        else label = '  ║  Network:';
        const display = isHttps ? u : u;
        console.log(`${label} ${display.padEnd(43)}║`);
    });
    console.log('  ╠══════════════════════════════════════════════════╣');
    console.log('  ║  Scan QR from connect.html for mobile access    ║');
    console.log(`  ║  Primary: ${(primaryUrl).padEnd(46)}║`);
    console.log('  ╠══════════════════════════════════════════════════╣');
    console.log('  ║  M-Pesa API: /api/mpesa/*                      ║');
    console.log('  ║  Press Ctrl+C to stop the server               ║');
    console.log('  ╚══════════════════════════════════════════════════╝');
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
                console.log('  ╔══════════════════════════════════════════════════╗');
                console.log('  ║      HTTPS Enabled — Certificates Active       ║');
                console.log('  ╠══════════════════════════════════════════════════╣');
                console.log(`  ║  Local:   ${httpsLocal.padEnd(43)}║`);
                urls2.filter(u => u.startsWith('https')).forEach(u => {
                    const label = u.includes('connect.html') ? '  ║  Sec-C:' : '  ║  SecNet:';
                    console.log(`${label} ${u.padEnd(43)}║`);
                });
                console.log(`  ║  QR:     ${primary2.padEnd(43)}║`);
                console.log('  ╚══════════════════════════════════════════════════╝');
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
