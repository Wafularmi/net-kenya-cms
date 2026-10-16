// wa-auto.js — automatic WhatsApp sender ("linked device") for NET Kenya CMS.
//
// The server links to WhatsApp exactly like WhatsApp Web on a laptop: the
// admin scans ONE qr code from their phone, and from then on the server sends
// messages itself — no tabs, no clicks, no Meta account, no per-message fees.
//
// Safety design:
//  - Runs on the SPARE line (default 0723696908), never the admin's own.
//  - One message per wake of the worker (~5-9s apart) so traffic looks human.
//  - Every job lives in the `whatsappOutbox` store first, so a restart or a
//    sleeping server can never silently lose a message.
//  - Session keys live on the persistent /data volume, so redeploys and
//    restarts do not unpair the device. A fresh QR is only needed if WhatsApp
//    itself drops the link (the UI then shows a new code).
const fs = require('fs');
const path = require('path');

const AUTH_SUBDIR = 'wa-auto-auth';
const DEFAULT_SENDER = '0723696908';
const WORKER_BASE_MS = 5000;
const WORKER_JITTER_MS = 4000;
const MAX_ATTEMPTS = 5;
const MAX_JOBS_PER_REQUEST = 2000;

function digitsOf(p) { return String(p == null ? '' : p).replace(/\D/g, ''); }
function normalizeKe(p) {
    let d = digitsOf(p);
    if (d.charAt(0) === '0' && d.length === 10) d = '254' + d.slice(1);
    return d;
}

