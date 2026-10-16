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
// Feedback + lightness caps: the message log never grows past LOG_CAP rows,
// finished outbox jobs older than OUTBOX_KEEP_DAYS vanish, and only the newest
// RUNS_CAP bulk runs are kept. The UI reads a small "recent activity" feed, so
// a thousand sends never means a thousand-row download.
const LOG_CAP = 2000;
const OUTBOX_KEEP_DAYS = 7;
const OUTBOX_CAP = 5000;
const RUNS_CAP = 50;

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
        busy: false, workerTimer: null, lastSentAt: '', started: false,
        receiptTimer: null, receiptsDirty: false
    };

    function userCountry(username) {
        try {
            const db = getDb();
            const u = (db.users || []).find(function (x) { return x && String(x.username) === String(username); });
            return (u && (u.country || (u.user && u.user.country))) || '';
        } catch (e) { return ''; }
    }

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

    // ---- Bulk-run feedback -------------------------------------------------
    // Every automatic bulk send owns one run record: totals move with each
    // completion and the run closes when its queue drains. The WhatsApp screen
    // renders these as live progress bars with per-recipient drill-down.
    function createRun(label, template, total, by) {
        try {
            const db = getDb();
            db.whatsappRuns = db.whatsappRuns || [];
            const run = {
                id: 'WRN-' + Date.now().toString(36).toUpperCase(),
                label: String(label || 'Broadcast'), template: String(template || ''),
                channel: 'auto', total: total, sent: 0, failed: 0,
                by: by || '', country: userCountry(by),
                startedAt: new Date().toISOString(), completedAt: '',
                status: 'running'
            };
            db.whatsappRuns.push(run);
            return run;
        } catch (e) { return null; }
    }

    function tickRun(runId, ok) {
        try {
            const db = getDb();
            const run = (db.whatsappRuns || []).find(function (r) { return r && r.id === runId; });
            if (!run || run.status !== 'running') return;
            if (ok) run.sent++; else run.failed++;
            const done = run.sent + run.failed;
            if (done >= run.total) { run.status = 'done'; run.completedAt = new Date().toISOString(); }
            return run.status;
        } catch (e) { return ''; }
    }

    // ---- Lightness: prune heavy stores --------------------------------------
    function pruneWaStores() {
        try {
            const db = getDb();
            if (Array.isArray(db.whatsappLog) && db.whatsappLog.length > LOG_CAP) {
                db.whatsappLog.sort(function (a, b) { return String(a.createdAt) < String(b.createdAt) ? -1 : 1; });
                db.whatsappLog = db.whatsappLog.slice(-LOG_CAP);
            }
            if (Array.isArray(db.whatsappOutbox) && db.whatsappOutbox.length) {
                const cutoff = Date.now() - OUTBOX_KEEP_DAYS * 24 * 3600 * 1000;
                db.whatsappOutbox = db.whatsappOutbox.filter(function (j) {
                    if (!j || j.status === 'queued' || j.status === 'sending') return true;
                    const t = Date.parse(j.sentAt || j.createdAt || 0) || 0;
                    return t >= cutoff;
                });
                if (db.whatsappOutbox.length > OUTBOX_CAP) {
                    const finished = db.whatsappOutbox.filter(function (j) { return j && j.status !== 'queued' && j.status !== 'sending'; });
                    const drop = db.whatsappOutbox.length - OUTBOX_CAP;
                    const dropIds = {};
                    finished.sort(function (a, b) { return String(a.createdAt) < String(b.createdAt) ? -1 : 1; }).slice(0, drop).forEach(function (j) { dropIds[j.id] = 1; });
                    db.whatsappOutbox = db.whatsappOutbox.filter(function (j) { return !dropIds[j.id]; });
                }
            }
            if (Array.isArray(db.whatsappRuns) && db.whatsappRuns.length > RUNS_CAP) {
                db.whatsappRuns.sort(function (a, b) { return String(a.startedAt) < String(b.startedAt) ? -1 : 1; });
                db.whatsappRuns = db.whatsappRuns.slice(-RUNS_CAP);
            }
        } catch (e) {}
    }

    function today() { return new Date().toISOString().split('T')[0]; }

    // Delivery feedback: WhatsApp reports SERVER_ACK(2) / DELIVERY_ACK(3) /
    // READ(4+) per message. We lift log entries sent -> delivered -> read so
    // the admin sees what actually reached a handset, not just the server.
    // Receipts arrive in bursts; they are applied in memory and flushed at
    // most every 10 seconds so a big blast never hammers the disk.
    function onReceipts(updates) {
        try {
            const db = getDb();
            const jobs = db.whatsappOutbox || [];
            const logs = db.whatsappLog || [];
            let touched = false;
            (updates || []).forEach(function (u) {
                const id = u && u.key && u.key.id;
                const ack = u && u.update && u.update.status;
                if (!id || !(ack >= 3)) return;
                const want = ack >= 4 ? 'read' : 'delivered';
                const job = jobs.find(function (j) { return j && j.waId === id && j.status === 'sent'; });
                if (job) {
                    const order = { sent: 0, delivered: 1, read: 2 };
                    if ((order[job.delivery || 'sent'] || 0) < order[want]) { job.delivery = want; touched = true; }
                }
                for (let i = logs.length - 1; i >= 0 && i >= logs.length - 400; i--) {
                    const e = logs[i];
                    if (e && e.waId === id && (e.status === 'sent' || e.status === 'delivered')) {
                        const order = { sent: 0, delivered: 1, read: 2 };
                        if ((order[e.status] || 0) < (want === 'read' ? 2 : 1)) { e.status = want; touched = true; }
                        break;
                    }
                }
            });
            if (!touched) return;
            S.receiptsDirty = true;
            if (!S.receiptTimer) {
                S.receiptTimer = setTimeout(function () {
                    S.receiptTimer = null;
                    if (!S.receiptsDirty) return;
                    S.receiptsDirty = false;
                    try { saveDB(); } catch (e) {}
                    try { broadcastEvent('db-change', { store: 'whatsappLog' }); } catch (e) {}
                }, 10000);
            }
        } catch (e) {}
    }

    async function boot() {
        if (S.started || !Baileys) return;
        S.started = true;
        try { pruneWaStores(); } catch (e) {}
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
            sock.ev.on('messages.update', onReceipts);
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
                        job.status = 'sent'; job.sentAt = iso; job.waId = waId; job.error = ''; job.delivery = 'sent';
                        S.lastSentAt = iso;
                        pushLog({
                            id: 'WA-' + Date.now(), phone: job.to, name: job.name || '',
                            message: String(job.message || '').substring(0, 200),
                            date: iso.split('T')[0], time: new Date(iso).toLocaleTimeString(),
                            template: job.template || 'auto', status: 'sent', waId: waId,
                            sentBy: 'wa-auto', country: job.country || '', createdAt: iso
                        });
                        var runState = tickRun(job.runId, true);
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
                            var runState = tickRun(job.runId, false);
                        } else { job.status = 'queued'; }
                    }
                    try { pruneWaStores(); } catch (e) {}
                    try { saveDB(); } catch (e) {}
                    try {
                        broadcastEvent('db-change', { store: 'whatsappLog' });
                        if (typeof runState !== 'undefined' && runState) broadcastEvent('db-change', { store: 'whatsappRuns' });
                        else broadcastEvent('wa-auto', { queue: pendingCount() });
                    } catch (e) {}
                    S.busy = false;
                }
            }
        } catch (e) { S.lastError = e.message || String(e); }
        scheduleWorker();
    }

    function enqueue(jobs, by, opts) {
        const o = opts || {};
        const db = getDb();
        db.whatsappOutbox = db.whatsappOutbox || [];
        const valid = (jobs || []).slice(0, MAX_JOBS_PER_REQUEST).filter(function (j) {
            const d = normalizeKe(j && j.to);
            return j && d.length >= 9 && d.length <= 15 && String(j.message || '').trim();
        });
        const run = createRun(o.label || 'Broadcast', o.template || '', valid.length, by);
        const runId = run ? run.id : '';
        let n = 0;
        valid.forEach(function (j) {
            const d = normalizeKe(j.to);
            db.whatsappOutbox.push({
                id: 'WAQ-' + Date.now().toString(36).toUpperCase() + '-' + n,
                runId: runId,
                to: d, name: String(j.name || ''), message: String(j.message).slice(0, 2000),
                studentId: j.studentId || '', country: j.country || '', template: j.template || o.template || 'auto',
                status: 'queued', attempts: 0, error: '', delivery: '',
                createdAt: new Date().toISOString(), queuedBy: by || ''
            });
            n++;
        });
        try { saveDB(); } catch (e) {}
        try {
            broadcastEvent('db-change', { store: 'whatsappRuns' });
            broadcastEvent('wa-auto', { queue: pendingCount() });
        } catch (e) {}
        scheduleWorker(1500);
        try { auditLog('whatsapp-auto-enqueue', 'whatsappOutbox', { total: n, runId: runId }, by || 'system'); } catch (e) {}
        return { queued: n, runId: runId };
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