module.exports = function createWaAuto(ctx) {
    const getDb = ctx.getDb;
    const saveDB = ctx.saveDB;
    const broadcastEvent = ctx.broadcastEvent || function () {};
    const auditLog = ctx.auditLog || function () {};
    const DATA_ROOT = ctx.DATA_ROOT || __dirname;
    let volumeDir = DATA_ROOT;
    try { if (fs.existsSync('/data')) volumeDir = '/data'; } catch (e) {}
    const authDir = path.join(volumeDir, AUTH_SUBDIR);

    let Baileys = null, QRCode = null, bootError = '';
    try { Baileys = require('@whiskeysockets/baileys'); }
    catch (e) { bootError = 'engine library missing: ' + (e.message || e); }
    try { QRCode = require('qrcode'); }
    catch (e) { bootError += (bootError ? '; ' : '') + 'qr library missing'; }

    const S = {
        sock: null, starting: false, connected: false, phone: '',
        qr: '', qrAt: 0, lastError: '', loggedOut: false,
        busy: false, workerTimer: null, lastSentAt: '', started: false
    };

    function senderNumber() {
        try {
            const db = getDb();
            const rec = (db.settings || []).find(function (x) { return x && x.key === 'whatsappAuto'; });
            const v = rec ? (rec.value || {}) : {};
            return String(v.senderNumber || DEFAULT_SENDER).trim() || DEFAULT_SENDER;
        } catch (e) { return DEFAULT_SENDER; }
    }

    function pendingCount() {
        try { return (getDb().whatsappOutbox || []).filter(function (j) { return j && j.status === 'queued'; }).length; }
        catch (e) { return 0; }
    }

    function pushLog(entry) {
        try {
            const db = getDb();
            db.whatsappLog = db.whatsappLog || [];
            db.whatsappLog.push(entry);
        } catch (e) {}
    }

    function today() { return new Date().toISOString().split('T')[0]; }

    async function boot() {
        if (S.started || !Baileys) return;
        S.started = true;
        await ensureStarted();
        scheduleWorker(3000);
    }

    async function ensureStarted() {
        if (S.sock || S.starting || !Baileys) return;
        S.starting = true;
        try {
            try { fs.mkdirSync(authDir, { recursive: true }); } catch (e) {}
            const auth = await Baileys.useMultiFileAuthState(authDir);
            let version;
            try { const v = await Baileys.fetchLatestBaileysVersion(); version = v.version; } catch (e) {}
            const sock = Baileys.default({
                version: version,
                auth: auth.state,
                printQRInTerminal: false,
                browser: ['NET Kenya CMS', 'Chrome', '1.0'],
                syncFullHistory: false,
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                getMessage: async function () { return undefined; }
            });
            S.sock = sock;
            sock.ev.on('creds.update', auth.saveCreds);
            sock.ev.on('connection.update', onUpdate);
        } catch (e) {
            S.lastError = e.message || String(e);
            S.sock = null;
        }
        S.starting = false;
    }

    async function onUpdate(u) {
        try {
            if (u.qr) {
                S.qr = u.qr; S.qrAt = Date.now();
                try { broadcastEvent('wa-auto', { hasQr: true }); } catch (e) {}
            }
            if (u.connection === 'open') {
                S.connected = true; S.qr = ''; S.loggedOut = false; S.lastError = '';
                try { S.phone = String((S.sock.user && S.sock.user.id) || '').split(':')[0]; } catch (e) {}
                try { broadcastEvent('wa-auto', { connected: true, phone: S.phone }); } catch (e) {}
                scheduleWorker(1500);
            }
            if (u.connection === 'close') {
                S.connected = false; S.sock = null;
                let code = 0;
                try { code = u.lastDisconnect.error.output.statusCode; } catch (e) {}
                const loggedOut = Baileys && (code === Baileys.DisconnectReason.loggedOut);
                if (code === 401 || loggedOut) {
                    S.loggedOut = true; S.qr = ''; S.lastError = 'signed out of WhatsApp - scan the code to pair again';
                    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
                    try { broadcastEvent('wa-auto', { connected: false, loggedOut: true }); } catch (e) {}
                } else {
                    S.lastError = 'link dropped' + (code ? ' (' + code + ')' : '') + ' - reconnecting';
                    try { broadcastEvent('wa-auto', { connected: false }); } catch (e) {}
                    setTimeout(function () { ensureStarted(); }, 5000);
                }
            }
        } catch (e) { S.lastError = e.message || String(e); }
    }

    async function sendDirect(to, text) {
        if (!S.sock || !S.connected) throw new Error('sender is not connected');
        const d = normalizeKe(to);
        if (d.length < 9 || d.length > 15) throw new Error('bad number');
        const jid = d + '@s.whatsapp.net';
        try {
            const chk = await S.sock.onWhatsApp(jid);
            if (!chk || !chk[0] || !chk[0].exists) throw new Error('number is not on WhatsApp');
        } catch (e) {
            if (/not on WhatsApp/.test(e.message || '')) throw e;
        }
        const sent = await S.sock.sendMessage(jid, { text: String(text || '').slice(0, 2000) });
        return (sent && sent.key && sent.key.id) || '';
    }

    function scheduleWorker(ms) {
        if (S.workerTimer) clearTimeout(S.workerTimer);
        const wait = (ms == null) ? (WORKER_BASE_MS + Math.floor(Math.random() * WORKER_JITTER_MS)) : ms;
        S.workerTimer = setTimeout(workerTick, wait);
    }

    async function workerTick() {
        try {
            if (S.sock && S.connected && !S.busy) {
                const db = getDb();
                db.whatsappOutbox = db.whatsappOutbox || [];
                const job = db.whatsappOutbox
                    .filter(function (j) { return j && j.status === 'queued'; })
                    .sort(function (a, b) { return String(a.createdAt) < String(b.createdAt) ? -1 : 1; })[0];
                if (job) {
                    S.busy = true;
                    job.status = 'sending';
                    job.attempts = (job.attempts || 0) + 1;
                    const iso = new Date().toISOString();
                    try {
                        const waId = await sendDirect(job.to, job.message);
                        job.status = 'sent'; job.sentAt = iso; job.waId = waId; job.error = '';
                        S.lastSentAt = iso;
                        pushLog({
                            id: 'WA-' + Date.now(), phone: job.to, name: job.name || '',
                            message: String(job.message || '').substring(0, 200),
                            date: iso.split('T')[0], time: new Date(iso).toLocaleTimeString(),
                            template: job.template || 'auto', status: 'sent',
                            sentBy: 'wa-auto', country: job.country || '', createdAt: iso
                        });
                    } catch (e) {
                        job.error = e.message || String(e);
                        if (job.attempts >= MAX_ATTEMPTS) {
                            job.status = 'failed';
                            pushLog({
                                id: 'WA-' + Date.now(), phone: job.to, name: job.name || '',
                                message: String(job.message || '').substring(0, 200),
                                date: today(), time: new Date().toLocaleTimeString(),
                                template: job.template || 'auto', status: 'failed',
                                sentBy: 'wa-auto', country: job.country || '', createdAt: new Date().toISOString()
                            });
                        } else { job.status = 'queued'; }
                    }
                    try { saveDB(); } catch (e) {}
                    try {
                        broadcastEvent('db-change', { store: 'whatsappLog' });
                        broadcastEvent('wa-auto', { queue: pendingCount() });
                    } catch (e) {}
                    S.busy = false;
                }
            }
        } catch (e) { S.lastError = e.message || String(e); }
        scheduleWorker();
    }

    function enqueue(jobs, by) {
        const db = getDb();
        db.whatsappOutbox = db.whatsappOutbox || [];
        let n = 0;
        (jobs || []).slice(0, MAX_JOBS_PER_REQUEST).forEach(function (j) {
            const d = normalizeKe(j && j.to);
            if (!j || d.length < 9 || d.length > 15 || !String(j.message || '').trim()) return;
            db.whatsappOutbox.push({
                id: 'WAQ-' + Date.now().toString(36).toUpperCase() + '-' + n,
                to: d, name: String(j.name || ''), message: String(j.message).slice(0, 2000),
                studentId: j.studentId || '', country: j.country || '', template: j.template || 'auto',
                status: 'queued', attempts: 0, error: '',
                createdAt: new Date().toISOString(), queuedBy: by || ''
            });
            n++;
        });
        try { saveDB(); } catch (e) {}
        try { broadcastEvent('wa-auto', { queue: pendingCount() }); } catch (e) {}
        scheduleWorker(1500);
        try { auditLog('whatsapp-auto-enqueue', 'whatsappOutbox', { total: n }, by || 'system'); } catch (e) {}
        return n;
    }

    async function logout() {
        try { if (S.sock) { try { await S.sock.logout(); } catch (e) {} } } catch (e) {}
        S.sock = null; S.connected = false; S.phone = ''; S.qr = ''; S.loggedOut = true; S.lastError = '';
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
        try { broadcastEvent('wa-auto', { connected: false, loggedOut: true }); } catch (e) {}
    }

    async function qrDataUrl() {
        if (!S.qr || !QRCode) return '';
        try { return await QRCode.toDataURL(S.qr, { width: 220, margin: 1 }); } catch (e) { return ''; }
    }

    function status() {
        return {
            supported: !!Baileys,
            bootError: bootError,
            connected: S.connected,
            phone: S.phone,
            hasQr: !!S.qr && (Date.now() - S.qrAt < 90000),
            queue: pendingCount(),
            lastError: S.lastError,
            senderNumber: senderNumber(),
            lastSentAt: S.lastSentAt
        };
    }

    return { boot: boot, status: status, enqueue: enqueue, logout: logout, qrDataUrl: qrDataUrl, pendingCount: pendingCount, ensureStarted: ensureStarted };
};
