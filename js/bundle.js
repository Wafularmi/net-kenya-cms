/* CMS Bundle v213 2026-08-04T21:57:21.708Z */
const API_BASE = '/api/db';
function getAuthHeaders() {
    const user = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const headers = { 'Content-Type': 'application/json' };
    if (user.username) headers['X-User-Id'] = user.username;
    if (user.role) headers['X-User-Role'] = user.role;
    return headers;
}
async function openDB() {
    try {
        const res = await fetch('/api/health');
        if (!res.ok) throw new Error('Server unreachable');
        return true;
    } catch (e) {
        console.warn('Server unreachable, DB operations will fail:', e);
        return false;
    }
}
async function dbGetAll(store) {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(store)}`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error(`dbGetAll ${store} failed: ${res.status}`);
    return res.json();
}
async function dbGetBatch(stores) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetch(`${API_BASE}/batch?stores=${stores.map(encodeURIComponent).join(',')}`, { headers: getAuthHeaders() });
            if (!res.ok) throw new Error('dbGetBatch failed: ' + res.status);
            return res.json();
        } catch (e) {
            lastErr = e;
            if (attempt < 2) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
        }
    }
    throw lastErr || new Error('dbGetBatch failed');
}
async function dbGet(store, key) {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(store)}/${encodeURIComponent(String(key))}`, { headers: getAuthHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`dbGet ${store}:${key} failed: ${res.status}`);
    return res.json();
}
async function dbPut(store, data) {
    console.log('dbPut:', store, 'data:', JSON.stringify(data));
    const res = await fetch(`${API_BASE}/${encodeURIComponent(store)}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ value: data })
    });
    if (!res.ok) throw new Error(`dbPut ${store} failed: ${res.status}`);
    return res.json();
}
async function dbAdd(store, data) {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(store)}`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ value: data })
    });
    if (!res.ok) throw new Error(`dbAdd ${store} failed: ${res.status}`);
    return res.json();
}
async function dbDelete(store, key) {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(store)}/${encodeURIComponent(String(key))}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error(`dbDelete ${store}:${key} failed: ${res.status}`);
}
async function dbClear(store) {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(store)}`, {
        method: 'DELETE'
    });
    if (!res.ok) throw new Error(`dbClear ${store} failed: ${res.status}`);
}
async function getNextCounter(key, prefix = '') {
    let counter = await dbGet('counters', key);
    if (!counter) counter = { key, value: 0 };
    counter.value++;
    await dbPut('counters', counter);
    return prefix + String(counter.value).padStart(4, '0');
}
async function logAudit(action, entity, details) {
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const entry = {
        id: 'AUD-' + Date.now(),
        userId: currentUser.username || 'system',
        action,
        entity,
        details: JSON.stringify(details),
        date: new Date().toISOString(),
        timestamp: Date.now()
    };
    try { await dbAdd('audit', entry); } catch (e) {}
}

function generateId(prefix) {
    return prefix + '-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
}

function generateVerificationCode() {
    const p1 = Math.random().toString(36).substr(2, 4).toUpperCase();
    const p2 = Math.random().toString(36).substr(2, 4).toUpperCase();
    return 'V-' + p1 + '-' + p2;
}

function formatDate(dateStr) {
    if (!dateStr) return '--';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatCurrency(amount) {
    const s = _currencyCache || { code: 'KES', symbol: 'KES', decimals: 2 };
    const val = (amount || 0).toLocaleString(undefined, { minimumFractionDigits: s.decimals, maximumFractionDigits: s.decimals });
    return s.symbol + ' ' + val;
}

var _currencyCache;
function setCurrencyCache(cfg) { _currencyCache = cfg; }

function showToast(msg, options = {}) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.className = 'toast';

    const type = options.type || 'info';
    const title = options.title || '';
    const details = options.details || '';
    const actionLabel = options.action || null;
    const actionFn = options.actionFn || null;
    const duration = options.duration || 4000;
    const actionId = '_toast_act_' + Date.now();
    if (actionFn) window[actionId] = actionFn;

    let html = `<div class="toast-inner"><div class="toast-content">`;
    if (title) html += `<div class="toast-title">${title}</div>`;
    html += `<div class="toast-message">${msg}</div>`;
    if (details) html += `<div class="toast-details">${details}</div>`;
    html += `</div></div>`;
    if (actionLabel) html += `<button class="toast-action-btn" onclick="window['${actionId}']();closeToast()">${actionLabel}</button>`;
    html += `<div class="toast-progress" style="animation-duration:${duration}ms;"></div>`;

    t.innerHTML = html;
    t.classList.add('show');
    t.classList.add('toast-' + type);
    t.dataset.duration = duration;

    if (t._timeout) clearTimeout(t._timeout);
    t._timeout = setTimeout(() => t.classList.remove('show'), duration);
}

function closeToast() {
    const t = document.getElementById('toast');
    if (t) t.classList.remove('show');
}

function showModal(title, content, actions = null) {
    const overlay = document.getElementById('modal-overlay');
    const modal = document.getElementById('modal-content');
    if (!overlay || !modal) {
        console.error('Modal elements not found in DOM');
        return;
    }
    modal.innerHTML = `
        <div class="modal-header"><h3>${title}</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>
        <div class="modal-body">${content}</div>
        <div class="modal-actions"><button class="btn btn-outline" onclick="closeModal()">Cancel</button>${actions || ''}</div>
    `;
    overlay.style.display = 'flex';
    overlay.classList.add('active');
}

function showConfirm(title, message) {
    return new Promise(resolve => {
        const key = '_toast_cfm_' + Date.now();
        window[key] = resolve;
        showToast(message, { type: 'warning', duration: 8000, details: title,
            action: 'Yes, proceed', actionFn: () => { window[key](true); delete window[key]; }
        });
        setTimeout(() => { if (window[key]) { window[key](false); delete window[key]; } }, 8000);
    });
}

function showPrompt(title, message, defaultValue = '') {
    return new Promise(resolve => {
        const overlay = document.getElementById('modal-overlay');
        const modal = document.getElementById('modal-content');
        const key = '_prompt_' + Date.now();
        window[key] = resolve;
        modal.innerHTML = `
            <div class="modal-header"><h3>${title}</h3><button class="modal-close" onclick="window['${key}'](null);closeModal()">&times;</button></div>
            <div class="modal-body"><div style="padding:12px 0;font-size:14px;line-height:1.6;">${message}</div><div class="form-group"><input type="text" id="prompt-input" value="${escapeHtml(defaultValue)}" style="width:100%;"></div></div>
            <div class="modal-actions"><button class="btn btn-outline" onclick="window['${key}'](null);closeModal()">Cancel</button><button class="btn btn-primary" onclick="window['${key}'](document.getElementById('prompt-input').value);closeModal()">OK</button></div>
        `;
        overlay.style.display = 'flex';
        overlay.classList.add('active');
        document.getElementById('prompt-input').addEventListener('keydown', function handler(e) { if (e.key === 'Enter') { const v = document.getElementById('prompt-input').value; window[key](v); delete window[key]; closeModal(); this.removeEventListener('keydown', handler); } });
        const cleanup = () => { delete window[key]; };
        window.addEventListener('beforeunload', cleanup, { once: true });
    });
}

function closeModal(e) {
    if (e && e.target !== e.currentTarget) return;
    const overlay = document.getElementById('modal-overlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    overlay.classList.remove('active');
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
    return /^\+?[\d\s\-()]{7,20}$/.test(phone);
}

function sanitizeInput(val) {
    if (typeof val !== 'string') return val;
    return val.replace(/<[^>]*>/g, '').trim();
}

// --- Password Hashing ---
async function hashPassword(password) {
    try {
        const enc = new TextEncoder().encode(password);
        const buf = await crypto.subtle.digest('SHA-256', enc);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
        const res = await fetch('/api/hash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const data = await res.json();
        return data.hash;
    }
}

// --- Session Timeout (24h) ---
var SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function updateActivity() {
    sessionStorage.setItem('lastActivity', Date.now());
}

function isSessionExpired() {
    const last = parseInt(sessionStorage.getItem('lastActivity'));
    if (!last) return false;
    return Date.now() - last > SESSION_TIMEOUT_MS;
}

document.addEventListener('click', updateActivity);
document.addEventListener('keydown', updateActivity);
document.addEventListener('mousemove', updateActivity);

function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function formatWhatsAppPhone(phone, countryCode = '254') {
    let cleaned = phone.replace(/[^0-9+]/g, '');
    if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);
    if (cleaned.startsWith('0')) cleaned = countryCode + cleaned.substring(1);
    if (!cleaned.startsWith(countryCode)) cleaned = countryCode + cleaned;
    return cleaned;
}

function sendWhatsApp(phone, message) {
    const formatted = formatWhatsAppPhone(phone);
    const url = `https://wa.me/${formatted}?text=${encodeURIComponent(message)}&t=${Date.now()}`;
    const w = window.open(url, 'wa-' + Date.now());
    if (w) w.focus();
    logWhatsApp(phone, message);
}

async function logWhatsApp(phone, message) {
    const entry = {
        id: 'WA-' + Date.now(),
        phone,
        message: message.substring(0, 200),
        date: new Date().toISOString().split('T')[0],
        time: new Date().toLocaleTimeString(),
        createdAt: new Date().toISOString()
    };
    try { await dbAdd('whatsappLog', entry); } catch (e) {}
}

function generateBarcode() {
    let bars = '';
    for (let i = 0; i < 40; i++) {
        bars += `<div style="display:inline-block;width:${Math.random() > 0.5 ? 2 : 1}px;height:30px;background:#000;margin-right:1px;"></div>`;
    }
    return bars;
}

async function getProgramsList() {
    const settings = await dbGet('settings', 'academic');
    if (settings && settings.programs) return settings.programs.split(',').map(p => p.trim()).filter(p => p);
    return [];
}

var _academicCache;

async function initAcademicCache() {
    _academicCache = await dbGet('settings', 'academic');
}

function invalidateAcademicCache() {
    _academicCache = null;
}

async function getProgramFee(program) {
    if (!program) return 0;
    const settings = _academicCache || await dbGet('settings', 'academic');
    if (settings && settings.programFees && settings.programFees[program]) return settings.programFees[program];
    return 0;
}

function getCachedProgramFee(program) {
    if (!program || !_academicCache || !_academicCache.programFees) return 0;
    return _academicCache.programFees[program] || 0;
}

async function getStudentFee(student) {
    if (!student) return 0;
    const programFee = await getProgramFee(student.program);
    if (programFee > 0) return programFee;
    return student.feeAmount || 0;
}

function computeCGPA(grades, courses) {
    let totalPoints = 0, totalCredits = 0;
    for (const g of grades) {
        const c = courses ? courses.find(c => c.id === g.courseId) : null;
        const cr = c ? (c.credits || 3) : 3;
        totalPoints += parseFloat(g.gpa || 0) * cr;
        totalCredits += cr;
    }
    return totalCredits > 0 ? totalPoints / totalCredits : 0;
}

function getCachedStudentFee(student) {
    if (!student) return 0;
    const programFee = getCachedProgramFee(student.program);
    if (programFee > 0) return programFee;
    return student.feeAmount || 0;
}

async function resolveStudentId(currentUser) {
    if (!currentUser || currentUser.role !== 'student') return null;
    const directId = currentUser.studentId;
    if (directId) {
        const student = await dbGet('students', directId);
        if (student) return directId;
    }
    const students = await dbGetAll('students');
    const input = currentUser.username;
    const found = students.find(s =>
        s.id === input ||
        s.id === 'STU-' + input ||
        s.id === currentUser.studentId ||
        s.admissionNumber === input ||
        s.admissionNumber === currentUser.studentId ||
        (s.email && s.email === input) ||
        (currentUser.name && s.name.toLowerCase() === currentUser.name.toLowerCase())
    );
    return found ? found.id : (currentUser.studentId || currentUser.username);
}

function getRoleColor(role) {
    const colors = { admin: 'danger', registrar: 'info', finance: 'success', lecturer: 'warning', student: 'info', librarian: 'success' };
    return colors[role] || 'info';
}

function getRolePermissions(role) {
    const perms = {
        admin: ['dashboard','students','courses','lessons','attendance','grades','exams','manuals','staff','finance','chapel','graduation','hostel','library','inventory','alumni','certificates','events','whatsapp','communication','audit','idcards','questions','quizzes','submissions','notes','portal','student-hub','pending','tickets','progress','settings','verify','reprint'],
        registrar: ['dashboard','students','courses','lessons','attendance','grades','exams','manuals','chapel','graduation','hostel','library','alumni','certificates','events','questions','quizzes','submissions','notes','portal','student-hub','tickets','progress'],
        finance: ['dashboard','students','finance','hostel','portal','student-hub','tickets','progress','settings'],
        lecturer: ['dashboard','students','courses','lessons','attendance','grades','exams','manuals','chapel','library','events','questions','quizzes','submissions','notes','portal','student-hub','tickets','progress'],
        student: ['dashboard','portal','student-hub','courses','quizzes','exams','library','tickets','discussions'],
        librarian: ['dashboard','library']
    };
    return perms[role] || [];
}

function getRoleSignature(title, branding) {
    if (!branding) return null;
    const map = {
        'Registrar': 'sig_registrar',
        'Academic Registrar': 'sig_registrar',
        'Academic Dean': 'sig_dean',
        'Dean': 'sig_dean',
        'Director / Principal': 'sig_director',
        'Director': 'sig_director',
        'Principal': 'sig_director',
        'Finance Officer': 'sig_finance',
        'Finance': 'sig_finance'
    };
    const key = map[title];
    return key && branding[key] ? branding[key] : null;
}

function countWorkingDays(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (end <= start) return 0;
    let count = 0;
    const current = new Date(start);
    while (current < end) {
        const day = current.getDay();
        if (day !== 0 && day !== 6) count++;
        current.setDate(current.getDate() + 1);
    }
    return count;
}

function timeAgo(dateStr) {
    const now = Date.now();
    const date = new Date(dateStr).getTime();
    const diff = now - date;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
}

function _centerName(id) {
    if (!id) return '';
    if (window.__centerMap && window.__centerMap[id]) return window.__centerMap[id];
    return '';
}
function _regionNameFromStudent(student) {
    if (!student) return '';
    let regionId = student.regionId;
    if (!regionId && student.studyCenterId && window.__centerMap && window.__centerMap[student.studyCenterId]) {
        regionId = window.__centerMap[student.studyCenterId].regionId;
    }
    if (regionId && window.__regionMap && window.__regionMap[regionId]) return window.__regionMap[regionId];
    return '';
}
function applyTemplateVars(message, student, schoolName, balance, admissionNumber, phone) {
    const s = student || {};
    const admno = admissionNumber || s.admissionNumber || s.id || '';
    const centerObj = s.studyCenterId ? (_centerName(s.studyCenterId) || null) : null;
    const centerName = centerObj ? centerObj.name : (s.studyCenterId ? 'Study Center' : 'Main Campus');
    const centerCode = centerObj && centerObj.code ? centerObj.code : '';
    const regionName = _regionNameFromStudent(s);
    const requested = s.registrationRequestedAt ? new Date(s.registrationRequestedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : (s.enrollDate ? new Date(s.enrollDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
    const fee = typeof s.feeAmount === 'number' ? formatCurrency(s.feeAmount) : '0';
    const login = phone || s.phone || '';
    const portal = 'www.nefoundation.ke';
    return message
        .replace(/{{name}}/g, s.name)
        .replace(/{{school}}/g, schoolName)
        .replace(/{{program}}/g, s.program || 'program')
        .replace(/{{balance}}/g, balance !== undefined ? formatCurrency(balance) : '0')
        .replace(/{{admissionNumber}}/g, admno)
        .replace(/{{admission}}/g, admno)
        .replace(/{{phone}}/g, login)
        .replace(/{{username}}/g, login)
        .replace(/{{login}}/g, login)
        .replace(/{{password}}/g, admno)
        .replace(/{{email}}/g, s.email || '')
        .replace(/{{year}}/g, s.year || '1')
        .replace(/{{region}}/g, regionName)
        .replace(/{{center}}/g, centerName)
        .replace(/{{centerCode}}/g, centerCode)
        .replace(/{{requested}}/g, requested)
        .replace(/{{fee}}/g, fee)
        .replace(/{{portal}}/g, portal)
        .replace(/{{type}}/g, '')
        .replace(/{{event}}/g, '')
        .replace(/{{course}}/g, '')
        .replace(/{{date}}/g, '')
        .replace(/{{time}}/g, '')
        .replace(/{{venue}}/g, '')
        .replace(/{{min}}/g, '75');
}

async function sha256(str) {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function playBell() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const notes = [523.25, 659.25, 783.99];
        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.12);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.3);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(ctx.currentTime + i * 0.12);
            osc.stop(ctx.currentTime + i * 0.12 + 0.3);
        });
        setTimeout(() => ctx.close(), 1000);
    } catch (_) {}
}

function getTranscriptCourseOrder() {
    return [
        "GOD'S CALL TO MINISTRY",
        "GOD'S WAY OF SALVATION",
        "OLD TESTAMENT SURVEY",
        "NEW TESTAMENT SURVEY",
        "PASTORAL CARE",
        "TEMPERAMENTS",
        "CHRISTIAN MARRIAGE AND FAMILY",
        "TEACHING GOD'S WAY",
        "LIVING FOR CHRIST",
        "DIACONAL MINISTRY",
        "PASSION FOR PREACHING",
        "THE CHURCH THE BODY OF CHRIST"
    ];
}

function sortCoursesByTranscriptOrder(courses) {
    const order = getTranscriptCourseOrder();
    return courses.slice().sort((a, b) => {
        const ia = order.indexOf((a.name || '').toUpperCase());
        const ib = order.indexOf((b.name || '').toUpperCase());
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : null;
}

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
}

function generateColorPalette(baseHex) {
    const rgb = hexToRgb(baseHex);
    if (!rgb) return { primary: baseHex, light: '#e0e7ff', dark: '#1e3a5f', accent: '#f59e0b' };
    const light = rgbToHex(Math.min(255, rgb.r + 120), Math.min(255, rgb.g + 120), Math.min(255, rgb.b + 120));
    const dark = rgbToHex(Math.max(0, rgb.r - 80), Math.max(0, rgb.g - 80), Math.max(0, rgb.b - 80));
    const complement = rgbToHex(255 - rgb.r, 255 - rgb.g, 255 - rgb.b);
    return { primary: baseHex, light, dark, accent: complement };
}

async function getLogoDominantColor() {
    try {
        const branding = await dbGet('settings', 'branding');
        if (!branding || !branding.logo) return branding && branding.accentColor ? branding.accentColor : '#2563eb';
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'Anonymous';
            img.onload = function() {
                try {
                    const c = document.createElement('canvas');
                    c.width = img.width;
                    c.height = img.height;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    const data = ctx.getImageData(0, 0, c.width, c.height).data;
                    const colorCounts = {};
                    let maxCount = 0;
                    let dominant = '2563eb';
                    for (let i = 0; i < data.length; i += 16) {
                        const r = Math.round(data[i] / 32) * 32;
                        const g = Math.round(data[i + 1] / 32) * 32;
                        const b = Math.round(data[i + 2] / 32) * 32;
                        const key = r + ',' + g + ',' + b;
                        if (r + g + b < 100 || r + g + b > 700) continue;
                        colorCounts[key] = (colorCounts[key] || 0) + 1;
                        if (colorCounts[key] > maxCount) { maxCount = colorCounts[key]; dominant = rgbToHex(r, g, b); }
                    }
                    resolve(dominant);
                } catch (e) { resolve(branding.accentColor || '#2563eb'); }
            };
            img.onerror = function() { resolve(branding.accentColor || '#2563eb'); };
            img.src = branding.logo;
        });
    } catch (e) { return '#2563eb'; }
}

async function suggestDesignColors() {
    const dominant = await getLogoDominantColor();
    return generateColorPalette(dominant);
}
function calculateYearOfStudy(student) {
    if (!student) return 1;
    if (student.yearAuto === false) return student.year || 1;
    const regDate = student.registrationRequestedAt || student.enrollDate;
    if (!regDate) return 1;
    const reg = new Date(regDate);
    const now = new Date();
    let years = now.getFullYear() - reg.getFullYear();
    const monthDiff = now.getMonth() - reg.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < reg.getDate())) years--;
    years = Math.max(1, Math.min(3, years + 1));
    return years;
}
function getPaletteStripHtml(palette, colorInputId) {
    const swatches = [
        { label: 'Primary', color: palette.primary },
        { label: 'Light', color: palette.light },
        { label: 'Dark', color: palette.dark },
        { label: 'Accent', color: palette.accent }
    ];
    return `<div style="margin-bottom:10px;padding:8px;background:#f1f5f9;border-radius:6px;">
        <div style="font-size:11px;color:#64748b;margin-bottom:4px;">🎨 Logo-Derived Palette (click to apply)</div>
        <div style="display:flex;gap:6px;">${swatches.map(s => `<div onclick="document.getElementById('${colorInputId}').value='${s.color}';this.parentElement.querySelectorAll('div[style]').forEach(el=>el.style.outline='none');this.style.outline='2px solid #000';this.style.outlineOffset='2px'" style="cursor:pointer;width:32px;height:32px;border-radius:4px;background:${s.color};display:flex;align-items:flex-end;justify-content:center;font-size:7px;color:${parseInt(s.color.slice(1,3),16)*0.299+parseInt(s.color.slice(3,5),16)*0.587+parseInt(s.color.slice(5,7),16)*0.114>128?'#000':'#fff'};padding:2px;outline:${s.color===palette.primary?'2px solid #000':'none'};outlineOffset:${s.color===palette.primary?'2px':'0'}">${s.label}</div>`).join('')}</div>
    </div>`;
}

async function initAuth() {
    try {
        const adminExists = await dbGet('users', 'admin');
        if (!adminExists) {
            const pwHash = await hashPassword('admin123');
            await dbPut('users', { username: 'admin', password: pwHash, name: 'Administrator', role: 'admin', createdAt: new Date().toISOString() });
        }
    } catch (e) { console.error('initAuth admin check failed:', e); }

    try { await loadBranding(); } catch (e) { console.error('initAuth loadBranding failed:', e); }
    try { await initAcademicCache(); } catch (e) { console.error('initAuth initAcademicCache failed:', e); }
    try { await checkAllAccountActivity(); } catch (e) { console.error('initAuth checkAllAccountActivity failed:', e); }
    try { await syncUserAccounts(); } catch (e) { console.error('initAuth syncUserAccounts failed:', e); }

    try {
        const session = sessionStorage.getItem('currentUser');
        if (session) {
            const user = JSON.parse(session);
            const dbUser = await dbGet('users', user.username);
            if (dbUser && dbUser.status !== 'locked') {
                sessionStorage.setItem('currentUser', JSON.stringify(dbUser));
                if (!await checkTermsAccepted(dbUser)) return;
                return showApp(dbUser);
            }
        }
        document.getElementById('login-screen').style.display = 'flex';
        document.getElementById('app').style.display = 'none';
    } catch (e) { console.error('initAuth session check failed:', e); }
}

function staffRoleToSystemRole(staffRole) {
    const map = { admin: 'admin', lecturer: 'lecturer', professor: 'lecturer', dean: 'registrar', 'finance officer': 'finance', support: 'lecturer' };
    return map[(staffRole || '').toLowerCase()] || 'lecturer';
}

async function syncUserAccounts() {
    try {
        const batch = await dbGetBatch(['users','students','staff']);
        const allUsers = batch.users, students = batch.students, staffList = batch.staff;
        const created = [];
        for (const s of students) {
            if (s.status !== 'active' || !s.phone) continue;
            const hasUser = allUsers.some(u => u.studentId === s.id || u.username === s.phone);
            if (hasUser) continue;
            const pw = s.admissionNumber || s.id;
            const pwHash = await hashPassword(pw);
            allUsers.push({ username: s.phone, password: pwHash, name: s.name, role: 'student', status: 'active', studentId: s.id, createdAt: new Date().toISOString() });
            await dbPut('users', allUsers[allUsers.length - 1]);
            created.push('student:' + s.name + ' (' + s.phone + ')');
        }
        for (const st of staffList) {
            if (st.status !== 'active') continue;
            const username = st.email || st.phone || ('staff-' + st.id);
            const hasUser = allUsers.some(u => u.username === username || u.name === st.name);
            if (hasUser) continue;
            const pw = 'staff123';
            const pwHash = await hashPassword(pw);
            const role = staffRoleToSystemRole(st.role);
            allUsers.push({ username, password: pwHash, name: st.name, role, status: 'active', createdAt: new Date().toISOString() });
            await dbPut('users', allUsers[allUsers.length - 1]);
            created.push('staff:' + st.name + ' (' + username + ')');
        }
        if (created.length) console.log('SYNC: created ' + created.length + ' user accounts: ' + created.join(', '));
    } catch (err) {
        console.error('syncUserAccounts error:', err);
    }
}

async function login() {
    try {
        const input = sanitizeInput(document.getElementById('login-user').value.trim());
        const password = document.getElementById('login-pass').value;
        if (!input || !password) return showLoginError('Enter username and password');

        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input, password })
        });
        const data = await res.json();

        if (!res.ok) {
            if (res.status === 401) return showLoginError('Invalid username or password');
            if (res.status === 403) return showLoginError(data.error || 'Access denied');
            return showLoginError('Login failed. Please try again.');
        }

        const user = data.user;
        if (!user) return showLoginError('Login failed');

        sessionStorage.setItem('currentUser', JSON.stringify(user));
        showLoginError('');
        document.getElementById('login-pass').value = '';
        // Check terms and conditions acceptance
        if (!await checkTermsAccepted(user)) return;
        showApp(user);
        logAudit('login', 'user', { username: user.username });
    } catch (err) {
        showLoginError('Login failed. Please try again.');
        console.error('Login error:', err);
    }
}

// Expose login function globally for HTML onclick attribute
window.login = login;

function showLoginError(msg) {
    const el = document.getElementById('login-error');
    if (msg) { el.textContent = msg; el.style.display = 'block'; } else { el.style.display = 'none'; }
}

function showApp(user) {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    document.getElementById('user-name-display').textContent = user.name || user.username;
    document.getElementById('user-role-badge').textContent = user.role.charAt(0).toUpperCase() + user.role.slice(1);
    document.getElementById('user-role-badge').className = 'badge badge-' + getRoleColor(user.role);
    buildNavigation(user);
    updateHeaderDate();
    setInterval(updateHeaderDate, 60000);
    loadBranding();
    loadAcademicSettings();
    initTabs();
    document.getElementById('attendance-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('chapel-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('audit-from').value = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    document.getElementById('audit-to').value = new Date().toISOString().split('T')[0];
    renderDashboard();
    renderStudents();
    renderCourses();
    renderStaff();
    renderFinance();
    renderPayroll();
    renderLibrary();
    renderEvents();
    renderHostels();
    renderInventory();
    renderAlumni();
    renderExams();
    renderWhatsAppTemplates();
    renderWhatsAppLog();
    renderTickets();
    updateTicketBadge();
    renderStudyCenters();
    renderUsers();
    renderGradRequirements();
    renderAudit();
    initSmartSearch();
    renderAlertBell();
    initBackgroundRefresh();
    document.getElementById('login-user').value = '';
}

async function checkTermsAccepted(user) {
    const key = 'terms_accepted_' + (user.username || user.id);
    if (localStorage.getItem(key) === 'true') return true;
    try {
        const existing = await dbGet('users', user.username || user.id);
        if (existing && existing.termsAccepted) {
            localStorage.setItem(key, 'true');
            return true;
        }
    } catch {}
    showTermsModal(user);
    return false;
}

function showTermsModal(user) {
    window._termsUser = user;
    const checkbox = document.getElementById('terms-agree-check');
    const acceptBtn = document.getElementById('terms-accept-btn');
    checkbox.checked = false;
    acceptBtn.disabled = true;
    document.getElementById('terms-modal').style.display = 'flex';
    document.getElementById('terms-scroll').scrollTop = 0;
    checkbox.onchange = function() { acceptBtn.disabled = !this.checked; };
}

window.acceptTerms = async function() {
    const user = window._termsUser;
    if (!user) return;
    const key = 'terms_accepted_' + (user.username || user.id);
    localStorage.setItem(key, 'true');
    try {
        const existing = await dbGet('users', user.username || user.id);
        if (existing) {
            existing.termsAccepted = true;
            existing.termsAcceptedAt = new Date().toISOString();
            await dbPut('users', existing);
        }
    } catch {}
    document.getElementById('terms-modal').style.display = 'none';
    showApp(user);
};

window.declineTerms = function() {
    document.getElementById('terms-modal').style.display = 'none';
    const key = 'terms_accepted_' + (window._termsUser?.username || window._termsUser?.id || '');
    localStorage.removeItem(key);
    showLoginError('You must accept the Terms and Conditions to use the System.');
    setTimeout(() => logout(), 2000);
};

function logout() {
    const user = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    logAudit('logout', 'user', { username: user.username });
    sessionStorage.removeItem('currentUser');
    location.reload();
}

function buildNavigation(user) {
    const perms = getRolePermissions(user.role);
    const nav = document.getElementById('main-nav');
    const isStudent = user.role === 'student';
    const sections = [
        { label: 'Main', items: [{ id: 'dashboard', icon: '', text: 'Dashboard' }, { id: 'student-hub', icon: '', text: '🎓 My Hub' }, ...(isStudent ? [] : [{ id: 'portal', icon: '', text: 'Student Portal' }]) ] },
        { label: 'Academic', items: [{ id: 'students', icon: '', text: 'Students' }, { id: 'courses', icon: '', text: 'Courses' }, { id: 'lessons', icon: '', text: 'Lessons' }, { id: 'attendance', icon: '', text: 'Attendance' }, { id: 'grades', icon: '', text: 'Grades' }, ...(isStudent ? [] : [{ id: 'exams', icon: '', text: 'Examinations' }]), { id: 'manuals', icon: '', text: 'Manuals' }, { id: 'chapel', icon: '', text: 'Chapel' }, { id: 'graduation', icon: '', text: 'Graduation' }] },
        { label: isStudent ? 'Assessments' : 'Assessments', items: [{ id: 'questions', icon: '', text: 'Question Bank' }, { id: 'quizzes', icon: '', text: isStudent ? 'Assessments' : 'Quizzes' }, { id: 'submissions', icon: '', text: 'Results' }, { id: 'progress', icon: '', text: 'Progress' }] },
        { label: 'Administration', items: [{ id: 'staff', icon: '', text: 'Staff' }, { id: 'finance', icon: '', text: 'Finance' }, { id: 'hostel', icon: '', text: 'Hostel' }, { id: 'library', icon: '', text: 'Library' }, { id: 'inventory', icon: '', text: 'Inventory' }, { id: 'notes', icon: '', text: 'Study Notes' }, { id: 'communication', icon: '', text: '📱 Communication Center' }] },
        { label: 'Other', items: [{ id: 'verify', icon: '', text: 'Verify Document' }, { id: 'reprint', icon: '', text: 'Reprint Document' }, { id: 'pending', icon: '', text: 'Pending Registrations' }, { id: 'alumni', icon: '', text: 'Alumni' }, { id: 'certificates', icon: '', text: 'Certificates' }, { id: 'idcards', icon: '', text: 'ID Cards' }, { id: 'events', icon: '', text: 'Events' }, { id: 'whatsapp', icon: '', text: 'WhatsApp' }, { id: 'tickets', icon: '', text: 'Tickets' }, { id: 'audit', icon: '', text: 'Audit' }, { id: 'settings', icon: '', text: 'Settings' }] }
    ];

    let html = '';
    sections.forEach(section => {
        const visible = section.items.filter(item => perms.includes(item.id));
        if (!visible.length) return;
        html += `<div class="nav-section"><div class="nav-label">${section.label}</div>${visible.map(item => {
            const badge = item.id === 'tickets' ? '<span class="nav-badge" id="ticket-badge" style="display:none;">0</span>' : '';
            return `<a href="#" class="nav-tab" data-screen="${item.id}"><span class="nav-text">${item.text}${badge}</span></a>`;
        }).join('')}</div>`;
    });
    nav.innerHTML = html;
    nav.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', (e) => { e.preventDefault(); showScreen(tab.dataset.screen); });
    });
}

async function checkAllAccountActivity() {
    const batch = await dbGetBatch(['users','students']);
    const users = batch.users, students = batch.students;
    const now = new Date();
    let changed = false;

    for (const user of users) {
        if (user.role !== 'student' || user.status === 'locked') continue;
        if (!user.lastLogin) continue;
        const workDays = countWorkingDays(user.lastLogin, now);
        const student = students.find(s => s.id === user.studentId || s.id === 'STU-' + user.username || s.email === user.username);
        const phone = student ? student.phone : '';

        if (workDays >= 20 && workDays < 27) {
            if (!user.warned1) {
                user.warned1 = true;
                if (phone) {
                    const tpl = await dbGet('whatsappTemplates', 'tpl-inactivity1');
                    if (tpl) {
                        const branding = await dbGet('settings', 'branding');
                        const schoolName = branding ? branding.schoolName : 'College';
                        const msg = applyTemplateVars(tpl.message, student || { name: user.name }, schoolName);
                        sendWhatsApp(phone, msg);
                    }
                }
                changed = true;
            }
        } else if (workDays >= 27 && workDays < 30) {
            if (!user.warned2) {
                user.warned2 = true;
                if (phone) {
                    const tpl = await dbGet('whatsappTemplates', 'tpl-inactivity2');
                    if (tpl) {
                        const branding = await dbGet('settings', 'branding');
                        const schoolName = branding ? branding.schoolName : 'College';
                        const msg = applyTemplateVars(tpl.message, student || { name: user.name }, schoolName);
                        sendWhatsApp(phone, msg);
                    }
                }
                changed = true;
            }
        } else if (workDays >= 30) {
            if (user.status !== 'locked') {
                user.status = 'locked';
                user.lockedAt = now.toISOString();
                user.lockedReason = 'Inactive for ' + workDays + ' working days';
                if (student) student.status = 'inactive';
                if (student) await dbPut('students', student);
                changed = true;
                logAudit('locked', 'user', { username: user.username, reason: user.lockedReason });
            }
        }

        if (user.warned1 && workDays < 20) user.warned1 = false;
        if (user.warned2 && workDays < 27) user.warned2 = false;

        await dbPut('users', user);
    }
}

async function showSignupForm() {
    const centers = await dbGetAll('studyCenters');
    const programs = await getProgramsList();
    const content = `<div class="form-group"><label>Full Name *</label><input type="text" id="signup-name" placeholder="Enter your full name" required></div><div class="form-row"><div class="form-group"><label>Email</label><input type="email" id="signup-email" placeholder="your@email.com"></div><div class="form-group"><label>Phone *</label><input type="text" id="signup-phone" placeholder="e.g., 254712345678" required></div></div><div class="form-group"><label>Program *</label><select id="signup-program"><option value="">Select program...</option>${programs.map(p => `<option value="${p}">${p}</option>`).join('')}</select></div><div class="form-group"><label>Study Center</label><select id="signup-center"><option value="">Select center...</option>${centers.map(c => `<option value="${c.id}">${c.name} (${c.code})</option>`).join('')}</select></div><div style="font-size:11px;color:var(--text-muted);margin-top:8px;padding:10px;background:#fef3c7;border-radius:6px;">⏳ Your request will be reviewed by the administration. You'll receive your login credentials via WhatsApp once approved.</div><div class="signup-footer">Already have an account? <a href="#" onclick="closeModal()">Sign In</a></div>`;
    showModal('Request Registration', content, `<button class="btn btn-primary" onclick="registerStudent()">Submit Request</button>`);
}

async function registerStudent() {
    try {
        const name = sanitizeInput(document.getElementById('signup-name').value.trim());
        const email = document.getElementById('signup-email').value.trim();
        const phone = sanitizeInput(document.getElementById('signup-phone').value.trim());
        const program = document.getElementById('signup-program').value;
        const centerId = document.getElementById('signup-center').value;

        if (!name) return showToast('Full name required!');
        if (!phone) return showToast('Phone number required!');
        if (!program) return showToast('Program required!');
        if (email && !validateEmail(email)) return showToast('Invalid email format!');

        const existing = (await dbGetAll('students')).find(s => s.phone === phone && s.status !== 'rejected');
        if (existing) return showToast('A registration with this phone number already exists.');

        if (email) {
            const existingEmail = (await dbGetAll('students')).find(s => s.email && s.email.toLowerCase() === email.toLowerCase() && s.status !== 'rejected');
            if (existingEmail) return showToast('Email already registered under: ' + escapeHtml(existingEmail.name));
        }

        const studentId = 'PREG-' + Date.now();
        const student = {
            id: studentId, name, email, phone, program, studyCenterId: centerId || '',
            status: 'pending', admissionNumber: '', year: 1, feeAmount: 0,
            enrollDate: '', createdAt: new Date().toISOString(),
            registrationRequestedAt: new Date().toISOString()
        };
        await dbPut('students', student);

        try {
            await addManualAlert('warning', 'info',
                `New Registration Request`,
                `${student.name} has requested registration. Phone: ${student.phone}, Program: ${student.program}. Please review and approve or reject.`
            );
        } catch (e) { console.error('Signup alert error:', e); }

        closeModal();
        showToast('Registration request submitted! You will be notified once approved.', { type: 'success' });
        logAudit('requested', 'registration', { studentId, name, phone });
    } catch (err) {
        showToast('Request failed: ' + err.message, { type: 'danger' });
        console.error('Registration error:', err);
    }
}

async function reactivateUser(username) {
    const user = await dbGet('users', username);
    if (!user) return;
    user.status = 'active';
    delete user.lockedAt;
    delete user.lockedReason;
    delete user.warned1;
    delete user.warned2;
    await dbPut('users', user);

    const students = await dbGetAll('students');
    const student = students.find(s => s.id === user.studentId || s.id === username);
    if (student && student.status === 'inactive') {
        student.status = 'active';
        await dbPut('students', student);
    }

    renderUsers();
    showToast(`Account ${username} reactivated!`);
    logAudit('reactivated', 'user', { username });
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.getElementById('login-screen').style.display !== 'none') login();
    if (e.key === 'Escape') closeModal();
});

async function checkStartupAlerts() {
    const alerts = (await dbGetAll('alerts')).filter(a => a.status === 'active');
    if (alerts.length === 0) return;
    showAlertCarousel(alerts);
}

var _carouselTimer;
var _carouselIndex;
var _carouselAlerts;

async function showAlertCarousel(alerts) {
    _carouselAlerts = alerts.sort((a, b) => {
        const sev = { danger: 0, warning: 1, info: 2, success: 3 };
        return sev[a.severity] - sev[b.severity];
    });
    _carouselIndex = 0;

    const overlay = document.createElement('div');
    overlay.id = 'alert-carousel-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    document.body.appendChild(overlay);

    const card = document.createElement('div');
    card.id = 'alert-carousel-card';
    card.style.cssText = 'background:var(--card);border-radius:12px;width:100%;max-width:500px;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.4)';
    overlay.appendChild(card);

    renderCarouselAlert();
    startCarouselTimer();
}

function renderCarouselAlert() {
    const card = document.getElementById('alert-carousel-card');
    if (!card) return;

    const total = _carouselAlerts.length;
    const current = _carouselIndex;
    const alert = _carouselAlerts[current];
    const sev = alert.severity || 'info';
    const sevColor = sev === 'danger' ? 'var(--danger)' : sev === 'warning' ? 'var(--warning)' : sev === 'info' ? 'var(--primary-light)' : 'var(--success)';
    const sevBg = sev === 'danger' ? 'rgba(220,53,69,0.08)' : sev === 'warning' ? 'rgba(255,193,7,0.08)' : sev === 'info' ? 'rgba(0,123,255,0.08)' : 'rgba(40,167,69,0.08)';

    card.innerHTML = `
    <div style="padding:20px 20px 0">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <div style="display:flex;align-items:center;gap:10px">
                <span style="font-size:11px;font-weight:700;color:${sevColor};text-transform:uppercase;letter-spacing:1px">${sev}</span>
                <span style="font-size:12px;color:var(--text-muted)">${current + 1} of ${total}</span>
            </div>
            <span style="color:var(--text-muted);font-size:18px;cursor:pointer" onclick="closeAlertCarousel()">x</span>
        </div>
        <div style="width:100%;height:4px;background:var(--border);border-radius:2px">
            <div style="width:${((current + 1) / total) * 100}%;height:4px;background:${sevColor};border-radius:2px;transition:width 0.3s"></div>
        </div>
    </div>
    <div style="padding:20px">
        <div style="background:${sevBg};border-left:4px solid ${sevColor};border-radius:0 8px 8px 0;padding:16px;font-size:15px;line-height:1.6;color:var(--text-primary)">
            ${formatAlertMessage(alert)}
        </div>
        <div style="margin-top:12px;font-size:12px;color:var(--text-muted)">${timeAgo(alert.createdAt)} ago</div>
    </div>
    <div style="padding:0 20px 20px;display:flex;gap:10px">
        <button onclick="skipCarouselAlert()" style="flex:1;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;cursor:pointer;font-weight:600">Skip</button>
        <button onclick="showAllAlertsFromCarousel()" style="flex:2;padding:10px;border:none;border-radius:8px;background:var(--accent);color:#fff;font-size:13px;cursor:pointer;font-weight:600">View All ${total} Alerts</button>
    </div>`;
}

function formatAlertMessage(alert) {
    const title = alert.title || '';
    const details = alert.details || '';
    const name = alert.entityName || '';
    const sev = alert.severity || 'info';

    if (alert.type === 'missing-manuals') {
        const match = details.match(/(.+?)\s+\(([^)]+)\)\s+has not received\s+"(.+?)"\s+for\s+(.+?)\./);
        if (match) {
            return `<strong>${match[1]}</strong>, Adm No <strong>${match[2]}</strong> has not received manual <strong>"${match[3]}"</strong> for <strong>${match[4]}</strong>.`;
        }
        return details;
    }
    if (alert.type === 'absent-2-weeks') {
        const countMatch = details.match(/been absent (\d+)\s+times/);
        const datesMatch = details.match(/\[([^\]]+)(?:,\s*([^\]]+))?\]/);
        let msg = `<strong>${name}</strong> has been absent for 2 weeks.`;
        if (countMatch) msg += ` <strong>${countMatch[1]} times</strong> in the last 14 days.`;
        if (datesMatch) msg += `<br><span style="font-size:13px;color:var(--text-muted)">Dates: ${datesMatch[0].replace(/[\[\]]/g,'')}</span>`;
        return msg;
    }
    if (alert.type === 'missing-exams') {
        if (details.includes('not registered')) {
            const match = details.match(/(.+?)\s+is not registered for exam\s+"(.+?)"/);
            if (match) return `<strong>${match[1]}</strong> is not registered for exam <strong>"${match[2]}"</strong>.`;
        }
        if (details.includes('registered') && details.includes('not submitted')) {
            const match = details.match(/(.+?)\s+registered for exam\s+"(.+?)"/);
            if (match) return `<strong>${match[1]}</strong> registered for exam <strong>"${match[2]}"</strong> but has not submitted.`;
        }
    }
    if (alert.type === 'fee-overdue') {
        const match = details.match(/(.+?)\s+has an outstanding balance of\s+(.+?)\s+\(([^)]+)\)/);
        if (match) return `<strong>${match[1]}</strong> has a fee balance of <strong>${match[2]}</strong> (<strong>${match[3]}</strong> paid).`;
    }
    return `<strong>${name}</strong>: ${details}`;
}

function startCarouselTimer() {
    if (_carouselTimer) clearInterval(_carouselTimer);
    _carouselTimer = setInterval(() => {
        if (_carouselIndex < _carouselAlerts.length - 1) {
            _carouselIndex++;
            renderCarouselAlert();
        } else {
            closeAlertCarousel();
        }
    }, 5000);
}

function skipCarouselAlert() {
    if (_carouselTimer) clearInterval(_carouselTimer);
    if (_carouselIndex < _carouselAlerts.length - 1) {
        _carouselIndex++;
        renderCarouselAlert();
        startCarouselTimer();
    } else {
        closeAlertCarousel();
    }
}

function showAllAlertsFromCarousel() {
    closeAlertCarousel();
    showScreen('dashboard');
    setTimeout(() => {
        const dash = document.getElementById('dash-alerts');
        if (dash) dash.scrollIntoView({ behavior: 'smooth' });
    }, 200);
}

function closeAlertCarousel() {
    if (_carouselTimer) clearInterval(_carouselTimer);
    const overlay = document.getElementById('alert-carousel-overlay');
    if (overlay) overlay.remove();
}

var bgRefreshTimer;
function initBackgroundRefresh() {
    if (bgRefreshTimer) clearInterval(bgRefreshTimer);
    bgRefreshTimer = setInterval(async () => {
        try {
            await updateTicketBadge();
            await refreshMessagesBadge();
            await refreshTicketsBadge();
            await renderAlertBell();
        } catch {}
    }, 30000);
    refreshMessagesBadge();
    refreshTicketsBadge();
}

async function refreshMessagesBadge() {
    const messages = await dbGetAll('messages');
    const user = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    if (!user.username) return;
    const now = Date.now();
    const unread = messages.filter(m => !m.read && m.recipient === user.username && (now - m.timestamp) < 86400000);
    const badge = document.getElementById('msg-badge');
    if (badge) badge.textContent = unread.length > 0 ? unread.length : '';
}

async function refreshTicketsBadge() {
    const tickets = await dbGetAll('tickets');
    const badge = document.getElementById('ticket-badge');
    if (badge) {
        const open = tickets.filter(t => t.status === 'open').length;
        badge.textContent = open > 0 ? open : '';
    }
}

function initManuals() {
    renderManuals();
}
init();

function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('open');
}

function showScreen(id) {
    const user = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const perms = getRolePermissions(user.role);
    if (!perms.includes(id)) return showToast('Access denied: You do not have permission to view this section.');

    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('screen-' + id).classList.add('active');
    const tab = document.querySelector(`.nav-tab[data-screen="${id}"]`);
    if (tab) tab.classList.add('active');
    // Close sidebar on mobile after navigation
    const sidebar = document.querySelector('.sidebar');
    if (sidebar && window.innerWidth <= 768) sidebar.classList.remove('open');

    switch (id) {
        case 'dashboard': renderDashboard(); renderAlertDashboard(); break;
        case 'students': renderStudents(); break;
        case 'courses': renderCourses(); break;
        case 'lessons': renderLessons(); break;
        case 'attendance': document.getElementById('attendance-date').value = new Date().toISOString().split('T')[0]; populateAttendanceCourses(); break;
        case 'grades': break;
        case 'exams': renderExams(); break;
        case 'staff': renderStaff(); break;
        case 'finance': renderFinance(); renderPayroll(); onStatementTypeChange(); renderMpesaTab(); break;
        case 'chapel': document.getElementById('chapel-date').value = new Date().toISOString().split('T')[0]; break;
        case 'graduation': populateGraduationFilters(); break;
        case 'hostel': renderHostels(); break;
        case 'library': renderLibrary(); break;
        case 'inventory': renderInventory(); break;
        case 'alumni': renderAlumni(); break;
        case 'certificates': renderDocumentHistory(); break;
        case 'events': renderEvents(); break;
        case 'whatsapp': renderWhatsAppTemplates(); renderWhatsAppLog(); break;
        case 'communication': loadCommunicationPage(); break;
        case 'messages': renderMessages(); break;
        case 'audit': renderAudit(); renderUsers(); break;
        case 'idcards': break;
        case 'questions': renderQuestionBank(); break;
        case 'quizzes': renderQuizzes(); break;
        case 'submissions': renderSubmissions(); break;
        case 'progress': renderProgress(); break;
        case 'notes': renderNotes(); break;
        case 'portal': renderStudentPortal(); renderPortalNotes(); break;
        case 'student-hub': renderStudentHub(); break;
        case 'pending': renderPendingRegistrations(); break;
        case 'tickets': renderTickets(); break;
        case 'manuals': initManuals(); break;
        case 'settings': loadBranding(); renderStudyCenters(); renderUsers(); renderGradRequirements(); break;
    }
}

function initTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabGroup = btn.closest('.tabs');
            const tabId = btn.dataset.tab;
            tabGroup.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const parent = tabGroup.parentElement;
            parent.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
            document.getElementById('tab-' + tabId).classList.add('active');
        });
    });
}

function updateHeaderDate() {
    const now = new Date();
    document.getElementById('header-date').textContent = now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

async function init() {
    try {
        await openDB();
        if (sessionStorage.getItem('currentUser') && isSessionExpired()) {
            sessionStorage.removeItem('currentUser');
            showToast('Session expired. Please login again.', { type: 'warning', duration: 5000 });
        }
        await initAuth();
        startAutoRefresh();
    } catch (err) {
        console.error('App initialization failed:', err);
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;"><div style="text-align:center;padding:40px;"><h2 style="color:var(--danger);">Failed to Load Application</h2><p style="color:var(--text-muted);">' + (err.message || err) + '</p><p style="font-size:12px;color:var(--text-muted);margin-top:4px;">Please clear your browser data (IndexedDB) and refresh the page.</p><button onclick="location.reload()" style="padding:8px 24px;margin-top:12px;cursor:pointer;">Refresh</button></div></div>';
    }
}

var _refreshTimers = [];
var _sseConnection;
var _sseConnected;
function startAutoRefresh() {
    stopAutoRefresh();
    if (!document.getElementById('screen-dashboard')) return;
    const user = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    if (user.username) heartbeat(user);
    const pollIfNoSSE = (fn, ms) => setInterval(() => { if (!_sseConnected) fn(); }, ms);
    _refreshTimers.push(pollIfNoSSE(pollTickets, 30000));
    _refreshTimers.push(pollIfNoSSE(pollAlerts, 30000));
    _refreshTimers.push(pollIfNoSSE(pollDashboard, 60000));
    _refreshTimers.push(setInterval(() => { const u = JSON.parse(sessionStorage.getItem('currentUser') || '{}'); if (u.username) heartbeat(u); }, 45000));
    _refreshTimers.push(setInterval(renderOnlineUsers, 30000));
    try {
        if (_sseConnection) { _sseConnection.close(); _sseConnection = null; }
        _sseConnection = new EventSource('/api/events');
        _sseConnection.addEventListener('db-change', (e) => {
            _sseConnected = true;
            try {
                const { store, record } = JSON.parse(e.data);
                if (store === 'tickets') pollTickets();
                else if (store === 'alerts') pollAlerts();
                else { pollDashboard(); onDBChange(store, record); }
            } catch {}
        });
        _sseConnection.onerror = () => {
            _sseConnected = false;
            setTimeout(() => { try { if (_sseConnection && _sseConnection.readyState === EventSource.CLOSED) startAutoRefresh(); } catch {} }, 5000);
        };
    } catch {}
}

async function heartbeat(user) {
    try { await fetch('/api/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user.username, name: user.name, role: user.role }) }); } catch {}
}

async function renderOnlineUsers() {
    try {
        const u = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
        if (u.role === 'student') return;
        const res = await fetch('/api/online');
        const data = await res.json();
        const el = document.getElementById('dash-online');
        if (el) {
            const students = data.users.filter(u2 => u2.role === 'student');
            const staff = data.users.filter(u2 => u2.role !== 'student');
            el.innerHTML = `<div style="padding:12px;"><div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="font-weight:700;">Online Now</span><span style="font-size:18px;font-weight:800;color:var(--success);">${data.count}</span></div>${data.count > 0 ? `<div style="font-size:11px;color:var(--text-muted);">${students.length} student${students.length !== 1 ? 's' : ''}${staff.length ? ` · ${staff.length} staff` : ''}</div><div style="margin-top:8px;max-height:120px;overflow-y:auto;">${data.users.slice(0, 10).map(u2 => `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--border);"><span>${u2.name}</span><span class="badge badge-${u2.role === 'student' ? 'info' : 'success'}" style="font-size:9px;">${u2.role}</span></div>`).join('')}</div>` : '<div style="font-size:11px;color:var(--text-muted);text-align:center;">No users currently online</div>'}</div>`;
        }
    } catch {}
}

function stopAutoRefresh() {
    _refreshTimers.forEach(t => clearInterval(t));
    _refreshTimers = [];
    if (_sseConnection) { _sseConnection.close(); _sseConnection = null; }
}

var _lastTicketCount;
async function pollTickets() {
    try {
        const tickets = await dbGetAll('tickets');
        const open = tickets.filter(t => t.status === 'open' || t.status === 'in-progress').length;
        const badge = document.getElementById('ticket-badge');
        if (badge) { badge.textContent = open; badge.style.display = open > 0 ? 'inline' : 'none'; }
        if (_lastTicketCount >= 0 && open > _lastTicketCount) {
            showToast('New ticket received!', { type: 'info', icon: '🎫', duration: 4000 });
        }
        _lastTicketCount = open;
        if (document.getElementById('screen-tickets')?.classList.contains('active')) renderTickets();
    } catch {}
}

async function pollAlerts() {
    try {
        await renderAlertBell();
        if (document.getElementById('screen-dashboard')?.classList.contains('active')) renderAlertDashboard();
    } catch {}
}

var _dashTimer;
async function pollDashboard() {
    try {
        const dash = document.getElementById('screen-dashboard');
        const u = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
        if (u.role === 'student') {
            if (dash?.classList.contains('active')) renderStudentDashboard(u);
            return;
        }
        if (dash?.classList.contains('active')) {
            _dashTimer++;
            if (_dashTimer % 2 === 0) {
                const tickets = await dbGetAll('tickets');
                const openTickets = tickets.filter(t => t.status === 'open' || t.status === 'in-progress');
                const urgentTickets = tickets.filter(t => t.priority === 'urgent' && t.status !== 'closed');
                document.getElementById('dash-tickets').innerHTML = tickets.length ? (openTickets.length ? openTickets.slice(0, 4).map(t => {
                    const priorityBadge = t.priority === 'urgent' ? 'badge-danger' : t.priority === 'high' ? 'badge-warning' : 'badge-info';
                    return `<div class="event-item"><span style="font-size:11px;"><b>${escapeHtml(t.ticketNo)}</b> — ${escapeHtml(t.subject.substring(0, 30))}${t.subject.length > 30 ? '...' : ''}</span><span class="badge ${priorityBadge}">${escapeHtml(t.priority)}</span></div>`;
                }).join('') : '<div style="text-align:center;color:var(--success);padding:20px;">All tickets resolved!</div>') : '<div style="text-align:center;color:var(--text-muted);padding:20px;">No tickets</div>';
            }
        }
    } catch {}
}

// Real-time refresh when DB changes
function refreshPortal(store, record) {
    if (record && portalDataCache) {
        applyPortalCacheUpdate(store, record);
    } else {
        invalidatePortalCache();
    }
    if (document.getElementById('screen-portal')?.classList.contains('active')) {
        renderStudentPortal();
    }
}
var isScreenActive = (id) => document.getElementById('screen-' + id)?.classList.contains('active');
var _refreshMap = {
    payments: (r) => { refreshPortal('payments', r); if (isScreenActive('finance')) renderFinance(); },
    expenses: (r) => { refreshPortal('expenses', r); if (isScreenActive('finance')) renderFinance(); },
    income: (r) => { refreshPortal('income', r); if (isScreenActive('finance')) renderFinance(); },
    students: (r) => { refreshPortal('students', r); if (isScreenActive('students')) renderStudents(); },
    staff: () => { if (isScreenActive('staff')) renderStaff(); },
    courses: (r) => { refreshPortal('courses', r); if (isScreenActive('courses')) renderCourses(); },
    lessons: (r) => { refreshPortal('lessons', r); if (isScreenActive('courses')) renderCourses(); },
    quizzes: (r) => { refreshPortal('quizzes', r); if (isScreenActive('quizzes')) renderQuizzes(); },
    exams: (r) => { refreshPortal('exams', r); if (isScreenActive('quizzes')) renderQuizzes(); if (isScreenActive('exams')) renderExams(); },
    questions: () => { if (isScreenActive('questions')) renderQuestionBank(); },
    enrollments: (r) => { refreshPortal('enrollments', r); if (isScreenActive('courses')) renderCourses(); },
    submissions: (r) => { refreshPortal('submissions', r); if (isScreenActive('quizzes')) renderQuizzes(); },
    examRegistrations: (r) => { refreshPortal('examRegistrations', r); if (isScreenActive('quizzes')) renderQuizzes(); },
    quizRegistrations: (r) => { refreshPortal('quizRegistrations', r); if (isScreenActive('quizzes')) renderQuizzes(); },
    manuals: (r) => { refreshPortal('manuals', r); if (isScreenActive('manuals')) initManuals(); },
    notes: (r) => { refreshPortal('notes', r); if (isScreenActive('notes')) renderNotes(); },
    library: () => { if (isScreenActive('library')) renderLibrary(); },
    attendance: (r) => { refreshPortal('attendance', r); if (isScreenActive('attendance')) populateAttendanceCourses(); },
    events: () => { if (isScreenActive('events')) renderEvents(); },
    tickets: () => { if (isScreenActive('dashboard')) renderDashboard(); },
    alerts: () => { renderAlertBell(); generateAlerts(); if (isScreenActive('dashboard')) renderDashboard(); },
    payslips: () => { if (isScreenActive('finance')) renderPayrollList(); },
    salaryDeductions: () => { if (isScreenActive('finance')) renderDeductionsSummary(); },
    mpesaTransactions: () => { if (isScreenActive('finance')) renderMpesaTransactions(); },
};
function onDBChange(store, record) {
    const fn = _refreshMap[store];
    if (fn) {
        try { fn(record); } catch (e) {}
    }
    if (isScreenActive('dashboard')) {
        try { renderDashboard(); } catch (e) {}
    }
    try { renderAlertBell(); } catch (e) {}
}

function adjustHeaderPadding() {
    const header = document.getElementById('main-header');
    const app = document.getElementById('app');
    if (header && app) {
        const h = header.offsetHeight;
        app.style.paddingTop = h + 'px';
        document.querySelectorAll('.sidebar').forEach(s => {
            s.style.top = h + 'px';
            s.style.height = 'calc(100vh - ' + h + 'px)';
        });
    }
}

window.addEventListener('resize', adjustHeaderPadding);
adjustHeaderPadding();
init();

async function renderDashboard() {
    try {
        const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
        const isStudentUser = currentUser && currentUser.role === 'student';

        if (isStudentUser) {
            document.querySelector('#screen-dashboard .screen-actions') && (document.querySelector('#screen-dashboard .screen-actions').style.display = 'none');
            await renderStudentDashboard(currentUser);
            return;
        }
        document.querySelector('#screen-dashboard .screen-actions') && (document.querySelector('#screen-dashboard .screen-actions').style.display = '');
        const actions = document.querySelector('#screen-dashboard .screen-actions');
        const canManageFinance = ['admin', 'finance', 'registrar'].includes(currentUser.role);
        if (actions && canManageFinance) {
            if (!actions.querySelector('#dash-record-payment')) {
                actions.insertAdjacentHTML('beforeend', `<button class="btn btn-primary" id="dash-record-payment" onclick="showPaymentForm()">+ Record Payment</button>`);
            }
            if (!actions.querySelector('#dash-record-expense')) {
                actions.insertAdjacentHTML('beforeend', `<button class="btn btn-outline" id="dash-record-expense" onclick="showExpenseForm()">+ Record Expense</button>`);
            }
        } else if (actions) {
            actions.querySelector('#dash-record-payment')?.remove();
            actions.querySelector('#dash-record-expense')?.remove();
        }

        const batch = await dbGetBatch(['students','courses','events','staff','attendance','inventory','alumni','payments','income','expenses']);
        const students = batch.students, courses = batch.courses, events = batch.events, staff = batch.staff, attendance = batch.attendance, inventory = batch.inventory, alumniList = batch.alumni, payments = batch.payments, income = batch.income, expenses = batch.expenses;
    const today = new Date().toISOString().split('T')[0];
    const settings = await dbGet('settings', 'academic');
    const minAttendance = settings ? settings.attendanceMin || 75 : 75;

    const activeStudents = students.filter(s => s.status === 'active').length;
    const totalEnrolled = students.length;
    const todayPayments = payments.filter(p => p.date === today);
    const todayIncome = income.filter(i => i.date === today);
    const todayExpenses = expenses.filter(e => e.date === today);
    const todayTotal = todayPayments.reduce((s, p) => s + p.amount, 0) + todayIncome.reduce((s, i) => s + i.amount, 0);
    const monthPayments = payments.filter(p => p.date >= today.substring(0, 7)).reduce((s, p) => s + p.amount, 0);
    const monthIncome = income.filter(i => i.date >= today.substring(0, 7)).reduce((s, i) => s + i.amount, 0);
    const monthExpenses = expenses.filter(e => e.date >= today.substring(0, 7)).reduce((s, e) => s + e.amount, 0);
    const monthRevenue = monthPayments + monthIncome - monthExpenses;
    const alumniCount = alumniList.length;
    const inventoryItems = inventory.length;

        document.getElementById('dash-stats').innerHTML = `<div class="stat-card"><div class="stat-label">Total Students</div><div class="stat-value">${totalEnrolled}</div></div><div class="stat-card"><div class="stat-label">Active Students</div><div class="stat-value" style="color:var(--success)">${activeStudents}</div></div><div class="stat-card"><div class="stat-label">Courses</div><div class="stat-value">${courses.length}</div></div><div class="stat-card"><div class="stat-label">Staff</div><div class="stat-value">${staff.length}</div></div><div class="stat-card"><div class="stat-label">Alumni</div><div class="stat-value">${alumniCount}</div></div><div class="stat-card"><div class="stat-label">Inventory Items</div><div class="stat-value">${inventoryItems}</div></div><div class="stat-card"><div class="stat-label">Today's Revenue</div><div class="stat-value" style="color:var(--accent)">${formatCurrency(todayTotal)}</div></div><div class="stat-card"><div class="stat-label">Monthly Net</div><div class="stat-value" style="color:${monthRevenue >= 0 ? 'var(--success)' : 'var(--danger)'}">${formatCurrency(monthRevenue)}</div></div><div class="stat-card" style="cursor:pointer;" onclick="window.open('/connect.html', '_blank', 'width=420,height=700')"><div class="stat-label">Connect Devices</div><div class="stat-value" style="font-size:24px;">[+]</div><div class="stat-label" style="font-size:10px;margin-top:2px;color:var(--accent);">QR Code & Network Info</div></div>`;

    const recentStudents = students.sort((a, b) => new Date(b.enrollDate) - new Date(a.enrollDate)).slice(0, 5);
    document.getElementById('dash-recent-students').innerHTML = recentStudents.length ? recentStudents.map(s => `<div class="event-item"><span><b>${escapeHtml(s.name)}</b> - ${escapeHtml(s.program || 'N/A')}</span><span class="badge badge-${s.status === 'active' ? 'success' : 'warning'}">${s.status || 'active'}</span></div>`).join('') : '<div style="text-align:center;color:var(--text-muted);padding:20px;">No students enrolled yet</div>';

    document.getElementById('dash-today-schedule').innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:10px;"><p><b>Today's Schedule</b></p><p style="font-size:12px;margin-top:4px;">${courses.length} courses available</p></div>`;

    const upcomingEvents = events.filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
    document.getElementById('dash-upcoming-events').innerHTML = upcomingEvents.length ? upcomingEvents.map(e => `<div class="event-item"><span><b>${escapeHtml(e.title)}</b></span><span style="color:var(--text-muted);font-size:12px;">${formatDate(e.date)}</span></div>`).join('') : '<div style="text-align:center;color:var(--text-muted);padding:20px;">No upcoming events</div>';

    const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
    const totalOtherIncome = income.reduce((s, i) => s + i.amount, 0);
    const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
    const netBalance = totalPaid + totalOtherIncome - totalExpenses;
    const studentsWithBalances = students.filter(s => { const paid = payments.filter(p => p.studentId === s.id).reduce((sum, p) => sum + p.amount, 0); return getCachedStudentFee(s) - paid > 0; }).length;
    document.getElementById('dash-finance').innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center;"><div><div style="font-size:11px;color:var(--text-muted);">Fee Income</div><div style="font-weight:700;color:var(--success);">${formatCurrency(totalPaid)}</div></div><div><div style="font-size:11px;color:var(--text-muted);">Other Income</div><div style="font-weight:700;color:var(--info);">${formatCurrency(totalOtherIncome)}</div></div><div><div style="font-size:11px;color:var(--text-muted);">Expenses</div><div style="font-weight:700;color:var(--danger);">${formatCurrency(totalExpenses)}</div></div><div><div style="font-size:11px;color:var(--text-muted);">Net Balance</div><div style="font-weight:700;color:${netBalance >= 0 ? 'var(--success)' : 'var(--danger)'};">${formatCurrency(netBalance)}</div></div><div><div style="font-size:11px;color:var(--text-muted);">With Balance</div><div style="font-weight:700;color:var(--warning);">${studentsWithBalances}</div></div></div>`;

    const attendanceAlerts = students.filter(s => {
        const studentAtt = attendance.filter(a => a.studentId === s.id);
        if (!studentAtt.length) return false;
        const attended = studentAtt.filter(a => a.status === 'present' || a.status === 'late').length;
        return (attended / studentAtt.length) * 100 < minAttendance;
    });
    document.getElementById('dash-attendance-alerts').innerHTML = attendanceAlerts.length ? attendanceAlerts.slice(0, 5).map(s => {
        const studentAtt = attendance.filter(a => a.studentId === s.id);
        const attended = studentAtt.filter(a => a.status === 'present' || a.status === 'late').length;
        const pct = Math.round((attended / studentAtt.length) * 100);
        return `<div class="event-item"><span><b>${s.name}</b></span><span class="badge badge-danger">${pct}%</span></div>`;
    }).join('') : '<div style="text-align:center;color:var(--text-muted);padding:20px;">All students meeting attendance requirements</div>';

    const lowStock = inventory.filter(i => i.quantity <= (i.minStock || 5));
    document.getElementById('dash-stock-alerts').innerHTML = lowStock.length ? lowStock.slice(0, 5).map(i => `<div class="event-item"><span>${i.name}</span><span class="badge badge-${i.quantity <= 0 ? 'danger' : 'warning'}">${i.quantity} left</span></div>`).join('') : '<div style="text-align:center;color:var(--text-muted);padding:20px;">All items well stocked</div>';

    const tickets = await dbGetAll('tickets');
    const openTickets = tickets.filter(t => t.status === 'open' || t.status === 'in-progress');
    const urgentTickets = tickets.filter(t => t.priority === 'urgent' && t.status !== 'closed');
        document.getElementById('dash-tickets').innerHTML = tickets.length ? (openTickets.length ? openTickets.slice(0, 4).map(t => {
        const priorityBadge = t.priority === 'urgent' ? 'badge-danger' : t.priority === 'high' ? 'badge-warning' : 'badge-info';
        return `<div class="event-item"><span style="font-size:11px;"><b>${escapeHtml(t.ticketNo)}</b> — ${escapeHtml(t.subject.substring(0, 30))}${t.subject.length > 30 ? '...' : ''}</span><span class="badge ${priorityBadge}">${escapeHtml(t.priority)}</span></div>`;
    }).join('') : '<div style="text-align:center;color:var(--success);padding:20px;">All tickets resolved!</div>') : '<div style="text-align:center;color:var(--text-muted);padding:20px;">No tickets</div>';

    renderServerHealth();
    renderOnlineUsers();
        checkAuditStale();
    } catch (err) {
        console.error('Dashboard render error:', err);
        document.getElementById('dash-stats') && (document.getElementById('dash-stats').textContent = 'Error loading dashboard. Please refresh.');
    }
}

async function renderServerHealth() {
    try {
        const el = document.getElementById('dash-server-health');
        if (!el) return;
        const [health, net] = await Promise.all([
            fetch('/api/health').then(r => r.json()).catch(() => null),
            fetch('/api/network').then(r => r.json()).catch(() => null)
        ]);
        const uptime = health ? Math.floor(health.uptime) : 0;
        const days = Math.floor(uptime / 86400);
        const hours = Math.floor((uptime % 86400) / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        const uptimeStr = days ? `${days}d ${hours}h ${mins}m` : hours ? `${hours}h ${mins}m` : `${mins}m`;
        el.innerHTML = `<div style="padding:12px;"><div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="font-weight:600;">Server</span><span class="badge badge-success">Running</span></div><div style="font-size:11px;color:var(--text-muted);">Uptime: ${uptimeStr}</div><div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Port: ${net ? net.port : '3000'}</div>${net && net.interfaces ? net.interfaces.map(i => `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${i.name}: <b>${i.address}</b></div>`).join('') : ''}<div style="font-size:11px;color:var(--text-muted);margin-top:6px;border-top:1px solid var(--border);padding-top:6px;">Online: ${document.getElementById('dash-online')?.textContent?.match(/\d+/) || '0'} user(s)</div></div>`;
    } catch {}
}

async function renderStudentDashboard(currentUser) {
    try {
        const batch = await dbGetBatch(['students','courses','lessons','quizzes','submissions','grades','attendance','payments','events','exams','enrollments']);
        const students = batch.students, courses = batch.courses, lessons = batch.lessons, quizzes = batch.quizzes, submissions = batch.submissions, grades = batch.grades, attendance = batch.attendance, payments = batch.payments, events = batch.events, exams = batch.exams, enrollments = batch.enrollments;
    const today = new Date().toISOString().split('T')[0];

    const me = students.find(s => s.id === currentUser.studentId || s.id === currentUser.username);
    if (!me) {
        document.getElementById('dash-stats').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">Profile not found</div>';
        return;
    }

    const studentId = me.id;
    const studentPayments = payments.filter(p => p.studentId === studentId);
    const totalPaid = studentPayments.reduce((s, p) => s + p.amount, 0);
    const meFee = getCachedStudentFee(me);
    const balance = meFee - totalPaid;
    const studentAttendance = attendance.filter(a => a.studentId === studentId);
    const attended = studentAttendance.filter(a => a.status === 'present' || a.status === 'late').length;
    const attendancePct = studentAttendance.length ? Math.round((attended / studentAttendance.length) * 100) : 0;
    const studentGrades = grades.filter(g => g.studentId === studentId);
    const avgGrade = studentGrades.length ? Math.round(studentGrades.reduce((s, g) => s + g.score, 0) / studentGrades.length) : 0;
    const studentSubmissions = submissions.filter(s => s.studentId === studentId);
    const quizzesPassed = studentSubmissions.filter(s => s.status === 'pass').length;
    const publishedCourses = courses.filter(c => lessons.some(l => l.courseId === c.id && l.published));

    document.getElementById('dash-stats').innerHTML = `<div class="stat-card"><div class="stat-label">Welcome</div><div class="stat-value" style="font-size:16px;">${escapeHtml(me.name)}</div></div><div class="stat-card"><div class="stat-label">Admission #</div><div class="stat-value" style="font-size:14px;">${escapeHtml(me.admissionNumber || '--')}</div></div><div class="stat-card"><div class="stat-label">Program</div><div class="stat-value" style="font-size:14px;">${escapeHtml(me.program || '--')}</div></div><div class="stat-card"><div class="stat-label">Avg Grade</div><div class="stat-value" style="color:${avgGrade >= 70 ? 'var(--success)' : avgGrade >= 50 ? 'var(--warning)' : 'var(--danger)'};">${avgGrade}%</div></div><div class="stat-card"><div class="stat-label">Attendance</div><div class="stat-value" style="color:${attendancePct >= 75 ? 'var(--success)' : 'var(--danger)'};">${attendancePct}%</div></div><div class="stat-card"><div class="stat-label">Fee Balance</div><div class="stat-value" style="color:${balance <= 0 ? 'var(--success)' : 'var(--warning)'};">${formatCurrency(balance)}</div></div><div class="stat-card"><div class="stat-label">Quizzes Passed</div><div class="stat-value" style="color:var(--success);">${quizzesPassed}</div></div><div class="stat-card"><div class="stat-label">Courses</div><div class="stat-value">${publishedCourses.length}</div></div>`;

    document.getElementById('dash-recent-students').innerHTML = `<div style="padding:12px;"><h4 style="color:var(--accent);margin-bottom:8px;">Your Courses</h4>${publishedCourses.length ? publishedCourses.slice(0, 5).map(c => `<div class="event-item"><span><b>${escapeHtml(c.code)}</b> — ${escapeHtml(c.name)}</span><span class="badge badge-success">Published</span></div>`).join('') : '<div style="color:var(--text-muted);padding:10px;">No published courses yet</div>'}</div>`;

    const todayStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    document.getElementById('dash-today-schedule').innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:10px;"><p><b>Today</b></p><p style="font-size:12px;margin-top:4px;">${todayStr}</p></div>`;

    const upcomingEvents = events.filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
    document.getElementById('dash-upcoming-events').innerHTML = upcomingEvents.length ? upcomingEvents.map(e => `<div class="event-item"><span><b>${e.title}</b></span><span style="color:var(--text-muted);font-size:12px;">${formatDate(e.date)}</span></div>`).join('') : '<div style="text-align:center;color:var(--text-muted);padding:20px;">No upcoming events</div>';

    document.getElementById('dash-finance').innerHTML = `<div style="padding:12px;text-align:center;"><div style="font-size:11px;color:var(--text-muted);">Total Fees</div><div style="font-weight:700;font-size:18px;">${formatCurrency(meFee)}</div><div style="margin-top:8px;font-size:11px;color:var(--text-muted);">Paid: <span style="color:var(--success);">${formatCurrency(totalPaid)}</span></div><div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Balance: <span style="color:${balance <= 0 ? 'var(--success)' : 'var(--danger)'};font-weight:700;">${formatCurrency(balance)}</span></div></div>`;

    document.getElementById('dash-attendance-alerts').innerHTML = `<div style="padding:12px;text-align:center;"><div style="font-size:24px;font-weight:800;color:${attendancePct >= 75 ? 'var(--success)' : 'var(--danger)'};">${attendancePct}%</div><div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${attended} of ${studentAttendance.length} sessions attended</div>${attendancePct < 75 ? '<div style="font-size:11px;color:var(--danger);margin-top:8px;">⚠ Below minimum attendance!</div>' : ''}</div>`;

    document.getElementById('dash-stock-alerts').innerHTML = `<div style="padding:12px;"><h4 style="color:var(--accent);margin-bottom:8px;">Recent Grades</h4>${studentGrades.length ? studentGrades.slice(0, 5).map(g => {
        const course = courses.find(c => c.id === g.courseId);
        return `<div class="event-item"><span><b>${course ? course.name : g.courseId}</b></span><span class="badge badge-${g.score >= 70 ? 'success' : g.score >= 50 ? 'warning' : 'danger'}">${g.score}% (${g.grade})</span></div>`;
    }).join('') : '<div style="color:var(--text-muted);padding:10px;">No grades recorded yet</div>'}</div>`;

    const enrolledCourseIds = new Set((enrollments || []).filter(e => e.studentId === studentId).map(e => e.courseId));
    const myEnrolledCourses = courses.filter(c => enrolledCourseIds.has(c.id));
    const today2 = new Date().toISOString().split('T')[0];
    const myExams = (exams || []).filter(e => e.published !== false && enrolledCourseIds.has(e.courseId) && (!me.studyCenterId || !e.studyCenterId || e.studyCenterId === me.studyCenterId) && e.date >= today2).sort((a, b) => a.date.localeCompare(b.date));
    
    const activeQuizzes = (quizzes || []).filter(q => enrolledCourseIds.has(q.courseId) && q.published);
    const mySubmissions = (submissions || []).filter(s => s.studentId === studentId);
    const submittedQuizIds = new Set(mySubmissions.map(s => s.quizId));
    const pendingQuizzes = activeQuizzes.filter(q => !submittedQuizIds.has(q.id)).slice(0, 5);
    const completedQuizzes = activeQuizzes.filter(q => submittedQuizIds.has(q.id)).slice(0, 3);

    const examHtml = myExams.length ? myExams.slice(0, 5).map(e => {
        const course = courses.find(c => c.id === e.courseId);
        return `<div class="event-item"><span><b>📄 ${e.title || course?.code || e.courseId}</b><br><span style="font-size:11px;color:var(--text-muted);">${course ? course.name : ''} — ${formatDate(e.date)} ${e.time || ''}</span></span></div>`;
    }).join('') : '<div style="color:var(--text-muted);padding:10px;">No upcoming exams</div>';

    const quizHtml = pendingQuizzes.length ? pendingQuizzes.map(q => {
        const course = courses.find(c => c.id === q.courseId);
        const sub = mySubmissions.find(s => s.quizId === q.id);
        return `<div class="event-item"><span><b>📝 ${q.title}</b><br><span style="font-size:11px;color:var(--text-muted);">${course ? course.name : q.courseId}</span></span><span class="badge badge-warning">Pending</span></div>`;
    }).join('') : '<div style="color:var(--text-muted);padding:10px;">No pending quizzes</div>';

    const completedQuizHtml = completedQuizzes.length ? completedQuizzes.map(q => {
        const sub = mySubmissions.find(s => s.quizId === q.id);
        return `<div class="event-item"><span><b>✅ ${q.title}</b></span><span class="badge badge-${sub?.status === 'pass' ? 'success' : 'danger'}">${sub?.score || 0}%</span></div>`;
    }).join('') : '';

    const enrolledHtml = myEnrolledCourses.length ? myEnrolledCourses.map(c => `<div class="event-item"><span><b>${c.code}</b> — ${c.name}</span><span class="badge badge-success">Enrolled</span></div>`).join('') : '<div style="color:var(--text-muted);padding:10px;">No enrolled courses</div>';

    // Active registrations summary
    const registrationsHtml = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin-bottom:12px;">
            <div class="stat-card" style="background:var(--bg-input);"><div class="stat-label">Program</div><div class="stat-value" style="font-size:14px;">${escapeHtml(me.program || '--')}</div></div>
            <div class="stat-card" style="background:var(--bg-input);"><div class="stat-label">Year</div><div class="stat-value" style="font-size:14px;">${me.year || 1}</div></div>
            <div class="stat-card" style="background:var(--bg-input);"><div class="stat-label">Enrolled Courses</div><div class="stat-value" style="font-size:14px;">${myEnrolledCourses.length}</div></div>
            <div class="stat-card" style="background:var(--bg-input);"><div class="stat-label">Pending Quizzes</div><div class="stat-value" style="font-size:14px;color:var(--warning);">${pendingQuizzes.length}</div></div>
            <div class="stat-card" style="background:var(--bg-input);"><div class="stat-label">Upcoming Exams</div><div class="stat-value" style="font-size:14px;color:var(--accent);">${myExams.length}</div></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
            <button class="btn btn-primary" onclick="showStudentEnrollModal('${studentId}')">➕ Enroll in Course</button>
            <button class="btn btn-outline" onclick="showExamRegistrationModal('${studentId}')">📝 Register for Exam</button>
            <button class="btn btn-outline" onclick="showQuizRegistrationModal('${studentId}')">📋 Join Quiz</button>
        </div>
    `;

    document.getElementById('dash-stats').innerHTML = registrationsHtml + document.getElementById('dash-stats').innerHTML;
    document.getElementById('dash-recent-students').innerHTML = `<div style="padding:12px;"><h4 style="color:var(--accent);margin-bottom:8px;">📚 Enrolled Courses</h4>${enrolledHtml}</div>`;
    document.getElementById('dash-today-schedule').innerHTML = `<div style="padding:12px;"><h4 style="color:var(--accent);margin-bottom:8px;">📝 Pending Quizzes</h4>${quizHtml}</div>`;
    document.getElementById('dash-tickets').innerHTML = `<div style="padding:12px;"><h4 style="color:var(--accent);margin-bottom:8px;">📋 Upcoming Exams</h4>${examHtml}</div>`;

    document.getElementById('dash-server-health') && (document.getElementById('dash-server-health').innerHTML = '');
    document.getElementById('dash-online') && (document.getElementById('dash-online').innerHTML = '');
    document.querySelector('#dash-finance')?.closest('.card')?.querySelector('h3') && (document.querySelector('#dash-finance').closest('.card').querySelector('h3').textContent = '💰 My Fees');
    document.querySelector('#dash-stock-alerts')?.closest('.card')?.querySelector('h3') && (document.querySelector('#dash-stock-alerts').closest('.card').querySelector('h3').textContent = '📊 Recent Grades');
    document.querySelector('#dash-tickets')?.closest('.card')?.querySelector('h3') && (document.querySelector('#dash-tickets').closest('.card').querySelector('h3').textContent = '📋 Upcoming Exams');
    } catch (err) {
        console.error('Student dashboard error:', err);
    }
}

async function onQuickProgramChange(sel) {
    const fee = await getProgramFee(sel.value);
    const feeInput = document.getElementById('quick-fee');
    if (feeInput && fee > 0) feeInput.value = fee;
}

async function showQuickEnroll() {
    const u = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    if (u.role === 'student') return showToast('Access denied.', { type: 'danger' });
    const centers = await dbGetAll('studyCenters');
    const programs = await getProgramsList();
    const content = `<div class="form-group"><label>Student Name</label><input type="text" id="quick-name" required></div><div class="form-group"><label>Study Center</label><select id="quick-center"><option value="">Main</option>${centers.map(c => `<option value="${c.id}">${c.name} (${c.code})</option>`).join('')}</select></div><div class="form-row"><div class="form-group"><label>Email</label><input type="email" id="quick-email"></div><div class="form-group"><label>Phone</label><input type="text" id="quick-phone"></div></div><div class="form-row"><div class="form-group"><label>Program</label><select id="quick-program" onchange="onQuickProgramChange(this)"><option value="">Select Program...</option>${programs.map(p => `<option value="${p}">${p}</option>`).join('')}</select></div><div class="form-group"><label>Year</label><input type="number" id="quick-year" value="1" min="1" max="5"></div></div><div class="form-group"><label>Fee Amount</label><input type="number" id="quick-fee" value="0"></div>`;
    showModal('Quick Student Enrollment', content, `<button class="btn btn-primary" onclick="quickEnrollStudent()">Enroll</button>`);
}

async function quickEnrollStudent() {
    const u = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    if (u.role === 'student') return showToast('Access denied.', { type: 'danger' });
    try {
        const name = sanitizeInput(document.getElementById('quick-name').value.trim());
        if (!name) return showToast('Name is required!');

        const email = document.getElementById('quick-email').value.trim();
        if (email && !validateEmail(email)) return showToast('Invalid email format!');
        if (email) {
            const existingEmail = (await dbGetAll('students')).find(s => s.email && s.email.toLowerCase() === email.toLowerCase());
            if (existingEmail) return showToast('Email already used by: ' + escapeHtml(existingEmail.name));
        }

        const phone = sanitizeInput(document.getElementById('quick-phone').value.trim());
        const id = generateId('STU');
        const centerId = document.getElementById('quick-center').value;
        const center = centerId ? await dbGet('studyCenters', centerId) : null;
        const branding = await dbGet('settings', 'branding');
        const initials = (branding && branding.initials) ? branding.initials : 'XX';
        const now = new Date();
        const month = now.getMonth() + 1;
        const year = String(now.getFullYear()).slice(-2);
        let admissionNumber;
        if (center) {
            const counterKey = `admseq-${centerId}-${year}`;
            let counter = await dbGet('counters', counterKey);
            if (!counter) counter = { key: counterKey, value: 0 };
            counter.value++;
            await dbPut('counters', counter);
            const seq = String(counter.value).padStart(3, '0');
            admissionNumber = `${initials}/${center.code}/${month}-${year}/${seq}`;
        } else {
            const seq = String((await getNextCounter('quickstu', 'STU-')).replace('STU-', '')).padStart(3, '0');
            admissionNumber = `${initials}/MAIN/${month}-${year}/${seq}`;
        }
        const program = sanitizeInput(document.getElementById('quick-program').value.trim());
        const yearVal = parseInt(document.getElementById('quick-year').value) || 1;
        const feeAmount = parseFloat(document.getElementById('quick-fee').value) || 0;
        const programFee = await getProgramFee(program);
        const finalFee = programFee > 0 ? programFee : feeAmount;
        const student = { id, admissionNumber, name, email, phone, studyCenterId: centerId, program, year: yearVal, feeAmount: finalFee, status: 'active', enrollDate: new Date().toISOString().split('T')[0], createdAt: new Date().toISOString() };
        await dbPut('students', student); closeModal(); renderDashboard(); renderStudents(); showToast(`Student enrolled! Adm#: ${admissionNumber}`); logAudit('created', 'student', { id, admissionNumber, name });
    } catch (err) {
        showToast('Enrollment failed: ' + err.message, { type: 'danger' });
        console.error('quickEnrollStudent error:', err);
    }
}

async function showStudentEnrollModal(studentId) {
    const student = await dbGet('students', studentId);
    if (!student) return showToast('Student not found');
    const courses = await dbGetAll('courses');
    const enrollments = await dbGetAll('enrollments');
    const enrolledIds = new Set(enrollments.filter(e => e.studentId === studentId).map(e => e.courseId));
    const available = courses.filter(c => c.published !== false && !enrolledIds.has(c.id));
    if (!available.length) return showToast('No available courses to enroll in');
    let html = `<div style="margin-bottom:8px;"><b>${escapeHtml(student.name)}</b> — ${escapeHtml(student.admissionNumber || student.id)}</div>`;
    html += available.map(c => `<label style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;cursor:pointer;">
        <input type="checkbox" value="${c.id}" class="enroll-course-chk">
        <div><b>${c.code}</b> — ${c.name}<br><span style="font-size:11px;color:var(--text-muted);">${c.description?.substring(0, 80) || ''}</span></div>
    </label>`).join('');
    showModal('Enroll in Courses', html, `<button class="btn btn-primary" onclick="saveStudentCourseEnrollment('${studentId}')">Enroll Selected</button>`);
}

async function saveStudentCourseEnrollment(studentId) {
    const checked = Array.from(document.querySelectorAll('.enroll-course-chk:checked')).map(cb => cb.value);
    if (!checked.length) return showToast('Select at least one course');
    for (const courseId of checked) {
        await dbPut('enrollments', { id: `ENR-${courseId}-${studentId}`, courseId, studentId, enrolledAt: new Date().toISOString() });
    }
    closeModal();
    renderStudentDashboard(JSON.parse(sessionStorage.getItem('currentUser')));
    showToast(`Enrolled in ${checked.length} course(s)`);
    logAudit('created', 'enrollment', { studentId, courses: checked });
}

async function showExamRegistrationModal(studentId) {
    const student = await dbGet('students', studentId);
    if (!student) return showToast('Student not found');
    const enrollments = await dbGetAll('enrollments');
    const enrolledCourseIds = new Set(enrollments.filter(e => e.studentId === studentId).map(e => e.courseId));
    const exams = (await dbGetAll('exams')).filter(e => e.published !== false && enrolledCourseIds.has(e.courseId) && (!student.studyCenterId || !e.studyCenterId || e.studyCenterId === student.studyCenterId));
    const examRegs = await dbGetAll('examRegistrations');
    const registeredIds = new Set(examRegs.filter(r => r.studentId === studentId).map(r => r.examId));
    const available = exams.filter(e => !registeredIds.has(e.id));
    if (!available.length) return showToast('No available exams to register for');
    let html = `<div style="margin-bottom:8px;"><b>${escapeHtml(student.name)}</b></div>`;
    const allCourses = await dbGetAll('courses');
    html += available.map(e => {
        const course = allCourses.find(c => c.id === e.courseId);
        return `<label style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;cursor:pointer;">
            <input type="checkbox" value="${e.id}" class="enroll-exam-chk">
            <div><b>${e.title || course?.code || e.courseId}</b><br><span style="font-size:11px;color:var(--text-muted);">${formatDate(e.date)} ${e.time || ''} — ${e.venue || 'TBA'}</span></div>
        </label>`;
    }).join('');
    showModal('Register for Exams', html, `<button class="btn btn-primary" onclick="saveStudentExamRegistration('${studentId}')">Register Selected</button>`);
}

async function saveStudentExamRegistration(studentId) {
    const checked = Array.from(document.querySelectorAll('.enroll-exam-chk:checked')).map(cb => cb.value);
    if (!checked.length) return showToast('Select at least one exam');
    for (const examId of checked) {
        const exam = await dbGet('exams', examId);
        await dbPut('examRegistrations', { id: `EXREG-${examId}-${studentId}`, examId, studentId, registeredAt: new Date().toISOString() });
        if (exam) {
            const existingSeat = (await dbGetAll('seating')).find(s => s.examId === examId && s.studentId === studentId);
            if (!existingSeat) {
                const allSeats = (await dbGetAll('seating')).filter(s => s.examId === examId);
                const maxSeat = allSeats.reduce((m, s) => Math.max(m, s.seatNumber || 0), 0);
                await dbPut('seating', { id: `SEAT-${examId}-${studentId}`, examId, studentId, seatNumber: maxSeat + 1, createdAt: new Date().toISOString() });
            }
        }
    }
    closeModal();
    renderStudentDashboard(JSON.parse(sessionStorage.getItem('currentUser')));
    showToast(`Registered for ${checked.length} exam(s)`);
    logAudit('created', 'examRegistration', { studentId, exams: checked });
}

async function showQuizRegistrationModal(studentId) {
    const student = await dbGet('students', studentId);
    if (!student) return showToast('Student not found');
    const enrollments = await dbGetAll('enrollments');
    const enrolledCourseIds = new Set(enrollments.filter(e => e.studentId === studentId).map(e => e.courseId));
    const quizzes = (await dbGetAll('quizzes')).filter(q => q.published && enrolledCourseIds.has(q.courseId));
    const submissions = await dbGetAll('submissions');
    const submittedIds = new Set(submissions.filter(s => s.studentId === studentId).map(s => s.quizId));
    const available = quizzes.filter(q => !submittedIds.has(q.id));
if (!available.length) return showToast('No available quizzes to join');
    let html = `<div style="margin-bottom:8px;"><b>${escapeHtml(student.name)}</b></div>`;
    const allCourses = await dbGetAll('courses');
    html += available.map(q => {
        const course = allCourses.find(c => c.id === q.courseId);
        return `<label style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;cursor:pointer;">
            <input type="checkbox" value="${q.id}" class="enroll-quiz-chk">
            <div><b>${q.title}</b><br><span style="font-size:11px;color:var(--text-muted);">${course ? course.name : q.courseId}</span></div>
        </label>`;
    }).join('');
    showModal('Join Quizzes', html, `<button class="btn btn-primary" onclick="saveStudentQuizRegistration('${studentId}')">Join Selected</button>`);
}

async function saveStudentQuizRegistration(studentId) {
    const checked = Array.from(document.querySelectorAll('.enroll-quiz-chk:checked')).map(cb => cb.value);
    if (!checked.length) return showToast('Select at least one quiz');
    closeModal();
    renderStudentDashboard(JSON.parse(sessionStorage.getItem('currentUser')));
    showToast(`Joined ${checked.length} quiz(es) — start from portal`);
    logAudit('created', 'quizRegistration', { studentId, quizzes: checked });
}

async function renderStudents() {
    // Fetch all required data in a single batch request
    const batchResult = await dbGetBatch(['students', 'payments', 'studyCenters']);
    const students = batchResult.students || [];
    const payments = batchResult.payments || [];
    const centers = batchResult.studyCenters || [];
    
    // Preprocess payments into a map for O(1) lookup
    const paymentsByStudentId = {};
    payments.forEach(payment => {
        if (!paymentsByStudentId[payment.studentId]) {
            paymentsByStudentId[payment.studentId] = 0;
        }
        paymentsByStudentId[payment.studentId] += payment.amount;
    });
    
    // Populate filter dropdowns
    const campusSel = document.getElementById('student-filter-campus');
    if (campusSel) {
        const savedCampus = campusSel.value;
        campusSel.innerHTML = '<option value="">All Centers</option>' + centers.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        if (savedCampus) campusSel.value = savedCampus;
    }
    const programSel = document.getElementById('student-filter-program');
    if (programSel) {
        const savedProgram = programSel.value;
        const programs = [...new Set(students.map(s => s.program).filter(Boolean))].sort();
        programSel.innerHTML = '<option value="">All Programs</option>' + programs.map(p => `<option value="${p}">${p}</option>`).join('');
        if (savedProgram) programSel.value = savedProgram;
    }
    
    const search = document.getElementById('student-search').value.toLowerCase();
    const statusFilter = document.getElementById('student-filter-status').value;
    const campusFilter = document.getElementById('student-filter-campus').value;
    const programFilter = document.getElementById('student-filter-program').value;

    let filtered = students;
    if (search) {
        filtered = filtered.filter(s => {
            const nameMatch = s.name && s.name.toLowerCase().includes(search);
            const admMatch = s.admissionNumber && s.admissionNumber.toLowerCase().includes(search);
            const emailMatch = s.email && s.email.toLowerCase().includes(search);
            return nameMatch || admMatch || emailMatch;
        });
    }
    if (statusFilter) filtered = filtered.filter(s => s.status === statusFilter);
    if (campusFilter) filtered = filtered.filter(s => s.studyCenterId === campusFilter);
    if (programFilter) filtered = filtered.filter(s => s.program === programFilter);
    filtered.sort((a, b) => new Date(b.enrollDate) - new Date(a.enrollDate));

document.getElementById('students-body').innerHTML = filtered.map(s => {
        const paid = paymentsByStudentId[s.id] || 0;
        const balance = getCachedStudentFee(s) - paid;
        const center = centers.find(c => c.id === s.studyCenterId);
        const statusClass = s.status === 'active' ? 'success' : s.status === 'inactive' ? 'secondary' : s.status === 'graduated' ? 'info' : s.status === 'suspended' ? 'warning' : 'danger';
        const phone = s.phone || '';
        return `<tr><td><b>${s.admissionNumber || s.id}</b></td><td><div><b>${s.name}</b></div><div style="font-size:11px;color:var(--text-muted);">${s.email || ''}</div></td><td>${center ? center.name : 'Main'}</td><td>${s.program || '--'}</td><td>Year ${calculateYearOfStudy(s)}</td><td><span class="badge badge-${statusClass}">${s.status || 'active'}</span></td><td style="color:${balance > 0 ? 'var(--warning)' : 'var(--success)'};font-weight:600;">${formatCurrency(balance)}</td><td><button class="btn btn-outline btn-sm" onclick="viewStudent('${s.id}')">View</button> <button class="btn btn-outline btn-sm" onclick="editStudent('${s.id}')">Edit</button> <button class="btn btn-primary btn-sm" onclick="adminEnrollStudentInCourse('${s.id}')" title="Enroll in Course">📚</button> <button class="btn btn-warning btn-sm" onclick="adminRegisterStudentForExam('${s.id}')" title="Register for Exam">📝</button> <button class="btn btn-info btn-sm" onclick="adminEnrollStudentInQuiz('${s.id}')" title="Join Quiz">📋</button> <button class="btn btn-secondary btn-sm" onclick="adminChangeStudentProgram('${s.id}')" title="Change Program">🎓</button> ${phone ? `<div class="wa-dropdown" style="display:inline-block;position:relative;"><button class="btn btn-success btn-sm" onclick="toggleWADropdown(event, '${s.id}')">📱</button><div id="wa-drop-${s.id}" class="wa-drop-menu" style="display:none;position:absolute;right:0;top:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:4px;min-width:180px;z-index:50;box-shadow:var(--shadow-lg);"><div class="wa-drop-item" onclick="quickWhatsAppStudent('${s.id}')">💬 Custom Message</div><div class="wa-drop-item" onclick="quickWhatsAppStudent('${s.id}','tpl-fee')">💰 Fee Reminder</div><div class="wa-drop-item" onclick="quickWhatsAppStudent('${s.id}','tpl-attendance')">⚠️ Attendance Alert</div><div class="wa-drop-item" onclick="quickWhatsAppStudent('${s.id}','tpl-welcome')">👋 Welcome</div></div></div>` : ''} <button class="btn btn-danger btn-sm" onclick="deleteStudent('${s.id}')" title="Delete">🗑</button></td></tr>`;
    }).join('') || '<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-muted);">No students found. Click "+ Add Student" to enroll.</td></tr>';
}

async function showStudentForm(student = null) {
    const isEdit = !!student;
    const centers = await dbGetAll('studyCenters');
    const branding = await dbGet('settings', 'branding');
    const initials = (branding && branding.initials) ? branding.initials : 'XX';
    const now = new Date();
    const defaultMonth = now.getMonth() + 1;
    const defaultYear = String(now.getFullYear()).slice(-2);
    const programs = await getProgramsList();

    const content = `<input type="hidden" id="student-edit-id" value="${student ? student.id : ''}"><div class="form-group"><label>Full Name *</label><input type="text" id="student-name" value="${student ? student.name : ''}" required></div><div class="form-row"><div class="form-group"><label>Email</label><input type="email" id="student-email" value="${student ? student.email || '' : ''}"></div><div class="form-group"><label>Phone</label><input type="text" id="student-phone" value="${student ? student.phone || '' : ''}"></div></div><div class="form-row"><div class="form-group"><label>Date of Birth</label><input type="date" id="student-dob" value="${student ? student.dob || '' : ''}"></div><div class="form-group"><label>Gender</label><select id="student-gender"><option value="">Select</option><option value="male" ${student && student.gender === 'male' ? 'selected' : ''}>Male</option><option value="female" ${student && student.gender === 'female' ? 'selected' : ''}>Female</option></select></div></div><div class="form-group"><label>Study Center *</label><select id="student-center" onchange="onStudentCenterChange()"><option value="">Select Study Center...</option>${centers.map(c => `<option value="${c.id}" ${student && student.studyCenterId === c.id ? 'selected' : ''}>${c.name} (${c.code})</option>`).join('')}</select></div><div style="padding:12px;background:var(--bg-input);border-radius:var(--radius);margin-bottom:12px;"><div style="font-size:12px;font-weight:600;color:var(--accent);margin-bottom:8px;">Admission Number</div><div class="form-row"><div class="form-group"><label>Generation Mode</label><select id="adm-mode" onchange="toggleAdmissionMode()"><option value="auto" ${student && student.admMode === 'manual' ? '' : 'selected'}>Auto-Generate</option><option value="manual" ${student && student.admMode === 'manual' ? 'selected' : ''}>Manual Entry</option></select></div><div class="form-group"><label>Registration Date</label><input type="date" id="adm-date" value="${student ? student.enrollDate || new Date().toISOString().split('T')[0] : new Date().toISOString().split('T')[0]}" onchange="updateAdmissionPreview()"></div></div><div id="adm-auto-section"><div style="font-size:13px;margin-top:4px;">Format: <b>${initials}</b> / <span id="adm-preview-center">XXXX</span> / <span id="adm-preview-month">${defaultMonth}</span> - <span id="adm-preview-year">${defaultYear}</span> / <span id="adm-preview-seq">001</span></div><div style="font-size:18px;font-weight:700;color:var(--accent);margin-top:8px;" id="adm-full-preview">${initials}/XXXX/${defaultMonth}-${defaultYear}/001</div></div><div id="adm-manual-section" style="display:none;"><div class="form-group"><label>Manual Admission Number</label><input type="text" id="adm-manual-input" value="${student ? student.admissionNumber || '' : ''}" placeholder="Enter custom admission number"></div></div></div><div class="form-row"><div class="form-group"><label>Program</label><select id="student-program" onchange="onStudentProgramChange(this)"><option value="">Select Program...</option>${programs.map(p => `<option value="${p}" ${student && student.program === p ? 'selected' : ''}>${p}</option>`).join('')}${student && student.program && !programs.includes(student.program) ? `<option value="${student.program}" selected>${student.program}</option>` : ''}</select></div><div class="form-row"><div class="form-group"><label>Year</label><input type="number" id="student-year" value="${student ? student.year || 1 : 1}" min="1" max="3"></div><div class="form-group"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="student-year-auto" ${student && student.yearAuto !== false ? 'checked' : ''}> Auto-calculate from registration date (max Year 3)</label></div></div><div class="form-row"><div class="form-group"><label>Fee Amount</label><input type="number" id="student-fee" value="${student ? getCachedStudentFee(student) : 0}"></div><div class="form-group"><label>Installment Plan</label><select id="student-installment"><option value="">None</option><option value="2" ${student && student.installments == 2 ? 'selected' : ''}>2 Payments</option><option value="3" ${student && student.installments == 3 ? 'selected' : ''}>3 Payments</option><option value="4" ${student && student.installments == 4 ? 'selected' : ''}>4 Payments</option></select></div></div><div class="form-row"><div class="form-group"><label>Status</label><select id="student-status"><option value="active" ${student && student.status === 'active' ? 'selected' : ''}>Active</option><option value="inactive" ${student && student.status === 'inactive' ? 'selected' : ''}>Inactive</option><option value="graduated" ${student && student.status === 'graduated' ? 'selected' : ''}>Graduated</option><option value="suspended" ${student && student.status === 'suspended' ? 'selected' : ''}>Suspended</option><option value="dropped" ${student && student.status === 'dropped' ? 'selected' : ''}>Dropped</option></select></div></div><div class="form-group"><label>Address</label><textarea id="student-address">${student ? student.address || '' : ''}</textarea></div><div class="form-group"><label>Emergency Contact</label><input type="text" id="student-emergency" value="${student ? student.emergency || '' : ''}"></div><div class="form-group"><label>Notes</label><textarea id="student-notes">${student ? student.notes || '' : ''}</textarea></div>`;
    showModal(isEdit ? 'Edit Student' : 'Add New Student', content, `<button class="btn btn-primary" onclick="saveStudent()">${isEdit ? 'Update' : 'Enroll'}</button>`);
    onStudentCenterChange();
    updateAdmissionPreview();
    setupYearAutoToggle(student);
}

function setupYearAutoToggle(student) {
    const autoCheckbox = document.getElementById('student-year-auto');
    const yearInput = document.getElementById('student-year');
    if (!autoCheckbox || !yearInput) return;
    const updateYearInput = () => {
        yearInput.disabled = autoCheckbox.checked;
        yearInput.style.opacity = autoCheckbox.checked ? '0.5' : '1';
    };
    autoCheckbox.addEventListener('change', updateYearInput);
    updateYearInput();
}
async function onStudentCenterChange() {
    const centerId = document.getElementById('student-center').value;
    const center = centerId ? await dbGet('studyCenters', centerId) : null;
    const codeEl = document.getElementById('adm-preview-center');
    if (codeEl) codeEl.textContent = center ? center.code : 'XXXX';
    updateAdmissionPreview();
}

function toggleAdmissionMode() {
    const mode = document.getElementById('adm-mode').value;
    document.getElementById('adm-auto-section').style.display = mode === 'auto' ? 'block' : 'none';
    document.getElementById('adm-manual-section').style.display = mode === 'manual' ? 'block' : 'none';
}

async function updateAdmissionPreview() {
    const branding = await dbGet('settings', 'branding');
    const initials = (branding && branding.initials) ? branding.initials : 'XX';
    const centerId = document.getElementById('student-center') ? document.getElementById('student-center').value : '';
    const center = centerId ? await dbGet('studyCenters', centerId) : null;
    const code = center ? center.code : 'XXXX';

    const dateInput = document.getElementById('adm-date');
    const date = dateInput ? new Date(dateInput.value) : new Date();
    const month = date.getMonth() + 1;
    const year = String(date.getFullYear()).slice(-2);

    const monthEl = document.getElementById('adm-preview-month');
    const yearEl = document.getElementById('adm-preview-year');
    if (monthEl) monthEl.textContent = month;
    if (yearEl) yearEl.textContent = year;

    let seq = '001';
    if (centerId && document.getElementById('adm-mode').value === 'auto') {
        const counterKey = `admseq-${centerId}-${year}`;
        const counter = await dbGet('counters', counterKey);
        const nextNum = counter ? counter.value + 1 : 1;
        seq = String(nextNum).padStart(3, '0');
    }
    const seqEl = document.getElementById('adm-preview-seq');
    if (seqEl) seqEl.textContent = seq;

    const fullEl = document.getElementById('adm-full-preview');
    if (fullEl) fullEl.textContent = `${initials}/${code}/${month}-${year}/${seq}`;
}

async function onStudentProgramChange(sel) {
    const fee = await getProgramFee(sel.value);
    const feeInput = document.getElementById('student-fee');
    if (feeInput && fee > 0) feeInput.value = fee;
}

async function saveStudent() {
    const name = document.getElementById('student-name').value.trim();
    if (!name) return showToast('Name is required!');
    const editId = document.getElementById('student-edit-id').value;
    const id = editId || generateId('STU');

    const email = document.getElementById('student-email').value.trim();
    if (email) {
        const existingEmail = (await dbGetAll('students')).find(s => s.email && s.email.toLowerCase() === email.toLowerCase() && s.id !== editId);
        if (existingEmail) return showToast('Email already used by: ' + existingEmail.name);
    }

    const mode = document.getElementById('adm-mode').value;
    let admissionNumber = '';
    if (mode === 'manual') {
        admissionNumber = document.getElementById('adm-manual-input').value.trim();
        if (!admissionNumber) return showToast('Manual admission number required!');
        if (!editId) {
            const existingAdm = (await dbGetAll('students')).find(s => s.admissionNumber === admissionNumber);
            if (existingAdm) return showToast('Admission number already used by: ' + existingAdm.name);
        }
    } else {
        const centerId = document.getElementById('student-center').value;
        if (!centerId) return showToast('Select a study center!');
        if (editId) {
            const existing = await dbGet('students', editId);
            if (existing && existing.admissionNumber && existing.studyCenterId === centerId) {
                admissionNumber = existing.admissionNumber;
            }
        }
        if (!admissionNumber) {
            const center = await dbGet('studyCenters', centerId);
            const branding = await dbGet('settings', 'branding');
            const initials = (branding && branding.initials) ? branding.initials : 'XX';
            const dateInput = document.getElementById('adm-date');
            const date = dateInput ? new Date(dateInput.value) : new Date();
            const month = date.getMonth() + 1;
            const year = String(date.getFullYear()).slice(-2);
            const counterKey = `admseq-${centerId}-${year}`;
            let counter = await dbGet('counters', counterKey);
            if (!counter) counter = { key: counterKey, value: 0 };
            counter.value++;
            await dbPut('counters', counter);
            const seq = String(counter.value).padStart(3, '0');
            admissionNumber = `${initials}/${center.code}/${month}-${year}/${seq}`;
        }
    }

    const installmentPlan = document.getElementById('student-installment').value;
    const program = document.getElementById('student-program').value;
    let feeAmount = parseFloat(document.getElementById('student-fee').value) || 0;
    if (feeAmount <= 0 && program) feeAmount = await getProgramFee(program);
    const enrollDate = document.getElementById('adm-date').value || new Date().toISOString().split('T')[0];

    const student = {
        id,
        admissionNumber,
        admMode: mode,
        name,
        email,
        phone: document.getElementById('student-phone').value.trim(),
        dob: document.getElementById('student-dob').value,
        gender: document.getElementById('student-gender').value,
        studyCenterId: document.getElementById('student-center').value,
        program: document.getElementById('student-program').value.trim(),
        year: calculateYearOfStudy({ 
            yearAuto: document.getElementById('student-year-auto')?.checked !== false,
            year: parseInt(document.getElementById('student-year').value) || 1,
            registrationRequestedAt: student?.registrationRequestedAt,
            enrollDate: student?.enrollDate
        }),
        yearAuto: document.getElementById('student-year-auto')?.checked !== false,
        feeAmount,
        status: document.getElementById('student-status').value,
        installments: installmentPlan,
        address: document.getElementById('student-address').value.trim(),
        emergency: document.getElementById('student-emergency').value.trim(),
        notes: document.getElementById('student-notes').value.trim(),
        enrollDate,
        updatedAt: new Date().toISOString()
    };
    if (!editId) student.createdAt = new Date().toISOString();
    if (!editId) student.yearAuto = true;

    await dbPut('students', student);
    const allExisting = await dbGetAll('users');
    const hasUser = allExisting.some(u => u.studentId === student.id || u.username === student.phone || u.username === student.id || u.name === student.name);
    if (!hasUser && student.status === 'active' && student.phone && student.admissionNumber) {
        const pwHash = await hashPassword(student.admissionNumber);
        await dbPut('users', {
            username: student.phone,
            password: pwHash,
            name: student.name,
            role: 'student',
            status: 'active',
            studentId: student.id,
            createdAt: new Date().toISOString()
        });
        showToast('Login account created — username: ' + student.phone + ', password: ' + student.admissionNumber, { type: 'success', duration: 5000 });
    }
    if (installmentPlan && feeAmount > 0 && !editId) await createInstallmentPlan(id, feeAmount, parseInt(installmentPlan));
    invalidatePortalCache();
    invalidateProgressCache();
    closeModal();
    renderStudents();
    renderDashboard();
    showToast(editId ? 'Student updated!' : `Student enrolled! Adm#: ${admissionNumber}`);
    logAudit(editId ? 'updated' : 'created', 'student', { id, admissionNumber, name });
}

async function editStudent(id) {
    const student = await dbGet('students', id);
    if (!student) return;
    showStudentForm(student);
}

async function viewStudent(id) {
    const student = await dbGet('students', id);
    if (!student) return;
    const payments = (await dbGetAll('payments')).filter(p => p.studentId === id);
    const grades = (await dbGetAll('grades')).filter(g => g.studentId === id);
    const courses = await dbGetAll('courses');
    const center = student.studyCenterId ? await dbGet('studyCenters', student.studyCenterId) : null;
    const paid = payments.reduce((s, p) => s + p.amount, 0);
    const studentFee = getCachedStudentFee(student);
    const balance = studentFee - paid;

    let html = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;"><div><b>Admission #:</b> <span style="color:var(--accent);font-weight:700;">${student.admissionNumber || '--'}</span></div><div><b>Status:</b> <span class="badge badge-${student.status === 'active' ? 'success' : student.status === 'inactive' ? 'secondary' : 'warning'}">${student.status}</span></div><div><b>Name:</b> ${student.name}</div><div><b>Program:</b> ${student.program || '--'}</div><div><b>Study Center:</b> ${center ? center.name : 'Main'}</div><div><b>Phone:</b> ${student.phone || '--'}</div><div><b>Email:</b> ${student.email || '--'}</div><div><b>Year:</b> ${student.year || 1}</div><div><b>Fee Amount:</b> ${formatCurrency(studentFee)}</div><div><b>Balance:</b> <span style="color:${balance > 0 ? 'var(--warning)' : 'var(--success)'};font-weight:700;">${formatCurrency(balance)}</span></div></div>`;

    if (student.phone) html += `<div style="margin-bottom:12px;padding:10px;background:var(--bg-input);border-radius:6px;"><div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:6px;">📱 Quick WhatsApp</div><div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="btn btn-success btn-sm" onclick="quickWhatsAppStudent('${student.id}')">💬 Custom</button><button class="btn btn-outline btn-sm" onclick="quickWhatsAppStudent('${student.id}','tpl-fee')">💰 Fee (${formatCurrency(balance)})</button><button class="btn btn-outline btn-sm" onclick="quickWhatsAppStudent('${student.id}','tpl-welcome')">👋 Welcome</button><button class="btn btn-outline btn-sm" onclick="quickWhatsAppStudent('${student.id}','tpl-attendance')">⚠️ Attendance</button></div></div>`;

    html += `<h4 style="color:var(--accent);margin-bottom:8px;">Payment History (${payments.length})</h4><table class="data-table"><thead><tr><th>Date</th><th>Receipt</th><th>Amount</th><th>Method</th></tr></thead><tbody>${payments.map(p => `<tr><td>${formatDate(p.date)}</td><td>${p.receiptNo}</td><td>${formatCurrency(p.amount)}</td><td>${p.method}</td></tr>`).join('') || '<tr><td colspan="4" style="text-align:center;">No payments</td></tr>'}</tbody></table>`;

    if (grades.length) { html += `<h4 style="color:var(--accent);margin:12px 0 8px;">Grades</h4><table class="data-table"><thead><tr><th>Course</th><th>Score</th><th>Grade</th></tr></thead><tbody>${grades.map(g => { const c = courses.find(c => c.id === g.courseId); return `<tr><td>${c ? c.name : g.courseId}</td><td>${g.score}</td><td>${getGrade(g.score).grade}</td></tr>`; }).join('')}</tbody></table>`; }

    showModal('Student: ' + student.name, html, `<button class="btn btn-outline" onclick="editStudent('${id}');closeModal();">Edit</button>`);
}

async function showProgramAssignment() {
    const programs = await getProgramsList();
    const students = await dbGetAll('students');
    const now = new Date().toISOString().split('T')[0];
    if (!programs.length) return showToast('No programs defined! Go to Settings → Academic Settings to add programs.', { type: 'warning', duration: 6000 });

    const studentRows = students.filter(s => s.status === 'active' || !s.program).map(s => {
        const checked = !s.program ? 'checked' : '';
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
            <input type="checkbox" class="prog-student-cb" value="${s.id}" ${checked}>
            <span style="flex:1;"><b>${escapeHtml(s.name)}</b> <span style="font-size:11px;color:var(--text-muted);">${escapeHtml(s.admissionNumber || s.id)}${s.program ? ' — ' + escapeHtml(s.program) : ''}</span></span>
            <span style="font-size:11px;color:var(--text-muted);">Year ${s.year || 1}</span>
        </div>`;
    }).join('');

    const content = `
        <div class="form-row">
            <div class="form-group"><label>Program *</label><select id="prog-assign-program">${programs.map(p => `<option value="${p}">${p}</option>`).join('')}</select></div>
            <div class="form-group"><label>Year</label><input type="number" id="prog-assign-year" value="1" min="1" max="5"></div>
        </div>
        <div class="form-group">
            <label>Study Center</label>
            <select id="prog-assign-center"><option value="">All Centers</option>${(await dbGetAll('studyCenters')).map(c => `<option value="${c.id}">${c.name} (${c.code})</option>`).join('')}</select>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin:8px 0;">
            <label style="font-weight:600;">Students (${students.length})</label>
            <div style="display:flex;gap:8px;align-items:center;">
                <input type="text" id="prog-search" placeholder="Filter..." style="padding:4px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;background:var(--bg-input);color:var(--text);" oninput="filterProgramStudents()">
                <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" id="prog-select-all" onchange="toggleAllProgramStudents()"> Select All</label>
            </div>
        </div>
        <div id="prog-student-list" style="max-height:350px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:4px 8px;">${studentRows || '<div style="text-align:center;padding:20px;color:var(--text-muted);">No students found</div>'}</div>
    `;
    showModal('Enroll Students into Program', content, `<button class="btn btn-primary" onclick="assignStudentPrograms()">Assign Program</button>`);
}

function filterProgramStudents() {
    const q = document.getElementById('prog-search').value.toLowerCase();
    document.querySelectorAll('#prog-student-list > div').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(q) ? 'flex' : 'none';
    });
}

function toggleAllProgramStudents() {
    const checked = document.getElementById('prog-select-all').checked;
    document.querySelectorAll('.prog-student-cb').forEach(cb => cb.checked = checked);
}

async function assignStudentPrograms() {
    const program = document.getElementById('prog-assign-program').value;
    if (!program) return showToast('Select a program!');
    const year = parseInt(document.getElementById('prog-assign-year').value) || 1;
    const checked = document.querySelectorAll('.prog-student-cb:checked');
    if (!checked.length) return showToast('No students selected!');
    if (!await showConfirm('Confirm', `Assign ${checked.length} student(s) to "${program}" (Year ${year})?`)) return;

    try {
        let count = 0;
        for (const cb of checked) {
            const student = await dbGet('students', cb.value);
            if (student) {
                student.program = program;
                student.year = year;
                if (!student.status) student.status = 'active';
                await dbPut('students', student);
                count++;
            }
        }
        closeModal();
        renderStudents();
        renderDashboard();
        showToast(`${count} student(s) enrolled in "${program}"!`, { type: 'success' });
        logAudit('bulk-enroll', 'students', { program, year, count });
    } catch (err) {
        showToast('Assignment failed: ' + err.message, { type: 'danger' });
        console.error('assignStudentPrograms error:', err);
    }
}

async function deleteStudent(id) {
    if (!await showConfirm('Confirm', 'Delete student ' + id + '?')) return;
    const users = await dbGetAll('users');
    const user = users.find(u => u.studentId === id);
    if (user) await dbDelete('users', user.id);
    await dbDelete('students', id); renderStudents(); renderDashboard(); showToast('Student deleted'); logAudit('deleted', 'student', { id, userDeleted: !!user });
}

async function createInstallmentPlan(studentId, totalFee, numPayments) {
    const startDate = new Date();
    const installmentAmount = totalFee / numPayments;
    for (let i = 0; i < numPayments; i++) {
        const dueDate = new Date(startDate);
        dueDate.setMonth(dueDate.getMonth() + i);
        const installment = { id: 'INS-' + studentId + '-' + (i + 1), studentId, amount: installmentAmount, paidAmount: 0, dueDate: dueDate.toISOString().split('T')[0], status: i === 0 ? 'pending' : 'scheduled', installmentNumber: i + 1, totalInstallments: numPayments, createdAt: new Date().toISOString() };
        await dbPut('installments', installment);
    }
}

function toggleWADropdown(event, studentId) {
    event.stopPropagation();
    const menu = document.getElementById('wa-drop-' + studentId);
    document.querySelectorAll('.wa-drop-menu').forEach(m => { if (m !== menu) m.style.display = 'none'; });
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

document.addEventListener('click', () => { document.querySelectorAll('.wa-drop-menu').forEach(m => m.style.display = 'none'); });

document.getElementById('student-search').addEventListener('input', debounce(renderStudents, 300));
document.getElementById('student-filter-status').addEventListener('change', renderStudents);
document.getElementById('student-filter-campus').addEventListener('change', renderStudents);
document.getElementById('student-filter-program').addEventListener('change', renderStudents);

async function adminEnrollStudentInCourse(studentId) {
    const student = await dbGet('students', studentId);
    if (!student) return showToast('Student not found');
    const courses = await dbGetAll('courses');
    const enrollments = await dbGetAll('enrollments');
    const enrolledIds = new Set(enrollments.filter(e => e.studentId === studentId).map(e => e.courseId));
    const available = courses.filter(c => c.published !== false && !enrolledIds.has(c.id));
    const enrolled = courses.filter(c => enrolledIds.has(c.id));
    let html = `<div style="margin-bottom:8px;"><b>${escapeHtml(student.name)}</b> — ${escapeHtml(student.admissionNumber || student.id)}</div>`;
    if (enrolled.length) {
        html += `<div style="margin-bottom:12px;"><h4 style="color:var(--success);margin-bottom:6px;">Currently Enrolled (${enrolled.length})</h4>`;
        html += enrolled.map(c => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:var(--bg-input);border-radius:4px;margin-bottom:4px;"><span><b>${c.code}</b> — ${c.name}</span><button class="btn btn-danger btn-xs" onclick="adminDeregisterStudentFromCourse('${studentId}','${c.id}')">✖ Remove</button></div>`).join('');
        html += `</div>`;
    }
    if (!available.length) {
        html += '<div style="color:var(--text-muted);padding:10px;">No available courses to enroll in</div>';
    } else {
        html += `<div style="margin-bottom:6px;"><label><input type="checkbox" onchange="document.querySelectorAll('.admin-enroll-chk:not(:disabled)').forEach(c=>c.checked=this.checked)"> Select All</label></div>`;
        html += available.map(c => `<label style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;cursor:pointer;">
            <input type="checkbox" value="${c.id}" class="admin-enroll-chk">
            <div><b>${c.code}</b> — ${c.name}<br><span style="font-size:11px;color:var(--text-muted);">${c.description?.substring(0, 80) || ''}</span></div>
        </label>`).join('');
    }
    showModal('Enroll Student in Course', html, available.length ? `<button class="btn btn-primary" onclick="adminSaveCourseEnrollment('${studentId}')">Enroll Selected</button>` : '');
}

async function adminSaveCourseEnrollment(studentId) {
    const checked = Array.from(document.querySelectorAll('.admin-enroll-chk:checked')).map(cb => cb.value);
    if (!checked.length) return showToast('Select at least one course');
    for (const courseId of checked) {
        await dbPut('enrollments', { id: `ENR-${courseId}-${studentId}`, courseId, studentId, enrolledAt: new Date().toISOString() });
    }
    closeModal();
    renderStudents();
    showToast(`Enrolled in ${checked.length} course(s)`);
    logAudit('created', 'enrollment', { studentId, courses: checked });
}

async function adminDeregisterStudentFromCourse(studentId, courseId) {
    if (!await showConfirm('Remove Enrollment', 'Remove this student from the course?')) return;
    const enrollments = await dbGetAll('enrollments');
    const enrollment = enrollments.find(e => e.studentId === studentId && e.courseId === courseId);
    if (enrollment) await dbDelete('enrollments', enrollment.id);
    closeModal();
    renderStudents();
    showToast('Removed from course');
    logAudit('deleted', 'enrollment', { studentId, courseId });
}

async function adminRegisterStudentForExam(studentId) {
    const student = await dbGet('students', studentId);
    if (!student) return showToast('Student not found');
    const enrollments = await dbGetAll('enrollments');
    const enrolledCourseIds = new Set(enrollments.filter(e => e.studentId === studentId).map(e => e.courseId));
    const exams = (await dbGetAll('exams')).filter(e => e.published !== false && enrolledCourseIds.has(e.courseId) && (!student.studyCenterId || !e.studyCenterId || e.studyCenterId === student.studyCenterId));
    const examRegs = await dbGetAll('examRegistrations');
    const registeredIds = new Set(examRegs.filter(r => r.studentId === studentId).map(r => r.examId));
    const available = exams.filter(e => !registeredIds.has(e.id));
    const registered = exams.filter(e => registeredIds.has(e.id));
    const courses = await dbGetAll('courses');
    let html = `<div style="margin-bottom:8px;"><b>${escapeHtml(student.name)}</b></div>`;
    if (registered.length) {
        html += `<div style="margin-bottom:12px;"><h4 style="color:var(--success);margin-bottom:6px;">Currently Registered (${registered.length})</h4>`;
        html += registered.map(e => {
            const course = courses.find(c => c.id === e.courseId);
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:var(--bg-input);border-radius:4px;margin-bottom:4px;"><span><b>${e.title || course?.code || e.courseId}</b> — ${formatDate(e.date)}</span><button class="btn btn-danger btn-xs" onclick="adminDeregisterStudentFromExam('${studentId}','${e.id}')">✖ Remove</button></div>`;
        }).join('');
        html += `</div>`;
    }
    if (!available.length) {
        html += '<div style="color:var(--text-muted);padding:10px;">No available exams to register for</div>';
    } else {
        html += available.map(e => {
            const course = courses.find(c => c.id === e.courseId);
            return `<label style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;cursor:pointer;">
                <input type="checkbox" value="${e.id}" class="admin-exam-chk">
                <div><b>${e.title || course?.code || e.courseId}</b><br><span style="font-size:11px;color:var(--text-muted);">${formatDate(e.date)} ${e.time || ''} — ${e.venue || 'TBA'}</span></div>
            </label>`;
        }).join('');
    }
    showModal('Register for Exams', html, available.length ? `<button class="btn btn-primary" onclick="adminSaveExamRegistration('${studentId}')">Register Selected</button>` : '');
}

async function adminSaveExamRegistration(studentId) {
    const checked = Array.from(document.querySelectorAll('.admin-exam-chk:checked')).map(cb => cb.value);
    if (!checked.length) return showToast('Select at least one exam');
    for (const examId of checked) {
        await dbPut('examRegistrations', { id: `EXREG-${examId}-${studentId}`, examId, studentId, registeredAt: new Date().toISOString() });
        const existingSeat = (await dbGetAll('seating')).find(s => s.examId === examId && s.studentId === studentId);
        if (!existingSeat) {
            const allSeats = (await dbGetAll('seating')).filter(s => s.examId === examId);
            const maxSeat = allSeats.reduce((m, s) => Math.max(m, s.seatNumber || 0), 0);
            await dbPut('seating', { id: `SEAT-${examId}-${studentId}`, examId, studentId, seatNumber: maxSeat + 1, createdAt: new Date().toISOString() });
        }
    }
    closeModal();
    renderStudents();
    showToast(`Registered for ${checked.length} exam(s)`);
    logAudit('created', 'examRegistration', { studentId, exams: checked });
}

async function adminDeregisterStudentFromExam(studentId, examId) {
    if (!await showConfirm('Remove Exam Registration', 'Remove this student from the exam?')) return;
    const reg = (await dbGetAll('examRegistrations')).find(r => r.studentId === studentId && r.examId === examId);
    if (reg) await dbDelete('examRegistrations', reg.id);
    const seat = (await dbGetAll('seating')).find(s => s.examId === examId && s.studentId === studentId);
    if (seat) await dbDelete('seating', seat.id);
    closeModal();
    renderStudents();
    showToast('Removed from exam');
    logAudit('deleted', 'examRegistration', { studentId, examId });
}

async function adminEnrollStudentInQuiz(studentId) {
    const student = await dbGet('students', studentId);
    if (!student) return showToast('Student not found');
    const enrollments = await dbGetAll('enrollments');
    const enrolledCourseIds = new Set(enrollments.filter(e => e.studentId === studentId).map(e => e.courseId));
    const quizzes = (await dbGetAll('quizzes')).filter(q => q.published && enrolledCourseIds.has(q.courseId));
    const submissions = await dbGetAll('submissions');
    const submittedIds = new Set(submissions.filter(s => s.studentId === studentId).map(s => s.quizId));
    const available = quizzes.filter(q => !submittedIds.has(q.id));
    const completed = quizzes.filter(q => submittedIds.has(q.id));
    const courses = await dbGetAll('courses');
    let html = `<div style="margin-bottom:8px;"><b>${escapeHtml(student.name)}</b></div>`;
    if (completed.length) {
        html += `<div style="margin-bottom:12px;"><h4 style="color:var(--text-muted);margin-bottom:6px;">Already Submitted (${completed.length})</h4>`;
        html += completed.map(q => {
            const course = courses.find(c => c.id === q.courseId);
            return `<div style="padding:6px 8px;background:var(--bg-input);border-radius:4px;margin-bottom:4px;font-size:12px;"><b>${q.title}</b> — ${course ? course.name : ''}</div>`;
        }).join('');
        html += `</div>`;
    }
    if (!available.length) {
        html += '<div style="color:var(--text-muted);padding:10px;">No available quizzes to join</div>';
    } else {
        html += available.map(q => {
            const course = courses.find(c => c.id === q.courseId);
            return `<label style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;cursor:pointer;">
                <input type="checkbox" value="${q.id}" class="admin-quiz-chk">
                <div><b>${q.title}</b><br><span style="font-size:11px;color:var(--text-muted);">${course ? course.name : q.courseId}</span></div>
            </label>`;
        }).join('');
    }
    showModal('Join Quizzes', html, available.length ? `<button class="btn btn-primary" onclick="adminSaveQuizEnrollment('${studentId}')">Join Selected</button>` : '');
}

async function adminSaveQuizEnrollment(studentId) {
    const checked = Array.from(document.querySelectorAll('.admin-quiz-chk:checked')).map(cb => cb.value);
    if (!checked.length) return showToast('Select at least one quiz');
    closeModal();
    renderStudents();
    showToast(`Joined ${checked.length} quiz(es) — student can start from portal`);
    logAudit('created', 'quizEnrollment', { studentId, quizzes: checked });
}

async function adminChangeStudentProgram(studentId) {
    const student = await dbGet('students', studentId);
    if (!student) return showToast('Student not found');
    const programs = await getProgramsList();
    const content = `<div class="form-group"><label>Student</label><div><b>${escapeHtml(student.name)}</b> — ${escapeHtml(student.admissionNumber || student.id)}</div></div><div class="form-group"><label>Current Program</label><div>${escapeHtml(student.program || '--')}</div></div><div class="form-group"><label>New Program *</label><select id="admin-new-program"><option value="">Select Program...</option>${programs.map(p => `<option value="${p}" ${student.program === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div><div class="form-group"><label>Year</label><input type="number" id="admin-new-year" value="${student.year || 1}" min="1" max="5"></div>`;
    showModal('Change Program', content, `<button class="btn btn-primary" onclick="adminSaveProgramChange('${studentId}')">Update Program</button>`);
}

async function adminSaveProgramChange(studentId) {
    const newProgram = document.getElementById('admin-new-program').value;
    const newYear = parseInt(document.getElementById('admin-new-year').value) || 1;
    if (!newProgram) return showToast('Select a program');
    const student = await dbGet('students', studentId);
    if (!student) return;
    const oldProgram = student.program;
    student.program = newProgram;
    student.year = newYear;
    student.feeAmount = await getProgramFee(newProgram) || student.feeAmount;
    await dbPut('students', student);
    closeModal();
    renderStudents();
    showToast(`Program changed: ${oldProgram} → ${newProgram}`);
    logAudit('updated', 'student-program', { studentId, oldProgram, newProgram, newYear });
}

async function renderExams() {
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const isStudentUser = currentUser && currentUser.role === 'student';

    const exams = await dbGetAll('exams');
    const courses = await dbGetAll('courses');
    const staff = await dbGetAll('staff');
    const enrollments = await dbGetAll('enrollments');
    const centers = await dbGetAll('studyCenters');
    const registrations = await dbGetAll('examRegistrations');
    const semester = document.getElementById('exam-semester').value;

    if (isStudentUser) {
        const addBtn = document.querySelector('#screen-exams .btn-primary');
        if (addBtn) addBtn.style.display = 'none';
        const scheduleBtn = document.querySelector('#screen-exams .btn-outline');
        if (scheduleBtn) scheduleBtn.style.display = 'none';
        const moderationBtn = document.querySelector('#screen-exams .btn-success');
        if (moderationBtn) moderationBtn.style.display = 'none';

        const students = await dbGetAll('students');
        const studentId = currentUser.studentId || currentUser.username;
        const me = students.find(s => s.id === studentId);
        const myCenterId = me?.studyCenterId || '';
        const enrolledCourseIds = new Set(enrollments.filter(e => e.studentId === studentId).map(e => e.courseId));
        const sorted = exams.filter(e => e.published !== false && e.semester == semester && enrolledCourseIds.has(e.courseId) && (!myCenterId || !e.studyCenterId || e.studyCenterId === myCenterId)).sort((a, b) => a.date.localeCompare(b.date));
        const today = new Date().toISOString().split('T')[0];
        const upcoming = sorted.filter(e => e.date >= today);
        const past = sorted.filter(e => e.date < today);
        const retakeRequests = await dbGetAll('retakeRequests');
        const myRetakeExamIds = new Set(retakeRequests.filter(r => r.studentId === studentId && r.status !== 'rejected').map(r => r.examId));
        const submissions = await dbGetAll('submissions');

        const tbody = document.getElementById('exams-body');
        const tableContainer = tbody.closest('.table-container');
        if (tableContainer) tableContainer.style.display = 'none';

        let container = document.getElementById('student-exams-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'student-exams-container';
            container.style.padding = '16px 0';
            const tabContent = tbody.closest('.tab-content') || document.getElementById('screen-exams');
            tabContent.appendChild(container);
        }

        function examCard(e) {
            const course = courses.find(c => c.id === e.courseId);
            const center = centers.find(x => x.id === e.studyCenterId);
            const myReg = registrations.find(r => r.examId === e.id);
            const examCheckIds = [e.id];
            if (e.linkedQuizId) examCheckIds.push(e.linkedQuizId);
            const examSub = submissions.find(s => examCheckIds.includes(s.quizId) && s.studentId === studentId);
            const isRegistered = !!myReg;
            const passed = examSub && examSub.status === 'pass';
            const typeIcon = e.type === 'final' ? '📄' : e.type === 'supplementary' ? '🔄' : '📝';
            const typeLabel = e.type === 'final' ? 'Final' : e.type === 'supplementary' ? 'Supplementary' : 'Midterm';
            const hasPendingRequest = myRetakeExamIds.has(e.id);
            return `<div style="padding:16px;border:1px solid var(--border);border-radius:12px;margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px;">
                    <div>
                        <b style="font-size:14px;">${typeIcon} ${e.title || course?.code || e.courseId}</b>
                        <span class="badge badge-info" style="font-size:9px;margin-left:6px;">${typeLabel}</span>
                        ${course ? `<br><span style="font-size:11px;color:var(--text-muted);">${course.name} (${course.code})</span>` : ''}
                    </div>
                    <div style="text-align:right;">
                        ${passed ? '<span class="badge badge-success">PASSED</span>' : examSub ? '<span class="badge badge-danger">FAILED</span>' : isRegistered ? '<span class="badge badge-info">REGISTERED</span>' : ''}
                    </div>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:8px;font-size:11px;color:var(--text-muted);margin-bottom:8px;">
                    <span>📅 ${formatDate(e.date)}</span>
                    <span>⏰ ${e.time}</span>
                    <span>📍 ${e.venue || '--'}</span>
                    <span>📝 ${e.questionIds ? e.questionIds.length : 0} questions</span>
                    <span>🎯 Pass: ${e.passMark || 50}%</span>
                    ${e.duration ? `<span>⏱ ${e.duration} min</span>` : ''}
                    ${center ? `<span>🏛 ${center.name}</span>` : ''}
                </div>
                <div style="margin-top:8px;">
                    ${examSub ? `<span>Score: <b style="color:${passed ? 'var(--success)' : 'var(--danger)'};">${examSub.score}%</b></span>` : isRegistered ? `<button class="btn btn-primary btn-sm" onclick="startExam('${e.id}')">📝 Take Exam</button>` : `<span style="font-size:11px;color:var(--text-muted);">Not registered</span>`}
                    ${!passed && hasPendingRequest ? '<br><span class="badge badge-warning" style="margin-top:6px;">⏳ Request Pending</span>' : ''}
                    ${!passed && !hasPendingRequest && e.date < today ? `<br><button class="btn btn-outline btn-sm" onclick="requestMissedExam('${e.id}')" style="margin-top:6px;border-color:var(--warning);color:var(--warning);">📋 Request Exam</button>` : ''}
                </div>
            </div>`;
        }

        const upcomingHtml = upcoming.length ? upcoming.map(examCard).join('') : '<div style="text-align:center;padding:20px;color:var(--text-muted);">No upcoming exams.</div>';
        const pastHtml = past.length ? past.map(examCard).join('') : '<div style="text-align:center;padding:20px;color:var(--text-muted);">No past exams.</div>';

        container.innerHTML = `
            <h3 style="color:var(--accent);margin-bottom:12px;">📝 Upcoming Exams <span style="color:var(--text-muted);font-weight:400;font-size:13px;">(${upcoming.length})</span></h3>
            ${upcomingHtml}
            <h3 style="color:var(--accent);margin-bottom:12px;margin-top:24px;">📋 Past Exams <span style="color:var(--text-muted);font-weight:400;font-size:13px;">(${past.length})</span></h3>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">Missed an exam or registered late? Click "Request Exam" to ask for a supplementary session.</div>
            ${pastHtml}
        `;
    } else {
        const addBtn = document.querySelector('#screen-exams .btn-primary');
        if (addBtn) addBtn.style.display = '';
        const scheduleBtn = document.querySelector('#screen-exams .btn-outline');
        if (scheduleBtn) scheduleBtn.style.display = '';
        const moderationBtn = document.querySelector('#screen-exams .btn-success');
        if (moderationBtn) moderationBtn.style.display = '';
        const tableContainer = document.querySelector('#exams-body').closest('.table-container');
        if (tableContainer) tableContainer.style.display = '';
        const container = document.getElementById('student-exams-container');
        if (container) container.innerHTML = '';

        const filtered = exams.filter(e => e.semester == semester).sort((a, b) => a.date.localeCompare(b.date));
        document.getElementById('exams-body').innerHTML = filtered.map(e => {
            const course = courses.find(c => c.id === e.courseId);
            const invigilator = staff.find(s => s.id === e.invigilatorId);
            const center = centers.find(x => x.id === e.studyCenterId);
            const examRegs = registrations.filter(r => r.examId === e.id);
            const pub = e.published !== false;
            return `<tr><td><b>${(e.title || course?.code || e.courseId)}</b><br><span style="font-size:11px;color:var(--text-muted);">${course ? course.name : ''}</span>${center ? `<br><span style="font-size:10px;color:var(--accent);">${center.name}</span>` : ''}</td><td>${formatDate(e.date)}</td><td>${e.time}</td><td>${e.venue}</td><td>${examRegs.length}</td><td>${invigilator ? invigilator.name : '--'}</td><td><span class="badge badge-${pub ? 'success' : 'secondary'}" style="cursor:pointer;" onclick="toggleExamPublished('${e.id}')">${pub ? 'Published' : 'Draft'}</span></td><td><button class="btn btn-outline btn-sm" onclick="showExamForm('${e.id}')">Edit</button> <button class="btn btn-outline btn-sm" onclick="showExamRegistration('${e.id}')">Reg</button> <button class="btn btn-outline btn-sm" onclick="showExamResults('${e.id}')">Results</button> <button class="btn btn-warning btn-sm" onclick="showExamNotify('${e.id}')">Notify</button> <button class="btn btn-danger btn-sm" onclick="deleteExam('${e.id}')">Del</button></td></tr>`;
        }).join('') || '<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-muted);">No exams scheduled for this semester</td></tr>';
        renderRetakeRequests();
    }
}

async function renderRetakeRequests() {
    const requests = await dbGetAll('retakeRequests');
    const pending = requests.filter(r => r.status === 'pending').sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    const resolved = requests.filter(r => r.status !== 'pending').sort((a, b) => (b.resolvedAt || '').localeCompare(a.resolvedAt || ''));
    const students = await dbGetAll('students');
    const exams = await dbGetAll('exams');
    const courses = await dbGetAll('courses');
    let container = document.getElementById('retake-requests-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'retake-requests-container';
        const examsTable = document.querySelector('#exams-body')?.closest('.tab-content') || document.querySelector('#screen-exams');
        if (examsTable) examsTable.appendChild(container);
    }
    container.innerHTML = `
        <div style="margin-top:32px;">
            <h3 style="color:var(--accent);margin-bottom:4px;">📋 Retake Requests</h3>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px;">${pending.length} pending · ${resolved.length} resolved</div>
            ${pending.length ? `<div style="margin-bottom:20px;">${pending.map(r => {
                const st = students.find(s => s.id === r.studentId);
                const ex = exams.find(e => e.id === r.examId);
                const co = courses.find(c => c.id === ex?.courseId);
                return `<div style="padding:14px;border:1px solid var(--warning);border-left:4px solid var(--warning);border-radius:10px;margin-bottom:10px;background:var(--bg-card);">
                    <div style="display:flex;justify-content:space-between;align-items:start;gap:12px;">
                        <div style="flex:1;">
                            <div style="font-weight:700;font-size:14px;">${escapeHtml(st?.name || r.studentId)} <span style="font-size:11px;color:var(--text-muted);">(${escapeHtml(st?.admissionNumber || '')})</span></div>
                            <div style="font-size:12px;color:var(--text);margin-top:4px;"><b>Exam:</b> ${escapeHtml(ex?.title || co?.code || r.examId)} — ${ex ? formatDate(ex.date) + ' ' + (ex.time || '') : ''}</div>
                            ${r.requestType ? `<span class="badge badge-info" style="font-size:10px;margin-top:4px;">${r.requestType === 'missed' ? 'Missed Exam' : 'Retake'}</span>` : ''}
                            <div style="font-size:12px;color:var(--text-muted);margin-top:4px;"><b>Reason:</b> ${escapeHtml(r.reason)}</div>
                            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Requested: ${formatDate(r.createdAt)}</div>
                        </div>
                        <div style="display:flex;gap:6px;flex-shrink:0;">
                            <button class="btn btn-success btn-sm" onclick="approveRetake('${r.id}')">✓ Approve</button>
                            <button class="btn btn-danger btn-sm" onclick="rejectRetake('${r.id}')">✗ Reject</button>
                        </div>
                    </div>
                </div>`;
            }).join('')}</div>` : '<div style="padding:20px;text-align:center;color:var(--text-muted);background:var(--bg-card);border-radius:10px;margin-bottom:16px;">No pending retake requests.</div>'}
            ${resolved.length ? `<details><summary style="cursor:pointer;font-size:12px;color:var(--text-muted);margin-bottom:8px;">View resolved requests (${resolved.length})</summary>${resolved.map(r => {
                const st = students.find(s => s.id === r.studentId);
                const ex = exams.find(e => e.id === r.examId);
                const statusColor = r.status === 'approved' ? 'var(--success)' : 'var(--danger)';
                return `<div style="padding:10px;border:1px solid var(--border);border-left:4px solid ${statusColor};border-radius:8px;margin-bottom:6px;font-size:12px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <span><b>${escapeHtml(st?.name || r.studentId)}</b> — ${escapeHtml(ex?.title || r.examId)} <span class="badge" style="background:${statusColor};color:#fff;font-size:10px;">${r.status}</span></span>
                        <span style="color:var(--text-muted);font-size:11px;">${formatDate(r.resolvedAt)}</span>
                    </div>
                    ${r.adminNote ? `<div style="color:var(--text-muted);margin-top:4px;">Note: ${escapeHtml(r.adminNote)}</div>` : ''}
                </div>`;
            }).join('')}</details>` : ''}
        </div>
    `;
}

async function approveRetake(requestId) {
    const request = await dbGet('retakeRequests', requestId);
    if (!request) return;
    const exam = await dbGet('exams', request.examId);
    if (!exam) return showToast('Original exam not found', { type: 'danger' });
    const students = await dbGetAll('students');
    const student = students.find(s => s.id === request.studentId);
    const content = `
        <div style="margin-bottom:16px;">
            <div style="padding:12px;background:var(--bg-input);border-radius:8px;margin-bottom:12px;">
                <b>Student:</b> ${escapeHtml(student?.name || request.studentId)}<br>
                <b>Exam:</b> ${escapeHtml(exam.title || exam.courseId)}<br>
                <b>Reason:</b> ${escapeHtml(request.reason)}
            </div>
            <div class="form-group">
                <label>Supplementary Exam Date *</label>
                <input type="date" id="supp-date" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);">
            </div>
            <div class="form-row">
                <div class="form-group"><label>Time *</label><input type="text" id="supp-time" value="${exam.time || '09:00-12:00'}" placeholder="09:00-12:00" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);"></div>
                <div class="form-group"><label>Venue *</label><input type="text" id="supp-venue" value="${escapeHtml(exam.venue || '')}" placeholder="Hall A" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);"></div>
            </div>
            <div class="form-group"><label>Admin Note (optional)</label><input type="text" id="supp-note" placeholder="Note for the student..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);"></div>
        </div>
    `;
    showModal(request.requestType === 'missed' ? 'Approve Missed Exam — Schedule' : 'Approve Retake — Schedule Supplementary', content, `<button class="btn btn-success" onclick="confirmApproveRetake('${requestId}')">Approve & Schedule</button>`);
}

async function confirmApproveRetake(requestId) {
    const request = await dbGet('retakeRequests', requestId);
    if (!request) return;
    const exam = await dbGet('exams', request.examId);
    if (!exam) return;
    const date = document.getElementById('supp-date').value;
    const time = document.getElementById('supp-time').value.trim();
    const venue = document.getElementById('supp-venue').value.trim();
    const note = document.getElementById('supp-note').value.trim();
    if (!date || !time || !venue) return showToast('Date, time, and venue required', { type: 'danger' });
    const suppId = 'EXM-SUPP-' + Date.now();
    const supplementary = { id: suppId, courseId: exam.courseId, studyCenterId: exam.studyCenterId, date, time, venue, invigilatorId: exam.invigilatorId || '', type: 'supplementary', duration: exam.duration || 180, passMark: exam.passMark || 50, totalMarks: exam.totalMarks || 100, questionIds: exam.questionIds || [], title: (exam.title || 'Exam') + ' — Supplementary', semester: exam.semester, published: true, linkedQuizId: exam.linkedQuizId || '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await dbPut('exams', supplementary);
    await dbPut('examRegistrations', { id: `EXREG-${suppId}-${request.studentId}`, examId: suppId, studentId: request.studentId, registeredAt: new Date().toISOString() });
    const allSeats = (await dbGetAll('seating')).filter(s => s.examId === suppId);
    const maxSeat = allSeats.reduce((m, s) => Math.max(m, s.seatNumber || 0), 0);
    await dbPut('seating', { id: `SEAT-${suppId}-${request.studentId}`, examId: suppId, studentId: request.studentId, seatNumber: maxSeat + 1, createdAt: new Date().toISOString() });
    request.status = 'approved';
    request.adminNote = note;
    request.supplementaryExamId = suppId;
    request.resolvedAt = new Date().toISOString();
    await dbPut('retakeRequests', request);
    closeModal();
    showToast('✅ Retake approved! Supplementary exam scheduled.');
    logAudit('approved', 'retakeRequest', { requestId, studentId: request.studentId, supplementaryExamId: suppId });
    renderExams();
    invalidateStudentHubCache();
}

async function rejectRetake(requestId) {
    const request = await dbGet('retakeRequests', requestId);
    if (!request) return;
    const students = await dbGetAll('students');
    const st = students.find(s => s.id === request.studentId);
    const content = `
        <div style="padding:12px;background:var(--bg-input);border-radius:8px;margin-bottom:16px;">
            <b>Student:</b> ${escapeHtml(st?.name || request.studentId)}<br>
            <b>Reason:</b> ${escapeHtml(request.reason)}
        </div>
        <div class="form-group">
            <label>Rejection reason (optional)</label>
            <textarea id="reject-note" rows="3" placeholder="Explain why the request was rejected..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13px;"></textarea>
        </div>
    `;
    showModal('Reject Retake Request', content, `<button class="btn btn-danger" onclick="confirmRejectRetake('${requestId}')">Reject Request</button>`);
}

async function confirmRejectRetake(requestId) {
    const request = await dbGet('retakeRequests', requestId);
    if (!request) return;
    const note = document.getElementById('reject-note')?.value.trim() || '';
    request.status = 'rejected';
    request.adminNote = note;
    request.resolvedAt = new Date().toISOString();
    await dbPut('retakeRequests', request);
    closeModal();
    showToast('Request rejected');
    logAudit('rejected', 'retakeRequest', { requestId, studentId: request.studentId });
    renderExams();
    invalidateStudentHubCache();
}

async function showExamForm(exam = null) {
    const courses = await dbGetAll('courses');
    const staff = await dbGetAll('staff');
    const centers = await dbGetAll('studyCenters');
    const quizzes = await dbGetAll('quizzes');
    const semester = document.getElementById('exam-semester').value;
    const questions = await dbGetAll('questionBank');
    const selQ = (exam && exam.questionIds) ? exam.questionIds : [];
    const published = exam ? (exam.published !== undefined ? exam.published : true) : false;
    const totalMarks = exam && exam.totalMarks ? exam.totalMarks : 100;
    const fmt = (s) => s || '';
    const examCourseId = exam ? exam.courseId : '';
    const linkedQuizId = exam ? (exam.linkedQuizId || '') : '';
    const examQuizzes = quizzes.filter(q => q.courseId === examCourseId && q.assessmentType === 'exam');
    const content = `<input type="hidden" id="exam-edit-id" value="${fmt(exam ? exam.id : '')}">
<div class="form-row">
  <div class="form-group"><label>Course *</label><select id="exam-course" onchange="onExamCourseChange();onExamCourseQuizzes()"><option value="">Select course...</option>${courses.map(c => `<option value="${c.id}" ${exam && exam.courseId === c.id ? 'selected' : ''}>${c.code} - ${c.name}</option>`).join('')}</select></div>
  <div class="form-group"><label>Study Center</label><select id="exam-center"><option value="">All Centers</option>${centers.map(c => `<option value="${c.id}" ${exam && exam.studyCenterId === c.id ? 'selected' : ''}>${c.name} (${c.code})</option>`).join('')}</select></div>
</div>
<div class="form-group"><label>Exam Title</label><input type="text" id="exam-title" value="${fmt(exam ? exam.title : '')}" placeholder="e.g., Midterm Exam"></div>
<div class="form-row">
  <div class="form-group"><label>Date *</label><input type="date" id="exam-date" value="${fmt(exam ? exam.date : '')}"></div>
  <div class="form-group"><label>Time *</label><input type="text" id="exam-time" value="${fmt(exam ? exam.time : '')}" placeholder="09:00-12:00"></div>
</div>
<div class="form-row">
  <div class="form-group"><label>Venue *</label><input type="text" id="exam-venue" value="${fmt(exam ? exam.venue : '')}" placeholder="Hall A"></div>
  <div class="form-group"><label>Invigilator</label><select id="exam-invigilator"><option value="">Unassigned</option>${staff.map(s => `<option value="${s.id}" ${exam && exam.invigilatorId === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}</select></div>
</div>
<div class="form-row">
  <div class="form-group"><label>Pass Mark (%)</label><input type="number" id="exam-pass" value="${exam && exam.passMark ? exam.passMark : 50}" min="0" max="100" style="width:80px;"></div>
  <div class="form-group"><label>Duration (min)</label><input type="number" id="exam-duration" value="${exam && exam.duration ? exam.duration : 180}" style="width:80px;"></div>
</div>
<div class="form-row">
  <div class="form-group"><label>Type</label><select id="exam-type"><option value="midterm" ${exam && exam.type === 'midterm' ? 'selected' : ''}>Midterm</option><option value="final" ${exam && exam.type === 'final' ? 'selected' : ''}>Final Exam</option><option value="supplementary" ${exam && exam.type === 'supplementary' ? 'selected' : ''}>Supplementary</option></select></div>
  <div class="form-group"><label>Total Marks</label><input type="number" id="exam-total-marks" value="${totalMarks}" min="1" style="width:80px;"><div style="font-size:10px;color:var(--text-muted);">Auto-filled from course settings</div></div>
</div>
<div class="form-group"><label>🔗 Link to Quiz (for grading)</label><select id="exam-linked-quiz"><option value="">No linked quiz (standalone)</option>${examQuizzes.map(q => `<option value="${q.id}" ${linkedQuizId === q.id ? 'selected' : ''}>${q.title || q.id} (${q.questionIds ? q.questionIds.length : 0} questions)</option>`).join('')}</select><div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Linking a quiz ensures exam results are graded as "Exam" in the weighted grade calculation.</div></div>
<div class="form-row">
  <div class="form-group"><label>Lesson (filter questions)</label><select id="exam-lesson-select"><option value="">All Lessons</option></select></div>
  <div class="form-group" style="display:flex;align-items:center;gap:8px;padding-top:20px;">
    <label style="position:relative;display:inline-block;width:44px;height:24px;cursor:pointer;">
      <input type="checkbox" id="exam-published" ${published ? 'checked' : ''} style="opacity:0;width:0;height:0;">
      <span style="position:absolute;inset:0;background-color:${published ? '#22c55e' : '#64748b'};border-radius:24px;transition:.3s;"></span>
      <span style="position:absolute;left:${published ? '22px' : '2px'};top:2px;width:20px;height:20px;background:#fff;border-radius:50%;transition:.3s;"></span>
    </label>
    <span id="exam-pub-label" style="font-size:13px;font-weight:600;color:${published ? '#22c55e' : '#64748b'};">${published ? 'Published' : 'Draft'}</span>
  </div>
</div>
<div class="form-group"><label>Select Questions</label><div id="exam-question-list" style="max-height:220px;overflow-y:auto;padding:8px;background:var(--bg-input);border-radius:6px;"></div><div style="margin-top:8px;font-size:11px;color:var(--text-muted);display:flex;justify-content:space-between;"><span>Selected: <span id="exam-q-count">0</span> questions, <span id="exam-total-pts">0</span> pts</span><span id="exam-marks-status">Total Marks: <span id="exam-total-marks-display">0</span></span></div></div>`;
    showModal(exam ? 'Edit Exam' : 'Schedule Exam', content, `<button class="btn btn-primary" onclick="saveExam()">${exam ? 'Update' : 'Schedule'}</button>`);
    document.getElementById('exam-published')?.addEventListener('change', function() {
        const lbl = document.getElementById('exam-pub-label');
        const bg = this.parentElement.querySelector('span');
        const dot = bg.nextElementSibling;
        if (this.checked) { lbl.textContent = 'Published'; lbl.style.color = '#22c55e'; bg.style.backgroundColor = '#22c55e'; dot.style.left = '22px'; }
        else { lbl.textContent = 'Draft'; lbl.style.color = '#64748b'; bg.style.backgroundColor = '#64748b'; dot.style.left = '2px'; }
    });
    onExamCourseChange(null, selQ);
}

async function onExamCourseQuizzes() {
    const courseId = document.getElementById('exam-course').value;
    const quizzes = await dbGetAll('quizzes');
    const linkedQuizId = document.getElementById('exam-linked-quiz')?.value || '';
    const examQuizzes = courseId ? quizzes.filter(q => q.courseId === courseId && q.assessmentType === 'exam') : [];
    const sel = document.getElementById('exam-linked-quiz');
    if (sel) {
        sel.innerHTML = '<option value="">No linked quiz (standalone)</option>' + examQuizzes.map(q => `<option value="${q.id}" ${linkedQuizId === q.id ? 'selected' : ''}>${q.title || q.id} (${q.questionIds ? q.questionIds.length : 0} questions)</option>`).join('');
    }
}

async function onExamCourseChange(selectedLessonId, selectedIds) {
    const courseId = document.getElementById('exam-course').value;
    const courses = await dbGetAll('courses');
    const course = courses.find(c => c.id === courseId);
    const lessons = await dbGetAll('lessons');
    const questions = await dbGetAll('questionBank');
    const filtered = courseId ? lessons.filter(l => l.courseId === courseId) : [];
    document.getElementById('exam-lesson-select').innerHTML = '<option value="">All Lessons</option>' + filtered.map(l => `<option value="${l.id}" ${selectedLessonId === l.id ? 'selected' : ''}>${l.title}</option>`).join('');
    const qFiltered = questions.filter(q => q.courseId === courseId && (!selectedLessonId || q.lessonId === selectedLessonId));
    const sel = selectedIds || [];
    const typeIcons = { 'mcq': '\u{1F538}', 'truefalse': '\u2705', 'matching': '\u{1F517}', 'essay': '\u{1F4DD}' };
    document.getElementById('exam-question-list').innerHTML = qFiltered.map(q => `<label style="display:flex;align-items:center;gap:8px;padding:6px;border-bottom:1px solid var(--border);cursor:pointer;font-size:12px;"><input type="checkbox" class="exam-q-check" value="${q.id}" ${sel.includes(q.id) ? 'checked' : ''} onchange="updateExamQCount()"> <span style="font-weight:600;">${typeIcons[q.type] || '\u2753'}</span> ${q.question.substring(0, 80)}${q.question.length > 80 ? '...' : ''} <span class="badge badge-info" style="font-size:9px;">${q.points || 1}pt</span></label>`).join('') || '<div style="padding:10px;color:var(--text-muted);font-size:12px;">No questions available for this course</div>';
    updateExamQCount();
    if (course) {
        const tm = document.getElementById('exam-total-marks');
        if (tm && !tm.dataset.userSet) tm.value = course.examWeight || 100;
    }
    document.getElementById('exam-lesson-select').onchange = () => onExamCourseChange(document.getElementById('exam-lesson-select').value, Array.from(document.querySelectorAll('.exam-q-check:checked')).map(c => c.value));
}

function updateExamQCount() {
    const checked = Array.from(document.querySelectorAll('.exam-q-check:checked'));
    const count = checked.length;
    document.getElementById('exam-q-count').textContent = count;
    const totalPoints = checked.reduce((sum, c) => {
        const label = c.closest('label');
        const badge = label ? label.querySelector('.badge') : null;
        return sum + (badge ? parseInt(badge.textContent) || 1 : 1);
    }, 0);
    const ptsDisplay = document.getElementById('exam-total-pts');
    if (ptsDisplay) ptsDisplay.textContent = totalPoints;
    const tmDisplay = document.getElementById('exam-total-marks-display');
    if (tmDisplay) tmDisplay.textContent = totalPoints;
    const tm = document.getElementById('exam-total-marks');
    if (tm && tm.value) {
        const status = document.getElementById('exam-marks-status');
        if (status) {
            const expected = parseInt(tm.value) || 0;
            if (totalPoints === expected) {
                status.style.color = 'var(--success)';
                status.innerHTML = 'Total Marks: <span id="exam-total-marks-display">' + totalPoints + '</span> \u2713';
            } else if (totalPoints > 0) {
                status.style.color = 'var(--warning)';
                status.innerHTML = 'Total Marks: <span id="exam-total-marks-display">' + totalPoints + '</span> / ' + expected + ' (mismatch)';
            }
        }
    }
}

async function saveExam() {
    const courseId = document.getElementById('exam-course').value;
    const date = document.getElementById('exam-date').value;
    const time = document.getElementById('exam-time').value.trim();
    if (!courseId || !date || !time) return showToast('Course, date, and time required!');
    const editId = document.getElementById('exam-edit-id').value;
    const id = editId || 'EXM-' + Date.now();
    const existing = editId ? await dbGet('exams', id) : null;
    const questionIds = Array.from(document.querySelectorAll('.exam-q-check:checked')).map(c => c.value);
    if (!questionIds.length) return showToast('Select at least one question!');
    const exam = { id, courseId, studyCenterId: document.getElementById('exam-center').value, date, time, venue: document.getElementById('exam-venue').value.trim(), invigilatorId: document.getElementById('exam-invigilator').value, type: document.getElementById('exam-type').value, duration: parseInt(document.getElementById('exam-duration').value) || 180, passMark: parseInt(document.getElementById('exam-pass').value) || 50, totalMarks: parseInt(document.getElementById('exam-total-marks').value) || 100, questionIds, title: document.getElementById('exam-title').value.trim(), semester: document.getElementById('exam-semester').value, published: document.getElementById('exam-published').checked, linkedQuizId: document.getElementById('exam-linked-quiz')?.value || '', createdAt: existing ? existing.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString() };
    await dbPut('exams', exam); closeModal(); renderExams(); showToast(editId ? 'Exam updated!' : 'Exam scheduled!'); logAudit(editId ? 'updated' : 'created', 'exam', exam);
    if (!editId) await autoGenerateSeating(exam);
}

async function editExam(id) {
    const exam = await dbGet('exams', id);
    if (!exam) return;
    showExamForm(exam);
    setTimeout(() => {
        document.getElementById('exam-course').value = exam.courseId;
        document.getElementById('exam-date').value = exam.date;
        document.getElementById('exam-time').value = exam.time;
        document.getElementById('exam-venue').value = exam.venue;
        document.getElementById('exam-invigilator').value = exam.invigilatorId || '';
        document.getElementById('exam-type').value = exam.type;
        document.getElementById('exam-duration').value = exam.duration;
        onExamCourseQuizzes();
    }, 100);
}

async function deleteExam(id) {
    if (!await showConfirm('Confirm', 'Delete exam?')) return;
    await dbDelete('exams', id); renderExams(); showToast('Exam deleted'); logAudit('deleted', 'exam', { id });
}

async function requestMissedExam(examId) {
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const students = await dbGetAll('students');
    const me = students.find(s => s.id === currentUser.studentId || s.id === currentUser.username || s.email === currentUser.username || s.phone === currentUser.username);
    if (!me) return showToast('Could not identify your student profile', { type: 'danger' });
    const exams = await dbGetAll('exams');
    const exam = exams.find(e => e.id === examId);
    if (!exam) return showToast('Exam not found', { type: 'danger' });
    const courses = await dbGetAll('courses');
    const course = courses.find(c => c.id === exam.courseId);
    const existing = (await dbGetAll('retakeRequests')).find(r => r.studentId === me.id && r.examId === examId && r.status === 'pending');
    if (existing) return showToast('You already have a pending request for this exam', { type: 'warning' });
    const content = `
        <div style="margin-bottom:16px;">
            <div style="padding:12px;background:var(--bg-input);border-radius:8px;margin-bottom:16px;">
                <div style="font-weight:600;font-size:14px;margin-bottom:4px;">📝 ${esc(exam.title || course?.code || 'Exam')}</div>
                <div style="font-size:12px;color:var(--text-muted);">${formatDate(exam.date)} ${esc(exam.time || '')} · ${course ? esc(course.name) : ''}</div>
            </div>
            <div class="form-group">
                <label>Reason *</label>
                <textarea id="missed-reason" rows="4" placeholder="Explain why you missed the exam or registered late..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13px;resize:vertical;"></textarea>
            </div>
        </div>
    `;
    showModal('Request Exam', content, `<button class="btn btn-primary" onclick="submitMissedExamRequest('${examId}')">Submit Request</button>`);
}

async function submitMissedExamRequest(examId) {
    const reason = document.getElementById('missed-reason')?.value.trim();
    if (!reason) return showToast('Please provide a reason', { type: 'danger' });
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const students = await dbGetAll('students');
    const me = students.find(s => s.id === currentUser.studentId || s.id === currentUser.username || s.email === currentUser.username || s.phone === currentUser.username);
    if (!me) return showToast('Could not identify your student profile', { type: 'danger' });
    const record = { id: `RET-${examId}-${me.id}`, examId, studentId: me.id, reason, status: 'pending', requestType: 'missed', createdAt: new Date().toISOString() };
    await dbPut('retakeRequests', record);
    closeModal();
    showToast('✅ Request submitted. Awaiting admin approval.');
    logAudit('created', 'retakeRequest', { studentId: me.id, examId, requestType: 'missed' });
    renderExams();
    invalidateStudentHubCache();
}

async function toggleExamPublished(id) {
    const exam = await dbGet('exams', id);
    if (!exam) return;
    exam.published = exam.published === false ? true : false;
    exam.updatedAt = new Date().toISOString();
    await dbPut('exams', exam);
    renderExams();
    invalidatePortalCache();
    showToast(exam.published ? 'Exam published!' : 'Exam set to draft.');
    logAudit('updated', 'exam-publish', { id, published: exam.published });
}

async function autoGenerateSeating(exam) {
    const regs = (await dbGetAll('examRegistrations')).filter(r => r.examId === exam.id);
    const studentIds = regs.map(r => r.studentId);
    const students = await dbGetAll('students');
    const courseStudents = students.filter(s => studentIds.includes(s.id) && s.status === 'active').sort(() => Math.random() - 0.5);
    const existing = (await dbGetAll('seating')).filter(s => s.examId === exam.id);
    for (const e of existing) await dbDelete('seating', e.id);
    let seatNum = 1;
    for (const s of courseStudents) {
        await dbPut('seating', { id: `SEAT-${exam.id}-${s.id}`, examId: exam.id, studentId: s.id, seatNumber: seatNum, createdAt: new Date().toISOString() });
        seatNum++;
    }
}

async function showSeatingPlan() {
    const exams = await dbGetAll('exams');
    const semester = document.getElementById('exam-semester').value;
    const semesterExams = exams.filter(e => e.semester == semester);
    const content = `<div class="form-group"><label>Select Exam</label><select id="seating-exam">${semesterExams.map(e => `<option value="${e.id}">${e.title || e.courseId} — ${formatDate(e.date)} ${e.time}</option>`).join('')}</select></div><button class="btn btn-primary" onclick="renderSeatingPlan()" style="margin-top:8px;">Generate Seating Plan</button><div id="seating-plan-result" style="margin-top:16px;"></div>`;
    showModal('Seating Plan', content, `<button class="btn btn-outline" onclick="printSeatingPlan()">Print</button>`);
}

async function renderSeatingPlan() {
    const examId = document.getElementById('seating-exam').value;
    const exam = await dbGet('exams', examId);
    const seating = (await dbGetAll('seating')).filter(s => s.examId === examId);
    const students = await dbGetAll('students');
    const centers = await dbGetAll('studyCenters');
    const regs = (await dbGetAll('examRegistrations')).filter(r => r.examId === examId);
    seating.sort((a, b) => a.seatNumber - b.seatNumber);
    if (!seating.length) {
        document.getElementById('seating-plan-result').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);">No students registered for this exam. Register students first.</div>';
        return;
    }
    let html = `<div style="margin-bottom:12px;font-size:12px;color:var(--text-muted);">${exam ? (exam.title || exam.courseId) + ' — ' + formatDate(exam.date) + ' ' + exam.time : ''} | Total: ${seating.length} students</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;">`;
    seating.forEach(s => {
        const student = students.find(st => st.id === s.studentId);
        const reg = regs.find(r => r.studentId === s.studentId);
        const center = centers.find(c => c.id === student?.studyCenterId);
        html += `<div style="padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;font-size:11px;">
            <div style="font-weight:700;font-size:13px;">${student ? student.name : s.studentId}</div>
            <div style="color:#64748b;">${student?.admissionNumber || ''}</div>
            <div style="color:#475569;">${student?.program || '--'} ${student?.year ? 'Year ' + student.year : ''}</div>
            <div style="color:#94a3b8;">${center ? center.name : 'No Center'}${student?.phone ? ' &middot; ' + student.phone : ''}</div>
            <div style="font-weight:700;font-size:20px;text-align:center;margin-top:4px;">${s.seatNumber}</div>
        </div>`;
    });
    html += '</div>';
    document.getElementById('seating-plan-result').innerHTML = html;
}

function printSeatingPlan() {
    const content = document.getElementById('seating-plan-result').innerHTML;
    const w = window.open('', '', 'width=900,height=700');
        w.document.write(`<html><head><title>Seating Plan</title><style>body{font-family:Arial,sans-serif;padding:20px;}h2{margin-bottom:4px;}sub{margin-bottom:16px;display:block;color:#666;}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax:180px,1fr);gap:8px;}.card{padding:8px 10px;border:1px solid #ddd;border-radius:6px;background:#f8fafc;font-size:11px;}.card .no{font-weight:700;font-size:20px;text-align:center;margin-top:4px;}.card .name{font-weight:700;}.card .adm{color:#64748b;}.card .program{color:#475569;}.card .meta{color:#94a3b8;}</style></head><body><h2>Seating Plan</h2>${content.replace(/style="[^"]*"/g, '').replace(/<div style="margin-bottom:12px;[^"]*">[^<]*<\/div>/g, '<sub>$&</sub>').replace(/class="[^"]*"/g, '')}</body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 500);
}

async function showModerationReport() {
    const grades = await dbGetAll('grades');
    const students = await dbGetAll('students');
    const courses = await dbGetAll('courses');
    const semester = document.getElementById('exam-semester').value;
    const semesterGrades = grades.filter(g => g.semester == semester);
    const courseGrades = {};
    semesterGrades.forEach(g => { if (!courseGrades[g.courseId]) courseGrades[g.courseId] = []; courseGrades[g.courseId].push(g); });
    let html = '<h4 style="color:var(--accent);margin-bottom:12px;">Grade Moderation Report - Semester ' + semester + '</h4>';
    for (const courseId in courseGrades) {
        const course = courses.find(c => c.id === courseId);
        const gList = courseGrades[courseId];
        const avg = gList.reduce((s, g) => s + g.score, 0) / gList.length;
        const dist = { A: 0, B: 0, C: 0, D: 0, F: 0 };
        gList.forEach(g => { if (g.score >= 75) dist.A++; else if (g.score >= 60) dist.B++; else if (g.score >= 50) dist.C++; else if (g.score >= 40) dist.D++; else dist.F++; });
        html += `<div class="event-item" style="flex-direction:column;align-items:flex-start;gap:4px;"><b>${course ? course.code : courseId} - ${course ? course.name : ''}</b><span style="font-size:12px;">Average: ${avg.toFixed(1)}% | A: ${dist.A} | B: ${dist.B} | C: ${dist.C} | D: ${dist.D} | F: ${dist.F}</span></div>`;
    }
    showModal('Moderation Report', html, `<button class="btn btn-outline" onclick="window.print()">Print</button>`);
}



async function showExamRegistration(examId) {
    const exam = await dbGet('exams', examId);
    if (!exam) return;
    const course = await dbGet('courses', exam.courseId);
    const students = await dbGetAll('students');
    const centers = await dbGetAll('studyCenters');
    const regs = (await dbGetAll('examRegistrations')).filter(r => r.examId === examId);
    const regIds = new Set(regs.map(r => r.studentId));
    const activeStudents = students.filter(s => s.status === 'active');
    const centerOpts = centers.map(c => `<option value="${c.id}" ${exam.studyCenterId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
    let html = `<div style="margin-bottom:12px;"><b>${course ? course.name : exam.courseId}</b> — ${formatDate(exam.date)} ${exam.time}</div>
        <div class="form-group"><label>Filter by Center</label><select id="exam-reg-center" onchange="examRegCenterFilter('${examId}')"><option value="">All Centers</option>${centerOpts}</select></div>
        <div id="exam-reg-section"><div class="form-group"><label>Add Student</label><select id="exam-reg-student"><option value="">Select student...</option>${activeStudents.filter(s=>{const c=document.getElementById('exam-reg-center');return (!c||!c.value||s.studyCenterId===c.value)&&!regIds.has(s.id);}).map(s=>`<option value="${s.id}">${escapeHtml(s.name)} (${s.admissionNumber||s.id})${s.studyCenterId?` - ${escapeHtml(centers.find(x=>x.id===s.studyCenterId)?.name||'')}`:''}</option>`).join('')}</select> <button class="btn btn-primary btn-sm" onclick="addExamRegistration('${examId}')" style="margin-top:4px;">+ Add</button></div>
        <div style="max-height:400px;overflow-y:auto;">
            <table class="data-table"><thead><tr><th>#</th><th>Student</th><th>Center</th><th>Action</th></tr></thead><tbody>
                ${regs.length ? regs.map((r,i)=>{const s=students.find(x=>x.id===r.studentId);return `<tr><td>${i+1}</td><td>${escapeHtml(s?.name||r.studentId)}</td><td style="font-size:11px;">${s?.studyCenterId?escapeHtml(centers.find(x=>x.id===s.studyCenterId)?.name||''):'--'}</td><td><button class="btn btn-danger btn-sm" onclick="removeExamRegistration('${r.id}','${examId}')">Del</button></td></tr>`;}).join('') : '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-muted);">No students registered yet</td></tr>'}
            </tbody></table>
        </div></div>`;
    showModal('Exam Registration', html, `<button class="btn btn-outline" onclick="closeModal()">Close</button>`);
}

function examRegCenterFilter(examId) {
    showExamRegistration(examId);
}

async function addExamRegistration(examId) {
    const sid = document.getElementById('exam-reg-student').value;
    if (!sid) return showToast('Select a student!');
    const existing = (await dbGetAll('examRegistrations')).filter(r => r.examId === examId && r.studentId === sid);
    if (existing.length) return showToast('Already registered!');
    await dbPut('examRegistrations', { id: 'EXREG-' + Date.now(), examId, studentId: sid, registeredAt: new Date().toISOString() });
    const exam = await dbGet('exams', examId);
    const student = await dbGet('students', sid);
    if (exam && student && student.status === 'active') {
        const existingSeat = (await dbGetAll('seating')).find(s => s.examId === examId && s.studentId === sid);
        if (!existingSeat) {
            const allSeats = (await dbGetAll('seating')).filter(s => s.examId === examId);
            const maxSeat = allSeats.reduce((m, s) => Math.max(m, s.seatNumber || 0), 0);
            await dbPut('seating', { id: `SEAT-${examId}-${sid}`, examId, studentId: sid, seatNumber: maxSeat + 1, createdAt: new Date().toISOString() });
        }
    }
    showToast('Registered!');
    showExamRegistration(examId);
}

async function removeExamRegistration(regId, examId) {
    if (!await showConfirm('Confirm', 'Remove this registration?')) return;
    const reg = await dbGet('examRegistrations', regId);
    await dbDelete('examRegistrations', regId);
    if (reg) {
        const seat = (await dbGetAll('seating')).find(s => s.examId === examId && s.studentId === reg.studentId);
        if (seat) await dbDelete('seating', seat.id);
    }
    showToast('Removed');
    showExamRegistration(examId);
}

async function showExamResults(examId) {
    const exam = await dbGet('exams', examId);
    if (!exam) return;
    const students = await dbGetAll('students');
    const checkIds = [examId];
    if (exam.linkedQuizId) checkIds.push(exam.linkedQuizId);
    const submissions = (await dbGetAll('submissions')).filter(s => checkIds.includes(s.quizId));
    const course = await dbGet('courses', exam.courseId);
    showModal('Exam Results — ' + (exam.title || exam.courseId), `<div style="margin-bottom:12px;"><b>${course ? course.name : exam.courseId}</b> | Date: ${formatDate(exam.date)} | Pass Mark: ${exam.passMark || 50}% | ${submissions.length} submissions</div>
        <table class="data-table"><thead><tr><th>#</th><th>Student</th><th>Adm No</th><th>Score</th><th>Status</th><th>Grade</th><th>Details</th></tr></thead><tbody>
            ${submissions.length ? submissions.map((s,i)=>{ const st=students.find(x=>x.id===s.studentId); return `<tr><td>${i+1}</td><td>${escapeHtml(st?.name||s.studentId)}</td><td>${st?.admissionNumber||''}</td><td><b>${s.score}%</b></td><td><span class="badge badge-${s.status==='pass'?'success':'danger'}">${s.status.toUpperCase()}</span></td><td>${s.grade||'--'}</td><td><button class="btn btn-outline btn-sm" onclick="viewSubmissionDetails('${s.id}')">View</button></td></tr>`; }).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted);">No submissions yet</td></tr>'}
        </tbody></table>`, `<button class="btn btn-outline" onclick="window.print()">Print</button> <button class="btn btn-outline" onclick="closeModal()">Close</button>`);
}

async function startExam(examId) {
    const exam = await dbGet('exams', examId);
    if (!exam) return;
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const studentId = currentUser.studentId || currentUser.username;
    const regs = (await dbGetAll('examRegistrations')).filter(r => r.examId === examId && r.studentId === studentId);
    if (!regs.length) return showToast('Not registered for this exam!');
    const checkIds = [examId];
    if (exam.linkedQuizId) checkIds.push(exam.linkedQuizId);
    const subs = (await dbGetAll('submissions')).filter(s => checkIds.includes(s.quizId) && s.studentId === studentId);
    if (subs.length) return showToast('Already submitted this exam!');
    let examQuestions = [];
    if (exam.linkedQuizId) {
        const linkedQuiz = await dbGet('quizzes', exam.linkedQuizId);
        if (linkedQuiz) {
            const questions = await dbGetAll('questionBank');
            examQuestions = (linkedQuiz.questionIds || []).map(id => questions.find(q => q.id === id)).filter(q => q);
            const quizObj = { ...linkedQuiz, title: exam.title || linkedQuiz.title || 'Exam', duration: exam.duration || linkedQuiz.timeLimit || 180, passMark: exam.passMark || linkedQuiz.passMark || 50 };
            if (!examQuestions.length) return showToast('No questions in the linked quiz!');
            const studentLang = (await dbGet('students', studentId))?.langPref || 'en';
            showLangSelectionModal(studentId, studentLang, (chosenLang) => {
                quizTimeRemaining = exam.duration ? exam.duration * 60 : (linkedQuiz.timeLimit ? linkedQuiz.timeLimit * 60 : 0);
                showQuizInterface(quizObj, examQuestions, chosenLang);
            });
            return;
        }
    }
    const questions = await dbGetAll('questionBank');
    examQuestions = (exam.questionIds || []).map(id => questions.find(q => q.id === id)).filter(q => q);
    if (!examQuestions.length) return showToast('No questions in this exam!');
    const studentLang = (await dbGet('students', studentId))?.langPref || 'en';
    showLangSelectionModal(studentId, studentLang, (chosenLang) => {
        quizTimeRemaining = exam.duration ? exam.duration * 60 : 0;
        showQuizInterface(exam, examQuestions, chosenLang);
    });
}

async function showExamNotify(examId) {
    const exam = await dbGet('exams', examId);
    if (!exam) return;
    const exams = await dbGetAll('exams');
    const students = await dbGetAll('students');
    const centers = await dbGetAll('studyCenters');
    const regs = (await dbGetAll('examRegistrations')).filter(r => r.examId === examId);
    const course = await dbGet('courses', exam.courseId);
    const center = centers.find(c => c.id === exam.studyCenterId);
    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College';

    const recipients = students.filter(s => s.status === 'active' && regs.some(r => r.studentId === s.id));

    const content = `<div style="margin-bottom:12px;"><b>${course ? course.name : exam.courseId}</b> — ${formatDate(exam.date)} ${exam.time}${center ? ' | ' + center.name : ''} | ${recipients.length} registered students</div>
        <div class="form-group"><label>Message Template</label><select id="exam-notify-tpl" onchange="document.getElementById('exam-notify-msg').value=this.value"><option value="">-- Write your own --</option>
            <option value="Dear {{name}}, this is to inform you that ${exam.title || course?.code || 'the exam'} is scheduled for ${formatDate(exam.date)} at ${exam.time}. Venue: ${exam.venue || 'TBA'}. Please be on time. — ${schoolName}">Exam Reminder</option>
            <option value="Dear {{name}}, your exam ${exam.title || course?.code || ''} has been scheduled. Date: ${formatDate(exam.date)}, Time: ${exam.time}, Venue: ${exam.venue || 'TBA'}, Duration: ${exam.duration || 180} minutes. Pass Mark: ${exam.passMark || 50}%. Login to the student portal to access the exam. — ${schoolName}">Full Details</option>
            <option value="Dear {{name}}, reminder: ${exam.title || course?.code || 'Your exam'} is coming up on ${formatDate(exam.date)}. Make sure you are registered and prepared. Good luck! — ${schoolName}">Quick Reminder</option>
        </select></div>
        <div class="form-group"><label>Message</label><textarea id="exam-notify-msg" rows="6" placeholder="Write your message here. Use {{name}} for student name."></textarea></div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">Recipients: <b>${recipients.length}</b> student(s) — preview below:</div>
        <div id="notify-preview" style="max-height:120px;overflow-y:auto;background:var(--bg-input);border-radius:6px;padding:8px;font-size:11px;color:var(--text-muted);margin-bottom:8px;">${recipients.slice(0, 5).map(s => escapeHtml(s.name) + (s.phone ? ' (' + s.phone + ')' : '')).join('<br>')}${recipients.length > 5 ? '<br>...and ' + (recipients.length - 5) + ' more' : ''}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn btn-outline btn-sm" onclick="previewExamNotify('${examId}')">Preview</button>
            <button class="btn btn-outline btn-sm" onclick="copyExamNotify('${examId}')">Copy</button>
        </div>`;
    showModal('Send Exam Notification', content, `<button class="btn btn-success" onclick="sendExamNotify('${examId}')">Send via WhatsApp</button>`);
}

function previewExamNotify(examId) {
    const msg = document.getElementById('exam-notify-msg').value;
    const area = document.getElementById('notify-preview');
    area.style.whiteSpace = 'pre-line';
    area.style.color = 'var(--text)';
    area.innerHTML = msg || '<span style="color:var(--text-muted);">No message to preview</span>';
}

function copyExamNotify(examId) {
    const msg = document.getElementById('exam-notify-msg').value;
    if (msg) navigator.clipboard?.writeText(msg) || prompt('Copy this message:', msg);
}

async function sendExamNotify(examId) {
    const msg = document.getElementById('exam-notify-msg').value.trim();
    if (!msg) return showToast('Write a message first!');
    const exam = await dbGet('exams', examId);
    const regs = (await dbGetAll('examRegistrations')).filter(r => r.examId === examId);
    const students = await dbGetAll('students');
    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College';
    let sent = 0, failed = 0;
    for (const reg of regs) {
        const student = students.find(s => s.id === reg.studentId);
        if (!student || !student.phone) { failed++; continue; }
        const personalized = msg.replace(/{{name}}/g, student.name);
        sendWhatsApp(student.phone, personalized);
        sent++;
    }
    closeModal();
    showToast(`Queued ${sent} message(s)${failed ? ' (${failed} failed - no phone)' : ''} via WhatsApp`);
    logAudit('sent', 'exam-notify', { examId, message: msg.substring(0, 50), sent, failed });
}

document.getElementById('exam-semester').addEventListener('change', renderExams);
document.addEventListener('change', function(e) { if (e.target.id === 'exam-total-marks') e.target.dataset.userSet = 'true'; });

var waQueue = [];
var waQueueIndex = 0;
var waQueueRunning = false;
var waQueueAutoAdvance = false;
var waQueueDelay = 2000;
var waSentCount;
var waFailedCount;

async function renderWhatsAppTemplates() {
    const templates = await dbGetAll('whatsappTemplates');
    const defaultTemplates = [
        { id: 'tpl-fee', name: '💰 Fee Reminder', message: 'Dear {{name}} ({{admission}}),\n\nThis is a friendly reminder from {{school}} that your current fee balance for the {{program}} program is {{balance}}.\n\nTo keep your account active and your exam eligibility secure, please clear your balance at the finance office, through the accounts team at {{center}} ({{centerCode}}), or online via the portal: {{portal}}\n\nIf you have already made payment, kindly share your receipt so we can update your record.\n\nThank you.\nGod bless.', category: 'finance' },
        { id: 'tpl-attendance', name: '⚠️ Attendance Warning', message: 'Dear {{name}} ({{admission}}),\n\nYour class attendance in the {{program}} program is currently below the required minimum ({{min}}%).\n\nPlease attend all remaining classes at {{center}} to be eligible for your exams. Your attendance is important for your progress and academic standing.\n\nContact your course lecturer or the academic office if you have any concerns.\n\n{{school}}', category: 'academic' },
        { id: 'tpl-exam', name: '📄 Exam Schedule', message: 'Dear {{name}} ({{admission}}),\n\nYour {{type}} exam for {{course}} ({{program}} program) is scheduled:\n📅 Date: {{date}}\n⏰ Time: {{time}}\n📍 Venue: {{venue}}\n\nPlease arrive at least 30 minutes early, carry your student ID, and present it at the examination hall. Check the portal {{portal}} for any updates.\n\nBest wishes for your exams!\n{{school}}', category: 'academic' },
        { id: 'tpl-event', name: '📢 Event Notification', message: 'Dear {{name}} ({{admission}}),\n\nYou are warmly invited to:\n📌 {{event}}\n📅 Date: {{date}}\n⏰ Time: {{time}}\n📍 Venue: {{venue}}\n\nAs a student of the {{program}} program, your presence matters. We look forward to seeing you there. More details at {{portal}}\n\n{{school}}', category: 'general' },
        { id: 'tpl-welcome', name: '👋 Welcome Message', message: 'Welcome to {{school}}, {{name}}! 🎓\n\nWe are excited to have you in our {{program}} program at {{center}} ({{centerCode}}, {{region}}).\n\nYour registration was received on {{requested}} and has now been approved. Here are your login details:\n🔑 Username: {{login}}\n🔒 Password: {{admission}}\n\nLog in to the student portal at {{portal}} to access your courses, quizzes, and more.\n\nKeep your admission number safe — you will need it throughout your studies.\n\nMay God bless your studies and may this be a transformative season in your life.\n\n— {{school}} Administration', category: 'general' },
        { id: 'tpl-graduation', name: '🎓 Graduation Notice', message: 'Dear {{name}} ({{admission}}),\n\nCongratulations! 🎉 You have been cleared for graduation from the {{program}} program at {{center}}.\n\n📅 Ceremony Date: {{date}}\n📍 Venue: {{venue}}\n\nPlease confirm your attendance at the Registrar\'s office before the deadline and bring your student ID. Check {{portal}} for graduation updates.\n\nWe are proud of your achievement. God bless you.\n{{school}}', category: 'general' },
        { id: 'tpl-inactivity1', name: '⏰ Inactivity Warning 1', message: 'Dear {{name}} ({{admission}}),\n\nWe noticed you haven\'t logged in to your {{school}} student account for 20 working days. Your account is still active, but we encourage you to log in soon to stay on track with the {{program}} program.\n\nYour login username is {{login}}. Please log in at {{portal}} to access your courses and stay updated.\n\nIf you\'re experiencing difficulties, please reach out to administration at {{center}}.\n\n{{school}}', category: 'academic' },
        { id: 'tpl-inactivity2', name: '🔒 Inactivity Warning 2', message: 'Dear {{name}} ({{admission}}),\n\nURGENT: Your {{school}} account will be LOCKED in 3 working days due to inactivity (27 working days without login).\n\nPlease log in immediately using username {{login}} at {{portal}} to keep your account active and protect your progress in the {{program}} program.\n\nContact {{school}} Administration at {{center}} for assistance.\n\n{{school}}', category: 'academic' }
    ];
    for (const dt of defaultTemplates) {
        if (!templates.find(t => t.id === dt.id)) await dbPut('whatsappTemplates', dt);
    }
    const allTemplates = await dbGetAll('whatsappTemplates');
    const categories = {};
    allTemplates.forEach(t => {
        const cat = t.category || 'general';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(t);
    });
    let html = '';
    for (const [cat, temps] of Object.entries(categories)) {
        html += `<div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin:8px 0 4px;">${cat}</div>`;
        html += temps.map(t => `<div class="whatsapp-template" onclick="openQuickSend('${t.id}')"><b>${t.name}</b><br><span style="font-size:11px;color:var(--text-muted);">${t.message.substring(0, 70)}...</span><div style="display:flex;gap:4px;margin-top:6px;"><button class="btn btn-outline btn-xs" onclick="event.stopPropagation();editTemplate('${t.id}')">✏ Edit</button><button class="btn btn-danger btn-xs" onclick="event.stopPropagation();deleteTemplate('${t.id}')">🗑 Delete</button></div></div>`).join('');
    }
    document.getElementById('whatsapp-templates').innerHTML = html;
}

async function openQuickSend(templateId) {
    const template = await dbGet('whatsappTemplates', templateId);
    if (!template) return;
    const students = await dbGetAll('students');
    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College Management System';

    const content = `<div id="quick-send-panel">
        <div style="display:flex;gap:8px;margin-bottom:12px;">
            <div style="flex:1;"><label style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Template</label><div style="padding:6px 10px;background:var(--bg-input);border-radius:4px;font-size:12px;font-weight:600;">${template.name}</div></div>
            <div style="width:120px;"><label style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Recipients</label><select id="qs-recipients" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-card);color:var(--text);font-size:12px;"><option value="all-active">All Active</option><option value="all">All Students</option><option value="with-balance">With Balance</option><option value="selected">Selected</option></select></div>
        </div>
        <div id="qs-student-select" style="display:none;margin-bottom:12px;"><label style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Student</label><select id="qs-student" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-card);color:var(--text);font-size:12px;">${students.map(s => `<option value="${s.id}">${s.name} ${s.admissionNumber ? '(' + s.admissionNumber + ')' : ''}</option>`).join('')}</select></div>
        <div class="form-group"><label>Message Preview</label><textarea id="qs-message" rows="5" style="font-size:12px;">${template.message}</textarea></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
            <button class="btn btn-outline btn-sm" onclick="previewQSMessage()">👁 Preview</button>
            <button class="btn btn-outline btn-sm" onclick="copyQSMessage()">📋 Copy</button>
        </div>
        <div id="qs-preview-area" style="display:none;padding:10px;background:var(--bg-input);border-radius:6px;margin-bottom:12px;font-size:12px;white-space:pre-line;"></div>
    </div>`;
    showModal('Quick Send — ' + template.name, content, `<button class="btn btn-success" onclick="startQSQueue('${templateId}')">🚀 Start Broadcast</button>`);

    document.getElementById('qs-recipients').addEventListener('change', function() {
        document.getElementById('qs-student-select').style.display = this.value === 'selected' ? 'block' : 'none';
    });
}

async function previewQSMessage() {
    const msg = document.getElementById('qs-message').value;
    const recipients = document.getElementById('qs-recipients').value;
    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College Management System';
    let preview = msg;

    if (recipients === 'selected') {
        const studentId = document.getElementById('qs-student').value;
        const s = await dbGet('students', studentId);
        if (s) {
            const payments = await dbGetAll('payments');
            const paid = payments.filter(p => p.studentId === s.id).reduce((sum, p) => sum + p.amount, 0);
            const balance = getCachedStudentFee(s) - paid;
            preview = applyTemplateVars(msg, s, schoolName, balance, s.admissionNumber, s.phone);
        }
    } else {
        preview = msg.replace(/{{name}}/g, 'John Doe').replace(/{{school}}/g, schoolName).replace(/{{program}}/g, 'Theology').replace(/{{balance}}/g, 'KES 15,000.00')
            .replace(/{{admission}}/g, 'NET-2026-0001').replace(/{{admissionNumber}}/g, 'NET-2026-0001')
            .replace(/{{phone}}/g, '254712345678').replace(/{{username}}/g, '254712345678').replace(/{{login}}/g, '254712345678')
            .replace(/{{password}}/g, 'NET-2026-0001').replace(/{{email}}/g, 'john@example.com').replace(/{{year}}/g, '1')
            .replace(/{{region}}/g, 'Coast Region').replace(/{{center}}/g, 'Mombasa Center').replace(/{{centerCode}}/g, 'MSA')
            .replace(/{{requested}}/g, '01 Jul 2026').replace(/{{fee}}/g, 'KES 25,000.00')
            .replace(/{{min}}/g, '75').replace(/{{type}}/g, 'Final').replace(/{{event}}/g, 'Graduation').replace(/{{course}}/g, 'Theology').replace(/{{date}}/g, '15 Aug 2026').replace(/{{time}}/g, '9:00 AM').replace(/{{venue}}/g, 'Main Hall');
    }

    const area = document.getElementById('qs-preview-area');
    area.textContent = preview;
    area.style.display = 'block';
}

async function startQSQueue(templateId) {
    const template = await dbGet('whatsappTemplates', templateId);
    const message = document.getElementById('qs-message').value.trim();
    if (!message) return showToast('Message required!');

    const recipients = document.getElementById('qs-recipients').value;
    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College Management System';
    let targets = [];

    if (recipients === 'selected') {
        const studentId = document.getElementById('qs-student').value;
        const student = await dbGet('students', studentId);
        if (student && student.phone) targets = [student];
    } else if (recipients === 'with-balance') {
        const payments = await dbGetAll('payments');
        targets = (await dbGetAll('students')).filter(s => s.phone && s.status === 'active' && getCachedStudentFee(s) - payments.filter(p => p.studentId === s.id).reduce((sum, p) => sum + p.amount, 0) > 0);
    } else {
        const filter = recipients === 'all-active' ? 'active' : '';
        targets = (await dbGetAll('students')).filter(s => s.phone && (!filter || s.status === filter));
    }

    if (!targets.length) return showToast('No recipients with phone numbers!');

    closeModal();
    await buildBroadcastQueue(targets, template, message, schoolName);
}

async function buildBroadcastQueue(targets, template, message, schoolName) {
    waQueue = [];
    waQueueIndex = 0;
    waSentCount = 0;
    waFailedCount = 0;
    waQueueRunning = false;

    const payments = await dbGetAll('payments');
    for (const s of targets) {
        waQueue.push({ student: s, message, template: template.name, payments });
    }

    showBroadcastPanel();
}

async function showBroadcastPanel() {
    const total = waQueue.length;
    const current = waQueue[waQueueIndex];
    if (!current) {
        showToast(`Broadcast complete! Sent: ${waSentCount}, Failed: ${waFailedCount}`);
        renderWhatsAppLog();
        return;
    }

    const s = current.student;
    const payments = current.payments || await dbGetAll('payments');
    const paid = payments.filter(p => p.studentId === s.id).reduce((sum, p) => sum + p.amount, 0);
    const balance = getCachedStudentFee(s) - paid;
    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College Management System';
    const resolvedMsg = applyTemplateVars(current.message, s, schoolName, balance, s.admissionNumber, s.phone);
    const formattedPhone = formatWhatsAppPhone(s.phone);

    const progress = ((waQueueIndex) / total * 100).toFixed(0);
    const html = `<div id="broadcast-panel">
        <div class="broadcast-header">
            <div class="broadcast-title">📱 WhatsApp Broadcast</div>
            <div class="broadcast-progress-info">${waQueueIndex + 1} of ${total}</div>
        </div>
        <div class="broadcast-progress-bar"><div class="broadcast-progress-fill" style="width:${progress}%"></div></div>
        <div class="broadcast-recipient">
            <div class="broadcast-recipient-name">${s.name}</div>
            <div class="broadcast-recipient-phone">${s.phone} → ${formattedPhone}</div>
            ${balance > 0 ? `<div class="broadcast-recipient-balance">Balance: ${formatCurrency(balance)}</div>` : '<div style="font-size:11px;color:var(--success);">✓ Fees Cleared</div>'}
        </div>
        <div class="broadcast-message-preview">${escapeHtml(resolvedMsg).replace(/\n/g, '<br>')}</div>
        <div class="broadcast-actions">
            <button class="btn-copy" onclick="copyBroadcastMessage()">📋 Copy</button>
            <button class="btn-send" id="btn-wa-send" onclick="sendNextWhatsApp()">🚀 Send via WhatsApp</button>
        </div>
        <div class="broadcast-controls">
            <label class="broadcast-auto-label"><input type="checkbox" id="broadcast-auto" onchange="toggleAutoAdvance()"> Auto-Advance</label>
            <select id="broadcast-speed" onchange="changeBroadcastSpeed()" style="padding:3px 6px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);font-size:11px;"><option value="1000">Fast (1s)</option><option value="2000" selected>Normal (2s)</option><option value="4000">Slow (4s)</option></select>
            <button class="btn-skip" onclick="skipBroadcastRecipient()">Skip →</button>
            <button class="btn-stop" onclick="stopBroadcast()">■ Stop</button>
        </div>
        <div class="broadcast-stats">
            <span class="stat-sent">✓ Sent: ${waSentCount}</span>
            <span class="stat-failed">✗ Failed: ${waFailedCount}</span>
            <span class="stat-remaining">⏳ Remaining: ${total - waQueueIndex}</span>
        </div>
        <div style="font-size:10px;color:var(--text-muted);text-align:center;margin-top:8px;">Press <kbd>Space</kbd> to send & advance · <kbd>Esc</kbd> to stop · <kbd>C</kbd> to copy</div>
    </div>
    <style>
        #broadcast-panel { font-family: 'Segoe UI', Arial, sans-serif; max-width: 500px; margin: 0 auto; }
        .broadcast-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
        .broadcast-title { font-size:14px; font-weight:700; color:var(--accent); }
        .broadcast-progress-info { font-size:12px; font-weight:700; color:var(--text); }
        .broadcast-progress-bar { height:6px; background:var(--bg-input); border-radius:3px; overflow:hidden; margin-bottom:12px; }
        .broadcast-progress-fill { height:100%; background:linear-gradient(90deg, var(--accent), var(--success)); border-radius:3px; transition: width 0.3s ease; }
        .broadcast-recipient { padding:12px; background:var(--bg-input); border-radius:8px; margin-bottom:12px; }
        .broadcast-recipient-name { font-size:16px; font-weight:700; color:var(--text); }
        .broadcast-recipient-phone { font-size:12px; color:var(--text-muted); margin-top:2px; font-family: monospace; }
        .broadcast-recipient-balance { font-size:12px; color:var(--warning); font-weight:600; margin-top:2px; }
        .broadcast-message-preview { padding:10px; background:var(--bg-card); border:1px solid var(--border); border-radius:6px; margin-bottom:12px; font-size:12px; color:var(--text-secondary); max-height:120px; overflow-y:auto; line-height:1.6; }
        .broadcast-actions { display:flex; gap:8px; margin-bottom:12px; }
        .btn-copy, .btn-send { flex:1; padding:12px; border:none; border-radius:8px; font-size:14px; font-weight:700; cursor:pointer; transition:all 0.2s; }
        .btn-copy { background:var(--bg-input); color:var(--text); border:1px solid var(--border); }
        .btn-copy:hover { background:var(--bg-hover); }
        .btn-send { background:#25D366; color:#fff; }
        .btn-send:hover { background:#128C7E; }
        .broadcast-controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:12px; padding:8px; background:var(--bg-input); border-radius:6px; }
        .broadcast-auto-label { font-size:12px; color:var(--text); display:flex; align-items:center; gap:4px; cursor:pointer; }
        .btn-skip, .btn-stop { padding:6px 12px; border:none; border-radius:4px; font-size:11px; font-weight:600; cursor:pointer; }
        .btn-skip { background:var(--bg-card); color:var(--text-secondary); border:1px solid var(--border); }
        .btn-stop { background:var(--danger); color:#fff; }
        .broadcast-stats { display:flex; gap:16px; justify-content:center; font-size:12px; font-weight:600; }
        .stat-sent { color:var(--success); }
        .stat-failed { color:var(--danger); }
        .stat-remaining { color:var(--warning); }
        kbd { display:inline-block; padding:2px 6px; background:var(--bg-input); border:1px solid var(--border); border-radius:3px; font-size:10px; font-family:monospace; color:var(--text-secondary); }
    </style>`;

    document.getElementById('modal-overlay').classList.add('active');
    document.getElementById('modal-content').innerHTML = `
        <div class="modal-header"><h3>Broadcast Queue</h3><button class="modal-close" onclick="stopBroadcast()">&times;</button></div>
        <div class="modal-body">${html}</div>
    `;

    document.getElementById('broadcast-keydown')?.removeEventListener('keydown', handleBroadcastKeydown);
    document.addEventListener('keydown', handleBroadcastKeydown);
}

function handleBroadcastKeydown(e) {
    if (!document.getElementById('broadcast-panel')) return;
    if (e.code === 'Space') { e.preventDefault(); sendNextWhatsApp(); }
    else if (e.code === 'Escape') { e.preventDefault(); stopBroadcast(); }
    else if (e.code === 'KeyC' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); copyBroadcastMessage(); }
}

function toggleAutoAdvance() {
    waQueueAutoAdvance = document.getElementById('broadcast-auto').checked;
}

function changeBroadcastSpeed() {
    waQueueDelay = parseInt(document.getElementById('broadcast-speed').value);
}

async function copyBroadcastMessage() {
    if (waQueueIndex >= waQueue.length) return;
    const current = waQueue[waQueueIndex];
    const s = current.student;
    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College Management System';
    const payments = await dbGetAll('payments');
    const paid = payments.filter(p => p.studentId === s.id).reduce((sum, p) => sum + p.amount, 0);
    const balance = getCachedStudentFee(s) - paid;
    const msg = applyTemplateVars(current.message, s, schoolName, balance, s.admissionNumber, s.phone);

    try {
        await navigator.clipboard.writeText(msg);
        showToast('Message copied to clipboard!');
    } catch {
        const ta = document.createElement('textarea');
        ta.value = msg;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Message copied!');
    }
}

function sendNextWhatsApp() {
    if (waQueueIndex >= waQueue.length) {
        showToast(`Broadcast complete! Sent: ${waSentCount}, Failed: ${waFailedCount}`);
        stopBroadcast();
        renderWhatsAppLog();
        return;
    }

    const current = waQueue[waQueueIndex];
    const s = current.student;
    if (!s.phone) {
        waFailedCount++;
        waQueueIndex++;
        showBroadcastPanel();
        if (waQueueAutoAdvance) setTimeout(() => sendNextWhatsApp(), waQueueDelay);
        return;
    }

    dbGet('settings', 'branding').then(async (branding) => {
        const schoolName = branding ? branding.schoolName : 'College Management System';
        const payments = current.payments || await dbGetAll('payments');
        const paid = payments.filter(p => p.studentId === s.id).reduce((sum, p) => sum + p.amount, 0);
        const balance = getCachedStudentFee(s) - paid;
        const msg = applyTemplateVars(current.message, s, schoolName, balance, s.admissionNumber, s.phone);

        sendWhatsApp(s.phone, msg);
        waSentCount++;

        const entry = { id: 'WA-' + Date.now(), phone: s.phone, name: s.name, message: msg.substring(0, 200), date: new Date().toISOString().split('T')[0], time: new Date().toLocaleTimeString(), template: current.template, status: 'sent', createdAt: new Date().toISOString() };
        try { await dbAdd('whatsappLog', entry); } catch (e) {}

        waQueueIndex++;

        if (waQueueIndex >= waQueue.length) {
            showToast(`Broadcast complete! Sent: ${waSentCount}, Failed: ${waFailedCount}`);
            stopBroadcast();
            renderWhatsAppLog();
            return;
        }

        if (waQueueAutoAdvance) {
            setTimeout(() => showBroadcastPanel(), 500);
            setTimeout(() => sendNextWhatsApp(), waQueueDelay + 500);
        } else {
            showBroadcastPanel();
        }
    });
}

function skipBroadcastRecipient() {
    waQueueIndex++;
    if (waQueueIndex >= waQueue.length) {
        showToast(`Broadcast complete! Sent: ${waSentCount}, Failed: ${waFailedCount}`);
        stopBroadcast();
        renderWhatsAppLog();
        return;
    }
    showBroadcastPanel();
    if (waQueueAutoAdvance) setTimeout(() => sendNextWhatsApp(), waQueueDelay);
}

function stopBroadcast() {
    waQueueRunning = false;
    waQueueAutoAdvance = false;
    document.removeEventListener('keydown', handleBroadcastKeydown);
    if (waQueueIndex < waQueue.length) {
        showToast(`Broadcast stopped. Sent: ${waSentCount}, Failed: ${waFailedCount}, Remaining: ${waQueue.length - waQueueIndex}`);
    }
    closeModal();
    renderWhatsAppLog();
}

async function sendWhatsAppBroadcast(targets, template, message, schoolName) {
    waQueue = targets.map(s => ({ student: s, message, template: template.name }));
    waQueueIndex = 0;
    waSentCount = 0;
    waFailedCount = 0;
    waQueueRunning = true;
    showBroadcastPanel();
}

async function quickWhatsAppStudent(studentId, templateId) {
    const student = await dbGet('students', studentId);
    if (!student || !student.phone) return showToast('Student has no phone number!');

    let template, message;
    if (templateId) {
        template = await dbGet('whatsappTemplates', templateId);
        message = template ? template.message : 'Hello {{name}}!';
    } else {
        template = { name: 'Custom' };
        message = 'Hello {{name}}, this is a message from the college.';
    }

    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College Management System';
    const payments = await dbGetAll('payments');
    const paid = payments.filter(p => p.studentId === student.id).reduce((sum, p) => sum + p.amount, 0);
    const balance = getCachedStudentFee(student) - paid;
    const resolvedMsg = applyTemplateVars(message, student, schoolName, balance, student.admissionNumber, student.phone);

    sendWhatsApp(student.phone, resolvedMsg);

    const entry = { id: 'WA-' + Date.now(), phone: student.phone, name: student.name, message: resolvedMsg.substring(0, 200), date: new Date().toISOString().split('T')[0], time: new Date().toLocaleTimeString(), template: template.name, status: 'sent', createdAt: new Date().toISOString() };
    try { await dbAdd('whatsappLog', entry); } catch (e) {}

    showToast(`Message sent to ${student.name}`);
    renderWhatsAppLog();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function showTemplateForm() {
    const content = `<div class="form-group"><label>Template Name *</label><input type="text" id="tpl-name" placeholder="e.g., Fee Reminder"></div><div class="form-group"><label>Category</label><select id="tpl-category"><option value="finance">💰 Finance</option><option value="academic">📚 Academic</option><option value="general">📢 General</option></select></div><div class="form-group"><label>Message *</label><textarea id="tpl-message" rows="5"></textarea></div><p style="font-size:11px;color:var(--text-muted);">Variables: {{name}}, {{admission}}, {{program}}, {{center}}, {{centerCode}}, {{region}}, {{school}}, {{balance}}, {{fee}}, {{phone}}, {{login}}, {{email}}, {{year}}, {{requested}}, {{portal}}</p>`;


    showModal('Add Template', content, `<button class="btn btn-primary" onclick="saveTemplate()">Save</button>`);
}

async function saveTemplate() {
    const name = document.getElementById('tpl-name').value.trim();
    const message = document.getElementById('tpl-message').value.trim();
    const category = document.getElementById('tpl-category').value;
    if (!name || !message) return showToast('Name and message required!');
    await dbPut('whatsappTemplates', { id: 'tpl-' + Date.now(), name, message, category });
    closeModal();
    renderWhatsAppTemplates();
    showToast('Template saved!');
}

async function renderWhatsAppLog() {
    const log = (await dbGetAll('whatsappLog')).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100);
    document.getElementById('whatsapp-log').innerHTML = log.length ? log.map(e => `<div class="whatsapp-log-entry"><span style="font-weight:600;">${e.date} ${e.time}</span> <span class="badge badge-success" style="font-size:9px;">${e.template || 'custom'}</span><br>→ ${e.name || e.phone} <span style="font-size:10px;color:var(--text-muted);">(${e.phone})</span><br><span style="font-size:11px;color:var(--text-muted);">${e.message}</span><div style="margin-top:4px;"><button class="btn btn-xs btn-outline" onclick="retryWhatsAppLog('${e.phone}', \`${e.message.replace(/`/g, '\\`')}\`)">↻ Resend</button></div></div>`).join('') : '<div style="color:var(--text-muted);text-align:center;padding:20px;">No messages sent yet</div>';
}

async function retryWhatsAppLog(phone, message) {
    if (!phone || !message) return showToast('Invalid log entry');
    sendWhatsApp(phone, message);
    showToast('Message resent');
}

async function sendBulkWhatsApp(target = 'students') {
    const u = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    if (u.role === 'student') return showToast('Access denied.', { type: 'danger' });
    const students = target === 'alumni' ? await dbGetAll('alumni') : await dbGetAll('students');
    const templates = await dbGetAll('whatsappTemplates');
    const content = `<div class="form-row"><div class="form-group"><label>Recipients</label><select id="bulk-recipients"><option value="all">${target === 'alumni' ? 'All Alumni' : 'All Active Students'}</option>${target === 'students' ? '<option value="with-balance">Students with Balance</option><option value="all-students">All Students</option>' : ''}</select></div><div class="form-group"><label>Template (Optional)</label><select id="bulk-template"><option value="">Custom Message</option>${templates.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}</select></div></div><div class="form-group"><label>Message</label><textarea id="bulk-message" rows="4" placeholder="Type your message... Use {{name}}, {{balance}}, {{school}} as variables"></textarea></div><div style="font-size:11px;color:var(--text-muted);">This opens a broadcast panel where you can send to each recipient one-by-one</div>`;
    showModal('Broadcast WhatsApp', content, `<button class="btn btn-success" onclick="startBulkBroadcast('${target}')">📱 Start Broadcast</button>`);

    document.getElementById('bulk-template').addEventListener('change', async function() {
        if (this.value) {
            const tpl = await dbGet('whatsappTemplates', this.value);
            if (tpl) document.getElementById('bulk-message').value = tpl.message;
        }
    });
}

async function startBulkBroadcast(target) {
    const message = document.getElementById('bulk-message').value.trim();
    if (!message) return showToast('Message required!');

    const recipients = document.getElementById('bulk-recipients').value;
    const templateId = document.getElementById('bulk-template').value;
    let template = { name: 'Broadcast' };
    if (templateId) {
        template = await dbGet('whatsappTemplates', templateId) || template;
    }

    let targets = [];
    if (target === 'alumni') {
        targets = await dbGetAll('alumni');
    } else if (recipients === 'with-balance') {
        const payments = await dbGetAll('payments');
        const students = await dbGetAll('students');
        targets = students.filter(s => { const paid = payments.filter(p => p.studentId === s.id).reduce((sum, p) => sum + p.amount, 0); return getCachedStudentFee(s) - paid > 0; });
    } else if (recipients === 'all-students') {
        targets = await dbGetAll('students');
    } else {
        targets = (await dbGetAll('students')).filter(s => s.status === 'active');
    }

    targets = targets.filter(t => t.phone);
    if (!targets.length) return showToast('No recipients with phone numbers!');

    closeModal();
    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College Management System';
    sendWhatsAppBroadcast(targets, template, message, schoolName);
}

async function editTemplate(templateId) {
    const tpl = await dbGet('whatsappTemplates', templateId);
    if (!tpl) return;
    const content = `<div class="form-group"><label>Template Name *</label><input type="text" id="tpl-edit-name" value="${escapeHtml(tpl.name)}"></div><div class="form-group"><label>Category</label><select id="tpl-edit-category"><option value="finance" ${tpl.category==='finance'?'selected':''}>💰 Finance</option><option value="academic" ${tpl.category==='academic'?'selected':''}>📚 Academic</option><option value="general" ${tpl.category==='general'?'selected':''}>📢 General</option></select></div><div class="form-group"><label>Message *</label><textarea id="tpl-edit-message" rows="6">${escapeHtml(tpl.message)}</textarea></div><p style="font-size:11px;color:var(--text-muted);">Variables: {{name}}, {{admission}}, {{program}}, {{center}}, {{centerCode}}, {{region}}, {{school}}, {{balance}}, {{fee}}, {{phone}}, {{login}}, {{email}}, {{year}}, {{requested}}, {{portal}}</p>`;
    showModal('Edit Template — ' + tpl.name, content, `<button class="btn btn-primary" onclick="saveTemplateEdit('${templateId}')">Save Changes</button>`);
}

async function saveTemplateEdit(templateId) {
    const name = document.getElementById('tpl-edit-name').value.trim();
    const message = document.getElementById('tpl-edit-message').value.trim();
    const category = document.getElementById('tpl-edit-category').value;
    if (!name || !message) return showToast('Name and message required!');
    await dbPut('whatsappTemplates', { id: templateId, name, message, category });
    logAudit('updated', 'whatsappTemplate', { id: templateId, name, message });
    closeModal();
    renderWhatsAppTemplates();
    showToast('Template updated!');
}

async function deleteTemplate(templateId) {
    if (!await showConfirm('Delete Template', 'Remove this template permanently?')) return;
    await dbDelete('whatsappTemplates', templateId);
    logAudit('deleted', 'whatsappTemplate', { id: templateId });
    renderWhatsAppTemplates();
    showToast('Template deleted.');
}

// Communication Center — Admin only
// Drop this file in js/ and include via <script src="js/communication.js"></script>
// Then call loadCommunicationPage() from your router/nav.

async function loadCommunicationPage() {
    const u = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    if (u.role !== 'admin') return showToast('Admin only.', { type: 'danger' });

    const [students, centers, programs, templates] = await Promise.all([
        dbGetAll('students'),
        dbGetAll('studyCenters'),
        getProgramsList(),
        dbGetAll('whatsappTemplates')
    ]);

    const activeStudents = students.filter(s => s.status === 'active' && s.phone);

    const centerOptions = centers.map(c => `<option value="${c.id}">${escapeHtml(c.name)} (${c.code})</option>`).join('');
    const programOptions = programs.map(p => `<option value="${p}">${escapeHtml(p)}</option>`).join('');
    const templateOptions = templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');

    document.getElementById('communication-content').innerHTML = `
        <div class="page-header">
            <h2>📱 Communication Center</h2>
            <p style="color:var(--text-muted);font-size:13px;">Filter students, compose a message, and send via WhatsApp (individual or bulk).</p>
        </div>

        <div class="card" style="margin-bottom:16px;">
            <div class="card-header"><b>Filters</b></div>
            <div class="card-body" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;">
                <div class="form-group" style="flex:1;min-width:180px;">
                    <label>Study Center</label>
                    <select id="comm-center" class="form-control"><option value="">All Centers</option>${centerOptions}</select>
                </div>
                <div class="form-group" style="flex:1;min-width:180px;">
                    <label>Program</label>
                    <select id="comm-program" class="form-control"><option value="">All Programs</option>${programOptions}</select>
                </div>
                <div class="form-group" style="flex:1;min-width:180px;">
                    <label>Course</label>
                    <select id="comm-course" class="form-control"><option value="">All Courses</option></select>
                </div>
                <div class="form-group" style="flex:1;min-width:200px;">
                    <label>Search</label>
                    <input type="text" id="comm-search" class="form-control" placeholder="Name, phone, admission..." oninput="debounceCommSearch()">
                </div>
                <button class="btn btn-primary" onclick="applyCommFilters()" style="height:38px;">🔍 Apply</button>
                <button class="btn btn-outline" onclick="clearCommFilters()" style="height:38px;">✖ Clear</button>
            </div>
        </div>

        <div class="card" style="margin-bottom:16px;">
            <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;">
                <b>Message</b>
                <select id="comm-template" class="form-control" style="width:auto;min-width:220px;" onchange="loadCommTemplate()">
                    <option value="">— Select Template —</option>${templateOptions}
                </select>
            </div>
            <div class="card-body">
                <div class="form-group"><label>Message (variables: {{name}}, {{admission}}, {{phone}}, {{program}}, {{school}}, {{balance}}, {{email}})</label>
                    <textarea id="comm-message" rows="4" class="form-control" style="font-family:monospace;font-size:13px;"></textarea>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button class="btn btn-outline" onclick="previewCommMessage()">👁 Preview</button>
                    <button class="btn btn-outline" onclick="copyCommMessage()">📋 Copy</button>
                    <button class="btn btn-outline" onclick="openVariablePicker('comm-message')">🔤 Variables</button>
                    <span id="comm-preview-count" style="align-self:center;font-size:12px;color:var(--text-muted);"></span>
                </div>
                <div id="comm-preview-area" style="display:none;margin-top:10px;padding:10px;background:var(--bg-input);border-radius:6px;font-size:12px;white-space:pre-line;"></div>
            </div>
        </div>

        <div class="card">
            <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;">
                <b>Recipients (<span id="comm-recipient-count">0</span>)</b>
                <div style="display:flex;gap:8px;">
                    <button class="btn btn-success" onclick="sendCommBulk()">📤 Send to All (Bulk)</button>
                </div>
            </div>
            <div class="card-body" style="padding:0;overflow-x:auto;">
                <table class="data-table" style="min-width:700px;">
                    <thead>
                        <tr>
                            <th style="width:40px;"><input type="checkbox" id="comm-select-all" onchange="toggleCommSelectAll()"></th>
                            <th>Name</th>
                            <th>Admission No.</th>
                            <th>Program</th>
                            <th>Center</th>
                            <th>Phone</th>
                            <th>Balance</th>
                            <th style="width:90px;">Action</th>
                        </tr>
                    </thead>
                    <tbody id="comm-student-body"></tbody>
                </table>
            </div>
        </div>
    `;

    // Populate courses based on selected program
    document.getElementById('comm-program').addEventListener('change', async function() {
        const program = this.value;
        const courseSelect = document.getElementById('comm-course');
        if (!program) {
            courseSelect.innerHTML = '<option value="">All Courses</option>';
            return;
        }
        const courses = await getCoursesForProgram(program);
        courseSelect.innerHTML = '<option value="">All Courses</option>' + courses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    });

    // Initial render
    applyCommFilters();
}

// Filter & render student table
async function applyCommFilters() {
    const centerId = document.getElementById('comm-center').value;
    const program = document.getElementById('comm-program').value;
    const courseId = document.getElementById('comm-course').value;
    const search = document.getElementById('comm-search').value.toLowerCase();

    let students = await dbGetAll('students');
    students = students.filter(s => s.status === 'active' && s.phone);

    if (centerId) students = students.filter(s => s.studyCenterId === centerId);
    if (program) students = students.filter(s => s.program === program);
    if (courseId) {
        const enrollments = await dbGetAll('enrollments');
        const enrolledIds = enrollments.filter(e => e.courseId === courseId).map(e => e.studentId);
        students = students.filter(s => enrolledIds.includes(s.id));
    }
    if (search) students = students.filter(s => 
        s.name.toLowerCase().includes(search) ||
        s.phone.includes(search) ||
        (s.admissionNumber || '').toLowerCase().includes(search)
    );

    const payments = await dbGetAll('payments');
    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College';
    const centers = await dbGetAll('studyCenters');

    const tbody = document.getElementById('comm-student-body');
    tbody.innerHTML = students.map(s => {
        const center = centers.find(c => c.id === s.studyCenterId);
        const paid = payments.filter(p => p.studentId === s.id).reduce((sum, p) => sum + p.amount, 0);
        const balance = getCachedStudentFee(s) - paid;
        return `<tr data-id="${s.id}">
            <td><input type="checkbox" class="comm-row-check" value="${s.id}"></td>
            <td><b>${escapeHtml(s.name)}</b></td>
            <td>${escapeHtml(s.admissionNumber || '--')}</td>
            <td>${escapeHtml(s.program || '--')}</td>
            <td>${center ? escapeHtml(center.name) : '--'}</td>
            <td>${escapeHtml(s.phone)}</td>
            <td>${balance > 0 ? '<span style="color:var(--danger);font-weight:600;">' + formatCurrency(balance) + '</span>' : '<span style="color:var(--success);">Cleared</span>'}</td>
            <td><button class="btn btn-sm btn-primary" onclick="sendCommSingle('${s.id}')">Send</button></td>
        </tr>`;
    }).join('');

    document.getElementById('comm-recipient-count').textContent = students.length;
    document.getElementById('comm-select-all').checked = false;
    updateCommPreviewCount();
}

function clearCommFilters() {
    document.getElementById('comm-center').value = '';
    document.getElementById('comm-program').value = '';
    document.getElementById('comm-course').innerHTML = '<option value="">All Courses</option>';
    document.getElementById('comm-search').value = '';
    document.getElementById('comm-template').value = '';
    document.getElementById('comm-message').value = '';
    document.getElementById('comm-preview-area').style.display = 'none';
    applyCommFilters();
}

var commSearchTimer;
function debounceCommSearch() {
    clearTimeout(commSearchTimer);
    commSearchTimer = setTimeout(applyCommFilters, 200);
}

// Template loading
async function loadCommTemplate() {
    const tplId = document.getElementById('comm-template').value;
    if (!tplId) return;
    const tpl = await dbGet('whatsappTemplates', tplId);
    if (tpl) {
        document.getElementById('comm-message').value = tpl.message;
        updateCommPreviewCount();
    }
}

// Preview / copy
async function previewCommMessage() {
    const msg = document.getElementById('comm-message').value;
    const checked = Array.from(document.querySelectorAll('.comm-row-check:checked')).map(cb => cb.value);
    const students = await dbGetAll('students');
    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College';
    const payments = await dbGetAll('payments');

    let preview = '';
    if (checked.length) {
        const s = students.find(st => st.id === checked[0]);
        if (s) {
            const paid = payments.filter(p => p.studentId === s.id).reduce((sum, p) => sum + p.amount, 0);
            const balance = getCachedStudentFee(s) - paid;
            preview = applyTemplateVars(msg, s, schoolName, balance, s.admissionNumber, s.phone);
        }
    } else {
        preview = msg.replace(/{{name}}/g, 'John Doe').replace(/{{school}}/g, schoolName).replace(/{{program}}/g, 'Theology').replace(/{{admission}}/g, 'INST/GEN/01-24/001').replace(/{{admissionNumber}}/g, 'INST/GEN/01-24/001').replace(/{{phone}}/g, '2547XXXXXXXX').replace(/{{username}}/g, '2547XXXXXXXX').replace(/{{login}}/g, '2547XXXXXXXX').replace(/{{password}}/g, 'INST/GEN/01-24/001').replace(/{{balance}}/g, 'KES 15,000.00').replace(/{{email}}/g, 'student@example.com').replace(/{{year}}/g, '1').replace(/{{region}}/g, 'Coast Region').replace(/{{center}}/g, 'Mombasa Center').replace(/{{centerCode}}/g, 'MSA').replace(/{{requested}}/g, '01 Jul 2026').replace(/{{fee}}/g, 'KES 25,000.00').replace(/{{min}}/g, '75');
    }

    const area = document.getElementById('comm-preview-area');
    area.textContent = preview;
    area.style.display = 'block';
}

function copyCommMessage() {
    const msg = document.getElementById('comm-message').value;
    navigator.clipboard.writeText(msg).then(() => showToast('Copied!')).catch(() => showToast('Copy failed'));
}

function updateCommPreviewCount() {
    const checked = document.querySelectorAll('.comm-row-check:checked').length;
    const total = document.querySelectorAll('.comm-row-check').length;
    const el = document.getElementById('comm-preview-count');
    el.textContent = checked ? `${checked} of ${total} selected` : `${total} recipients`;
}

// Selection
function toggleCommSelectAll() {
    const all = document.getElementById('comm-select-all').checked;
    document.querySelectorAll('.comm-row-check').forEach(cb => cb.checked = all);
    updateCommPreviewCount();
}

document.addEventListener('change', e => {
    if (e.target.classList.contains('comm-row-check')) updateCommPreviewCount();
});

// Single send (uses existing quickWhatsAppStudent logic)
async function sendCommSingle(studentId) {
    const student = await dbGet('students', studentId);
    if (!student || !student.phone) return showToast('No phone number');

    const msg = document.getElementById('comm-message').value.trim();
    if (!msg) return showToast('Compose a message first');

    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College';
    const payments = await dbGetAll('payments');
    const paid = payments.filter(p => p.studentId === student.id).reduce((sum, p) => sum + p.amount, 0);
    const balance = getCachedStudentFee(student) - paid;
    const resolved = applyTemplateVars(msg, student, schoolName, balance, student.admissionNumber, student.phone);

    sendWhatsApp(student.phone, resolved);

    await dbAdd('whatsappLog', {
        id: 'WA-' + Date.now(),
        phone: student.phone,
        name: student.name,
        message: resolved.substring(0, 200),
        date: new Date().toISOString().split('T')[0],
        time: new Date().toLocaleTimeString(),
        template: 'Communication Center',
        status: 'sent',
        createdAt: new Date().toISOString()
    });

    showToast(`Sent to ${student.name}`);
    renderWhatsAppLog();
}

// Bulk send (uses existing sendWhatsAppBroadcast)
async function sendCommBulk() {
    const msg = document.getElementById('comm-message').value.trim();
    if (!msg) return showToast('Compose a message first');

    const checked = Array.from(document.querySelectorAll('.comm-row-check:checked')).map(cb => cb.value);
    let students = await dbGetAll('students');
    students = students.filter(s => s.status === 'active' && s.phone);

    if (checked.length) {
        students = students.filter(s => checked.includes(s.id));
    }

    if (!students.length) return showToast('No recipients');

    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College';
    const template = { name: 'Communication Center' };

    closeModal(); // close any open modal
    sendWhatsAppBroadcast(students, template, msg, schoolName);
}

// Helper: get courses for a program (courses that have students enrolled in this program)
async function getCoursesForProgram(program) {
    const [courses, enrollments, students] = await Promise.all([
        dbGetAll('courses'),
        dbGetAll('enrollments'),
        dbGetAll('students')
    ]);
    const studentIdsInProgram = students.filter(s => s.program === program).map(s => s.id);
    const enrolledCourseIds = new Set(enrollments.filter(e => studentIdsInProgram.includes(e.studentId)).map(e => e.courseId));
    return courses.filter(c => enrolledCourseIds.has(c.id));
}

// Variable picker
function openVariablePicker(targetTextareaId) {
    const vars = ['{{name}}', '{{admission}}', '{{phone}}', '{{program}}', '{{school}}', '{{balance}}', '{{email}}', '{{year}}'];
    const html = vars.map(v => `<button class="btn btn-outline btn-xs" style="margin:2px;" onclick="insertVariable('${targetTextareaId}', '${v}')">${v}</button>`).join('');
    showModal('Insert Variable', `<div style="display:flex;flex-wrap:wrap;gap:4px;">${html}</div>`);
}

function insertVariable(textareaId, variable) {
    const ta = document.getElementById(textareaId);
    const start = ta.selectionStart;
    ta.value = ta.value.slice(0, start) + variable + ta.value.slice(start);
    ta.focus();
    closeModal();
}

// Export for router
window.loadCommunicationPage = loadCommunicationPage;

async function renderPendingRegistrations() {
    const students = await dbGetAll('students');
    const centers = await dbGetAll('studyCenters');
    const pending = students.filter(s => s.status === 'pending');
    const approved = (await dbGetAll('users')).filter(u => u.role === 'student').length;

    document.getElementById('pending-stats').innerHTML = `
        <div class="stat-card"><div class="stat-label">Pending</div><div class="stat-value" style="color:var(--warning)">${pending.length}</div></div>
        <div class="stat-card"><div class="stat-label">Approved Students</div><div class="stat-value" style="color:var(--success)">${approved}</div></div>
    `;

    if (!pending.length) {
        document.getElementById('pending-list').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">No pending registration requests.</div>';
        return;
    }

    let html = '<div class="table-container" style="overflow-x:auto;"><table class="data-table" style="min-width:700px;white-space:nowrap;"><thead><tr><th style="width:30px;">#</th><th>Name</th><th>Phone</th><th>Email</th><th>Program</th><th>Center</th><th>Date</th><th>Actions</th></tr></thead><tbody>';
    pending.forEach((s, i) => {
        const center = centers.find(c => c.id === s.studyCenterId);
        const date = new Date(s.registrationRequestedAt || s.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        html += `<tr>
            <td style="width:30px;">${i + 1}</td>
            <td><b>${escapeHtml(s.name)}</b></td>
            <td>${escapeHtml(s.phone || '')}</td>
            <td>${escapeHtml(s.email || '')}</td>
            <td>${escapeHtml(s.program || '')}</td>
            <td>${center ? escapeHtml(center.name) : '--'}</td>
            <td style="font-size:11px;color:var(--text-muted);white-space:nowrap;">${date}</td>
            <td style="white-space:nowrap;">
                <button class="btn btn-success btn-sm" style="margin:2px;" onclick="openApproveModal('${s.id}')">Approve</button>
                <button class="btn btn-danger btn-sm" style="margin:2px;" onclick="rejectRegistration('${s.id}')">Reject</button>
            </td>
        </tr>`;
    });
    html += '</tbody></table></div>';
    document.getElementById('pending-list').innerHTML = html;
}

async function editRegistration(studentId) {
    const student = await dbGet('students', studentId);
    if (!student) return;
    const centers = await dbGetAll('studyCenters');
    const programs = await getProgramsList();
    const center = centers.find(c => c.id === student.studyCenterId);

    const html = `<div style="padding:4px;">
        <input type="hidden" id="reg-edit-id" value="${student.id}">
        <div class="form-row">
            <div class="form-group"><label>Full Name *</label><input type="text" id="reg-name" value="${escapeHtml(student.name || '')}" required></div>
            <div class="form-group"><label>Phone *</label><input type="text" id="reg-phone" value="${escapeHtml(student.phone || '')}" required></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>Email</label><input type="email" id="reg-email" value="${escapeHtml(student.email || '')}"></div>
            <div class="form-group"><label>Program *</label><select id="reg-program"><option value="">Select...</option>${programs.map(p => `<option value="${p}" ${student.program === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
        </div>
        <div class="form-row">
            <div class="form-group"><label>Study Center</label><select id="reg-center"><option value="">Select...</option>${centers.map(c => `<option value="${c.id}" ${student.studyCenterId === c.id ? 'selected' : ''}>${c.name} (${c.code})</option>`).join('')}</select></div>
            <div class="form-group"><label>Status</label><select id="reg-status"><option value="pending" ${student.status === 'pending' ? 'selected' : ''}>Pending</option><option value="active" ${student.status === 'active' ? 'selected' : ''}>Active</option></select></div>
        </div>
        <div class="form-group"><label>Admission Number</label><input type="text" id="reg-admno" value="${escapeHtml(student.admissionNumber || '')}" placeholder="Auto-generated if empty"></div>
        <div style="margin-top:16px;display:flex;gap:8px;justify-content:center;">
            <button class="btn btn-primary" onclick="saveRegistrationEdit()">Save Changes</button>
            <button class="btn btn-success" onclick="approveRegistration('${student.id}');closeModal();">Approve & Register</button>
            <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        </div>
    </div>`;
    showModal('Edit Registration — ' + student.name, html);
}

async function saveRegistrationEdit() {
    const id = document.getElementById('reg-edit-id').value;
    const student = await dbGet('students', id);
    if (!student) return;

    student.name = sanitizeInput(document.getElementById('reg-name').value.trim());
    student.phone = sanitizeInput(document.getElementById('reg-phone').value.trim());
    student.email = document.getElementById('reg-email').value.trim();
    student.program = document.getElementById('reg-program').value;
    student.studyCenterId = document.getElementById('reg-center').value;
    student.status = document.getElementById('reg-status').value;
    student.admissionNumber = document.getElementById('reg-admno').value.trim();

    await dbPut('students', student);
    closeModal();
    renderPendingRegistrations();
    showToast('Registration updated!', { type: 'success' });
}

// ============================================================================
// UNIFIED APPROVAL WORKFLOW
// ============================================================================
// Step 1: openApproveModal(studentId) — open modal with editable student form
//          + auto-generated admission number + WhatsApp message preview
// Step 2: Admin reviews/edits details, regenerates admission number if needed,
//          adjusts the message, then clicks "Finalize & Send Welcome"
// Step 3: finalizeApproval(studentId) — saves all changes, marks active,
//          creates user account, opens WhatsApp link, shows success state.
//          Admin clicks "Close" to dismiss the modal.
// ============================================================================

var _approvalState;

async function openApproveModal(studentId) {
    if (typeof seedWhatsAppTemplates === 'function') {
        try { await seedWhatsAppTemplates(); } catch (e) { console.warn('Template seed on approval failed:', e); }
    }
    const student = await dbGet('students', studentId);
    if (!student) return showToast('Student not found!');
    if (student.status !== 'pending') return showToast('This registration is no longer pending.');

    const centers = await dbGetAll('studyCenters');
    const programs = await getProgramsList();
    const branding = await dbGet('settings', 'branding');
    const schoolName = branding ? branding.schoolName : 'College';

    const [allTemplates] = await Promise.all([
        dbGetAll('whatsappTemplates')
    ]);
    // Peek next admission sequence without consuming it
    let settingVal = 0;
    try {
        const setting = await dbGet('settings', 'admissionLastSeq');
        if (setting && typeof setting.value === 'number') settingVal = setting.value;
    } catch (e) {}
    const maxExisting = await getMaxExistingAdmissionSeq();
    const seq = Math.max(settingVal, maxExisting) + 1;
    const admissionNumber = generateAdmissionNumber(student, branding, centers, seq);
    _approvalState.admissionSeq = seq;

    const BUILTIN_MSG = `Welcome to {{school}}, {{name}}! 🎓

We are excited to have you in our {{program}} program at {{center}} ({{centerCode}}, {{region}}).

Your registration was received on {{requested}} and has now been approved. Here are your login details:
🔑 Username: {{login}}
🔒 Password: {{admission}}

Keep your admission number safe — you will need it throughout your studies.

May God bless your studies and may this be a transformative season in your life.

— {{school}} Administration`;

    const sortedTemplates = (allTemplates || []).slice().sort((a, b) => {
        const aIsWelcome = (a.id === 'tpl-welcome' || /welcome|approval|register/i.test(a.name || '')) ? 0 : 1;
        const bIsWelcome = (b.id === 'tpl-welcome' || /welcome|approval|register/i.test(b.name || '')) ? 0 : 1;
        return aIsWelcome - bIsWelcome || (a.name || '').localeCompare(b.name || '');
    });

    const tplOptions = sortedTemplates.length
        ? sortedTemplates.map(t => ({ value: t.id, label: `${t.id === 'tpl-welcome' ? '★ ' : ''}${t.name || t.id}${t.id === 'tpl-welcome' ? ' (default)' : ''}` }))
        : [{ value: '__builtin__', label: '★ Welcome Message (default — edit in WhatsApp settings)' }];

    const initialTpl = sortedTemplates.find(t => t.id === 'tpl-welcome')
        ? 'tpl-welcome'
        : (sortedTemplates[0] ? sortedTemplates[0].id : '__builtin__');
    const initialRendered = makeRenderer(allTemplates, student, schoolName, admissionNumber)(initialTpl);

    _approvalState = {
        studentId,
        originalStudent: { ...student },
        admissionNumber,
        centers,
        programs,
        branding,
        schoolName,
        builtinMsg: BUILTIN_MSG,
        allTemplates: allTemplates || [],
        renderFor: makeRenderer(allTemplates, student, schoolName, admissionNumber),
        currentTplId: initialTpl
    };

    const html = `
    <div style="padding:4px;">
        <input type="hidden" id="appr-id" value="${student.id}">

        <div id="appr-step-form" style="display:block;">
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:11px;color:#475569;">
                <b>${escapeHtml(student.name)}</b> requested registration on ${formatDate(student.registrationRequestedAt || student.createdAt)}.
                Review and confirm the details below before finalizing.
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label>Full Name *</label>
                    <input type="text" id="appr-name" value="${escapeHtml(student.name || '')}" required oninput="updateMessagePreview()">
                </div>
                <div class="form-group">
                    <label>Phone (Username) *</label>
                    <input type="text" id="appr-phone" value="${escapeHtml(student.phone || '')}" required oninput="updateCredentialsSummary(); updateMessagePreview();">
                </div>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="appr-email" value="${escapeHtml(student.email || '')}">
                </div>
                <div class="form-group">
                    <label>Program *</label>
                    <select id="appr-program" onchange="updateCredentialsSummary(); updateMessagePreview();"><option value="">Select...</option>${programs.map(p => `<option value="${p}" ${student.program === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
                </div>
            </div>

            <div class="form-row">
                <div class="form-group">
                    <label>Study Center</label>
                    <select id="appr-center" onchange="updateCredentialsSummary()"><option value="">Select...</option>${centers.map(c => `<option value="${c.id}" ${student.studyCenterId === c.id ? 'selected' : ''}>${c.name} (${c.code})</option>`).join('')}</select>
                </div>
                <div class="form-group">
                    <label>Academic Year</label>
                    <input type="number" id="appr-year" value="${student.year || 1}" min="1" max="6">
                </div>
            </div>

            <div style="background:linear-gradient(135deg,#dbeafe 0%,#bfdbfe 100%);border:1px solid #93c5fd;border-radius:8px;padding:12px 14px;margin-bottom:14px;">
                <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#1e40af;font-weight:700;margin-bottom:4px;">Admission Number (auto-allocated)</div>
                <div style="font-size:18px;font-weight:800;color:#1a1a2e;font-family:'Courier New',monospace;letter-spacing:0.5px;margin-top:2px;" id="appr-admno-display">${escapeHtml(admissionNumber)}</div>
                <input type="hidden" id="appr-admno" value="${escapeHtml(admissionNumber)}">
                <div style="font-size:10px;color:#1e40af;margin-top:4px;">
                    This will be the student's <b>login password</b> on first login.
                </div>
            </div>

            <div style="background:#ffffff;border:2px solid #059669;border-radius:8px;padding:12px 14px;margin-bottom:14px;">
                <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#059669;font-weight:700;margin-bottom:10px;">
                    Login Credentials (will be quoted in the WhatsApp message)
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                    <div>
                        <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;font-weight:600;">Username</div>
                        <div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-top:2px;font-family:'Courier New',monospace;" id="appr-cred-username">${escapeHtml(student.phone || '—')}</div>
                    </div>
                    <div>
                        <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;font-weight:600;">Admission Number</div>
                        <div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-top:2px;font-family:'Courier New',monospace;" id="appr-cred-admno">${escapeHtml(admissionNumber)}</div>
                    </div>
                    <div>
                        <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;font-weight:600;">Password</div>
                        <div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-top:2px;font-family:'Courier New',monospace;" id="appr-cred-password">${escapeHtml(admissionNumber)}</div>
                    </div>
                    <div>
                        <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;font-weight:600;">Program</div>
                        <div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-top:2px;" id="appr-cred-program">${escapeHtml(student.program || '—')}</div>
                    </div>
                </div>
            </div>

            <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:10px 14px;margin-bottom:14px;">
                <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#166534;font-weight:700;margin-bottom:8px;">
                    WhatsApp Welcome Message
                </div>

                <div class="form-group" style="margin-bottom:8px;">
                    <label style="font-size:11px;color:#166534;font-weight:700;">Select Template</label>
                    <select id="appr-tpl" onchange="onApprovalTemplateChange()" style="width:100%;padding:10px 12px;font-size:13px;font-weight:600;color:#1a1a2e;border:2px solid #059669;border-radius:6px;background:#ffffff;appearance:none;-webkit-appearance:none;background-image:url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath fill='%23059669' d='M6 8L0 0h12z'/%3E%3C/svg%3E&quot;);background-repeat:no-repeat;background-position:right 12px center;background-size:10px;padding-right:32px;">
                        ${tplOptions.map(o => `<option value="${escapeHtml(o.value)}" style="color:#1a1a2e;background:#ffffff;padding:8px;" ${o.value === initialTpl ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
                    </select>
                </div>

                <div style="background:#ffffff;border:1px solid #d1d5db;border-radius:6px;padding:10px 12px;white-space:pre-wrap;font-family:inherit;font-size:12px;line-height:1.5;color:#1a1a2e;max-height:180px;overflow-y:auto;" id="appr-msg-preview">${escapeHtml(initialRendered)}</div>
                <input type="hidden" id="appr-msg" value="${escapeHtml(initialRendered)}">

                <div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
                    <div style="font-size:10px;color:#166534;flex:1;min-width:200px;">
                        Sending to <b>${escapeHtml(student.phone || '—')}</b>. Message includes <b>Username</b>, <b>Password</b>, and <b>Program</b>.
                    </div>
                    <button type="button" id="appr-customize-btn" onclick="toggleApprovalCustomize()" style="background:#ffffff;color:#1a1a2e;border:2px solid #1a1a2e;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">
                        Edit Message
                    </button>
                </div>

                <div id="appr-customize-area" style="display:none;margin-top:12px;padding:12px;background:#ffffff;border:2px solid #059669;border-radius:6px;">
                    <div style="font-size:11px;color:#475569;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">
                        Edit Template Message
                    </div>
                    <textarea id="appr-msg-custom" rows="6" oninput="syncCustomMessage()" style="width:100%;font-family:inherit;font-size:12px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;resize:vertical;color:#1a1a2e;box-sizing:border-box;">${escapeHtml(initialRendered)}</textarea>
                    <div style="font-size:11px;color:#475569;margin-top:6px;margin-bottom:10px;">
                        Save your changes to keep them for future approvals, or use them for this approval only.
                    </div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                        <button type="button" id="appr-save-current-btn" onclick="saveTemplateEdits()" style="background:#059669;color:#ffffff;border:none;padding:8px 16px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">
                            Save Changes to Template
                        </button>
                        <button type="button" onclick="showNewTemplateNameInput()" style="background:#1e40af;color:#ffffff;border:none;padding:8px 16px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">
                            Save as New Template
                        </button>
                        <button type="button" onclick="resetTemplateEdit()" style="background:#ffffff;color:#475569;border:1px solid #cbd5e1;padding:8px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">
                            Reset
                        </button>
                        <div id="appr-save-status" style="font-size:11px;color:#059669;font-weight:600;margin-left:auto;"></div>
                    </div>
                    <div id="appr-new-tpl-row" style="display:none;margin-top:10px;padding:8px;background:#f0fdf4;border:1px solid #86efac;border-radius:6px;">
                        <div style="font-size:11px;color:#166534;font-weight:600;margin-bottom:4px;">New Template Name</div>
                        <div style="display:flex;gap:6px;">
                            <input type="text" id="appr-new-tpl-name" placeholder="Enter template name…" style="flex:1;padding:6px 10px;font-size:13px;border:1px solid #86efac;border-radius:4px;">
                            <button type="button" onclick="confirmSaveAsNewTemplate()" style="background:#059669;color:#ffffff;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">Save</button>
                            <button type="button" onclick="cancelSaveAsNewTemplate()" style="background:#ffffff;color:#475569;border:1px solid #cbd5e1;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">Cancel</button>
                        </div>
                    </div>
                </div>
            </div>

            <div id="appr-error" style="display:none;background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:10px 12px;border-radius:6px;font-size:12px;margin-bottom:12px;"></div>

            <div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #e2e8f0;padding-top:14px;">
                <button type="button" class="btn btn-success" style="background:#059669;color:#fff;padding:10px 22px;font-weight:700;font-size:14px;" onclick="finalizeApproval()">
                    Finalize & Send Welcome
                </button>
            </div>
        </div>

        <div id="appr-step-success" style="display:none;">
            <div style="text-align:center;padding:20px 0 16px;">
                <div style="width:72px;height:72px;border-radius:50%;background:#dcfce7;display:inline-flex;align-items:center;justify-content:center;font-size:36px;color:#059669;margin-bottom:12px;">&#10003;</div>
                <h2 style="margin:0 0 4px;font-size:18px;color:#1a1a2e;">Registration Approved</h2>
                <p style="margin:0;color:#64748b;font-size:12px;">${escapeHtml(student.name)} can now log in to the student portal.</p>
            </div>

            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin-bottom:12px;">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                    <div>
                        <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;font-weight:600;">Admission Number</div>
                        <div style="font-size:15px;font-weight:800;color:#1a1a2e;font-family:'Courier New',monospace;margin-top:2px;" id="appr-success-admno">${escapeHtml(admissionNumber)}</div>
                    </div>
                    <div>
                        <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;font-weight:600;">Username</div>
                        <div style="font-size:13px;font-weight:700;color:#1a1a2e;margin-top:2px;">${escapeHtml(student.phone || '—')}</div>
                    </div>
                </div>
            </div>

            <div id="appr-wa-status" style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:12px 16px;margin-bottom:12px;">
                <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#166534;font-weight:700;margin-bottom:6px;">
                    WhatsApp Status
                </div>
                <div id="appr-wa-status-body" style="font-size:12px;color:#166534;">
                    Opening WhatsApp in a new tab…
                </div>
                <button type="button" id="appr-wa-resend" class="btn btn-outline btn-sm" style="margin-top:8px;display:none;" onclick="resendWhatsAppFromModal()">
                    Resend WhatsApp
                </button>
            </div>

            <div style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #e2e8f0;padding-top:14px;">
                <button type="button" class="btn btn-primary" onclick="closeModal(); renderPendingRegistrations();">Done — Close</button>
            </div>
        </div>
    </div>`;

    showModal('Approve Registration — ' + student.name, html, null, { maxWidth: '720px' });
    setTimeout(() => updateSaveButtonLabel(), 0);
}

function parseAdmissionSeq(admissionNumber) {
    if (!admissionNumber || typeof admissionNumber !== 'string') return 0;
    const parts = admissionNumber.split('/');
    if (parts.length < 3) return 0;
    const last = parts[parts.length - 1];
    const n = parseInt(last, 10);
    return isNaN(n) ? 0 : n;
}

async function getMaxExistingAdmissionSeq() {
    const students = await dbGetAll('students');
    let max = 0;
    students.forEach(s => {
        const n = parseAdmissionSeq(s.admissionNumber);
        if (n > max) max = n;
    });
    return max;
}

async function getAllExistingAdmissionSeqs() {
    const students = await dbGetAll('students');
    const set = new Set();
    students.forEach(s => {
        const n = parseAdmissionSeq(s.admissionNumber);
        if (n > 0) set.add(n);
    });
    return set;
}

async function getAvailableAdmissionSeqs(limit = 50) {
    const used = await getAllExistingAdmissionSeqs();
    if (used.size === 0) return [];
    const max = Math.max(...used);
    if (max <= 1) return [];
    const available = [];
    for (let i = 1; i < max; i++) {
        if (!used.has(i)) {
            available.push(i);
            if (available.length >= limit) break;
        }
    }
    return available;
}

async function getNextAdmissionSeq() {
    let settingVal = 0;
    try {
        const setting = await dbGet('settings', 'admissionLastSeq');
        if (setting && typeof setting.value === 'number') settingVal = setting.value;
    } catch (e) { /* ignore */ }
    const maxExisting = await getMaxExistingAdmissionSeq();
    const next = Math.max(settingVal, maxExisting) + 1;
    try { await dbPut('settings', { key: 'admissionLastSeq', value: next }); } catch (e) {}
    return next;
}
async function setAdmissionLastSeq(seq) {
    await dbPut('settings', { key: 'admissionLastSeq', value: seq });
}

function generateAdmissionNumber(student, branding, centers, seq) {
    const center = centers.find(c => c.id === student.studyCenterId);
    const centerCode = center ? center.code : 'GEN';
    const schoolInitials = branding && branding.initials ? branding.initials : 'INST';
    const year = new Date().getFullYear().toString().slice(-2);
    const month = String(new Date().getMonth() + 1);
    const seqStr = String(seq).padStart(3, '0');
    return `${schoolInitials}/${centerCode}/${month}-${year}/${seqStr}`;
}

async function regenerateAdmission() {
    const studentId = _approvalState.studentId;
    if (!studentId) return;
    const seq = await getNextAdmissionSeq();
    const newAdmno = generateAdmissionNumber(
        { ..._approvalState.originalStudent, studyCenterId: document.getElementById('appr-center').value || _approvalState.originalStudent.studyCenterId },
        _approvalState.branding,
        _approvalState.centers,
        seq
    );
    _approvalState.admissionNumber = newAdmno;
    _approvalState.admissionSeq = seq;
    document.getElementById('appr-admno').value = newAdmno;
    document.getElementById('appr-admno-display').textContent = newAdmno;
    updateCredentialsSummary();
    onApprovalTemplateChange();
}

function updateCredentialsSummary() {
    const phoneEl = document.getElementById('appr-phone');
    const admnoEl = document.getElementById('appr-admno');
    const programEl = document.getElementById('appr-program');
    const credUsername = document.getElementById('appr-cred-username');
    const credAdmno = document.getElementById('appr-cred-admno');
    const credPassword = document.getElementById('appr-cred-password');
    const credProgram = document.getElementById('appr-cred-program');
    if (!credUsername) return;
    const phone = phoneEl ? phoneEl.value.trim() : '';
    const admno = admnoEl ? admnoEl.value.trim() : '';
    const program = programEl ? programEl.value : '';
    credUsername.textContent = phone || '—';
    credAdmno.textContent = admno || '—';
    credPassword.textContent = admno || '—';
    credProgram.textContent = program || '—';
}

function updateMessagePreview() {
    onApprovalTemplateChange();
}

function onApprovalTemplateChange() {
    const tplId = document.getElementById('appr-tpl').value;
    const rendered = _approvalState.renderFor(tplId);
    document.getElementById('appr-msg-preview').textContent = rendered;
    document.getElementById('appr-msg').value = rendered;
    const customArea = document.getElementById('appr-customize-area');
    const customTextarea = document.getElementById('appr-msg-custom');
    const customizeBtn = document.getElementById('appr-customize-btn');
    if (customTextarea) customTextarea.value = rendered;
    if (customArea) customArea.style.display = 'none';
    if (customizeBtn) customizeBtn.textContent = 'Customize';
    _approvalState.currentTplId = tplId;
    updateSaveButtonLabel();
}

function updateSaveButtonLabel() {
    const btn = document.getElementById('appr-save-current-btn');
    if (!btn) return;
    const tplId = _approvalState.currentTplId;
    if (!tplId || tplId === '__builtin__') {
        btn.textContent = 'Save as Template (no template selected)';
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
    } else {
        const tpl = (_approvalState.allTemplates || []).find(t => t.id === tplId);
        const name = tpl ? (tpl.name || tpl.id) : tplId;
        btn.textContent = 'Save Changes to "' + name + '"';
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.cursor = '';
    }
}

async function saveTemplateEdits() {
    const tplId = _approvalState.currentTplId;
    if (!tplId || tplId === '__builtin__') {
        showApprError('Please select a real template from the dropdown first, or use "Save as New Template".');
        return;
    }
    const newMessage = document.getElementById('appr-msg-custom').value;
    if (!newMessage.trim()) {
        showApprError('Template message cannot be empty.');
        return;
    }
    const tpl = _approvalState.allTemplates.find(t => t.id === tplId);
    if (!tpl) {
        showApprError('Template not found. Try "Save as New Template" instead.');
        return;
    }
    const statusEl = document.getElementById('appr-save-status');
    const btn = document.getElementById('appr-save-current-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    if (statusEl) statusEl.textContent = '';
    try {
        tpl.message = newMessage;
        tpl.updatedAt = new Date().toISOString();
        await dbPut('whatsappTemplates', tpl);
        _approvalState.allTemplates = await dbGetAll('whatsappTemplates');
        _approvalState.renderFor = makeRenderer(_approvalState.allTemplates, _approvalState.originalStudent, _approvalState.schoolName, _approvalState.admissionNumber);
        if (statusEl) statusEl.textContent = 'Saved!';
        showToast('Template "' + (tpl.name || tpl.id) + '" updated.', { type: 'success' });
    } catch (err) {
        showApprError('Save failed: ' + err.message);
        console.error('saveTemplateEdits error:', err);
    } finally {
        btn.disabled = false;
        updateSaveButtonLabel();
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
    }
}

function showNewTemplateNameInput() {
    const newMessage = document.getElementById('appr-msg-custom').value;
    if (!newMessage.trim()) {
        showApprError('Template message cannot be empty.');
        return;
    }
    const baseName = (function () {
        const tplId = _approvalState.currentTplId;
        if (tplId && tplId !== '__builtin__') {
            const tpl = _approvalState.allTemplates.find(t => t.id === tplId);
            if (tpl) return tpl.name || tpl.id;
        }
        return 'Welcome Message';
    })();
    const row = document.getElementById('appr-new-tpl-row');
    const nameInput = document.getElementById('appr-new-tpl-name');
    if (nameInput) nameInput.value = baseName + ' (Copy)';
    if (row) {
        row.style.display = 'block';
        setTimeout(() => { if (nameInput) { nameInput.focus(); nameInput.select(); } }, 0);
    }
}

function cancelSaveAsNewTemplate() {
    const row = document.getElementById('appr-new-tpl-row');
    if (row) row.style.display = 'none';
}

async function confirmSaveAsNewTemplate() {
    const newMessage = document.getElementById('appr-msg-custom').value;
    if (!newMessage.trim()) {
        showApprError('Template message cannot be empty.');
        return;
    }
    const nameInput = document.getElementById('appr-new-tpl-name');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) {
        showApprError('Please enter a template name.');
        return;
    }
    const id = 'tpl-custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const newTpl = {
        id,
        name,
        message: newMessage,
        category: 'general',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    const statusEl = document.getElementById('appr-save-status');
    try {
        await dbPut('whatsappTemplates', newTpl);
        _approvalState.allTemplates = await dbGetAll('whatsappTemplates');
        _approvalState.renderFor = makeRenderer(_approvalState.allTemplates, _approvalState.originalStudent, _approvalState.schoolName, _approvalState.admissionNumber);
        const select = document.getElementById('appr-tpl');
        let existingOption = Array.from(select.options).find(o => o.value === id);
        if (!existingOption) {
            const newOption = document.createElement('option');
            newOption.value = id;
            newOption.textContent = name + ' (new)';
            select.appendChild(newOption);
        }
        select.value = id;
        _approvalState.currentTplId = id;
        updateSaveButtonLabel();
        cancelSaveAsNewTemplate();
        if (statusEl) statusEl.textContent = 'New template created!';
        showToast('New template "' + name + '" saved.', { type: 'success' });
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
    } catch (err) {
        showApprError('Save failed: ' + err.message);
        console.error('saveAsNewTemplate error:', err);
    }
}

function resetTemplateEdit() {
    const tplId = _approvalState.currentTplId;
    const rendered = _approvalState.renderFor(tplId);
    document.getElementById('appr-msg-custom').value = rendered;
    document.getElementById('appr-msg').value = rendered;
    const statusEl = document.getElementById('appr-save-status');
    if (statusEl) statusEl.textContent = 'Reset to template';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
}

function getApprovalFormValues() {
    const nameEl = document.getElementById('appr-name');
    const phoneEl = document.getElementById('appr-phone');
    const programEl = document.getElementById('appr-program');
    const admnoEl = document.getElementById('appr-admno');
    return {
        name: nameEl ? nameEl.value.trim() : (_approvalState.originalStudent ? _approvalState.originalStudent.name : ''),
        phone: phoneEl ? phoneEl.value.trim() : (_approvalState.originalStudent ? _approvalState.originalStudent.phone : ''),
        program: programEl ? programEl.value : (_approvalState.originalStudent ? _approvalState.originalStudent.program : ''),
        admissionNumber: admnoEl ? admnoEl.value.trim() : (_approvalState.admissionNumber || '')
    };
}

function makeRenderer(allTemplates, student, schoolName, admissionNumber) {
    return (tplId) => {
        const form = getApprovalFormValues();
        const liveStudent = { ...student, ...form, admissionNumber: form.admissionNumber };
        const livePhone = form.phone;
        const liveAdmno = form.admissionNumber || admissionNumber;
        if (_approvalState.admissionNumber && _approvalState.admissionNumber !== form.admissionNumber) {
            _approvalState.admissionNumber = form.admissionNumber;
        }
        if (!tplId || tplId === '__builtin__') {
            return applyTemplateVars(_approvalState.builtinMsg, liveStudent, schoolName, 0, liveAdmno, livePhone);
        }
        const tpl = (allTemplates || []).find(t => t.id === tplId);
        if (!tpl) {
            return applyTemplateVars(_approvalState.builtinMsg, liveStudent, schoolName, 0, liveAdmno, livePhone);
        }
        return applyTemplateVars(tpl.message, liveStudent, schoolName, 0, liveAdmno, livePhone);
    };
}

function toggleApprovalCustomize() {
    const area = document.getElementById('appr-customize-area');
    const btn = document.getElementById('appr-customize-btn');
    if (!area || !btn) return;
    if (area.style.display === 'none') {
        area.style.display = 'block';
        btn.textContent = 'Hide editor';
    } else {
        area.style.display = 'none';
        btn.textContent = 'Customize';
    }
}

function syncCustomMessage() {
    const custom = document.getElementById('appr-msg-custom');
    if (custom) document.getElementById('appr-msg').value = custom.value;
}

async function finalizeApproval() {
    const id = document.getElementById('appr-id').value;
    const errEl = document.getElementById('appr-error');
    errEl.style.display = 'none';

    const name = sanitizeInput(document.getElementById('appr-name').value.trim());
    const phone = sanitizeInput(document.getElementById('appr-phone').value.trim());
    const email = document.getElementById('appr-email').value.trim();
    const program = document.getElementById('appr-program').value;
    const centerId = document.getElementById('appr-center').value;
    const year = parseInt(document.getElementById('appr-year').value) || 1;
    const admissionNumber = document.getElementById('appr-admno').value.trim();
    const message = document.getElementById('appr-msg').value;

    if (!name) return showApprError('Full name is required.');
    if (!phone) return showApprError('Phone is required.');
    if (!program) return showApprError('Program is required.');
    if (!admissionNumber) return showApprError('Admission number is required.');

    const allUsers = await dbGetAll('users');
    const existingPhone = allUsers.find(u => u.username === phone);
    if (existingPhone) return showApprError('Phone ' + phone + ' is already registered as a username. Use a different phone.');

    const student = await dbGet('students', id);
    if (!student) return showApprError('Student record disappeared — refresh and try again.');
    if (student.status !== 'pending') return showApprError('This registration is no longer pending.');

    const finalApproveBtn = document.querySelector('#appr-step-form button.btn-success');
    if (finalApproveBtn) { finalApproveBtn.disabled = true; finalApproveBtn.textContent = '⏳ Saving…'; }

    try {
        student.name = name;
        student.phone = phone;
        student.email = email;
        student.program = program;
        student.studyCenterId = centerId;
        student.year = year;
        student.admissionNumber = admissionNumber;
        student.status = 'active';
        student.enrollDate = new Date().toISOString().split('T')[0];
        student.approvedAt = new Date().toISOString();
        await dbPut('students', student);

        const savedSeq = parseAdmissionSeq(admissionNumber);
        if (savedSeq > 0) {
            try {
                let currentSetting = 0;
                try {
                    const existing = await dbGet('settings', 'admissionLastSeq');
                    if (existing && typeof existing.value === 'number') currentSetting = existing.value;
                } catch (e) { /* ignore */ }
                const newSetting = Math.max(currentSetting, savedSeq);
                if (newSetting !== currentSetting) {
                    await dbPut('settings', { key: 'admissionLastSeq', value: newSetting, updatedAt: new Date().toISOString(), studentId: id, studentName: name });
                }
                _approvalState.admissionSeq = savedSeq;
            } catch (e) { console.warn('admissionLastSeq sync failed:', e); }
        }

        const pwHash = await hashPassword(admissionNumber);
        const user = {
            username: phone,
            password: pwHash,
            name: name,
            role: 'student',
            status: 'active',
            studentId: id,
            createdAt: new Date().toISOString()
        };
        await dbPut('users', user);

        let waOpened = false;
        let finalMessage = message;
        const leftoverPlaceholders = (finalMessage.match(/\{\{[^}]+\}\}/g) || []);
        if (leftoverPlaceholders.length > 0) {
            const centerObj = student.studyCenterId ? (_centerName(student.studyCenterId) || null) : null;
            const requested = student.registrationRequestedAt ? new Date(student.registrationRequestedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
            const knownSubs = {
                '{{admissionNumber}}': admissionNumber, '{{admission}}': admissionNumber,
                '{{password}}': admissionNumber, '{{username}}': phone, '{{phone}}': phone,
                '{{login}}': phone, '{{name}}': name, '{{email}}': email, '{{program}}': program,
                '{{school}}': _approvalState.schoolName, '{{balance}}': '0',
                '{{year}}': String(year), '{{min}}': '75',
                '{{center}}': centerObj ? centerObj.name : (student.studyCenterId ? 'Study Center' : 'Main Campus'),
                '{{centerCode}}': centerObj && centerObj.code ? centerObj.code : '',
                '{{region}}': _regionNameFromStudent(student),
                '{{requested}}': requested,
                '{{fee}}': typeof student.feeAmount === 'number' ? formatCurrency(student.feeAmount) : '0'
            };
            leftoverPlaceholders.forEach(ph => {
                if (knownSubs[ph] !== undefined) finalMessage = finalMessage.split(ph).join(knownSubs[ph]);
            });
        }
        if (phone && finalMessage) {
            try {
                const waResult = sendWhatsApp(phone, finalMessage);
                waOpened = !!waResult;
            } catch (e) {
                console.error('WhatsApp send error:', e);
            }
        }

        _approvalState.finalStudent = student;
        _approvalState.finalUser = user;
        _approvalState.finalMessage = finalMessage;
        _approvalState.finalPhone = phone;

        document.getElementById('appr-step-form').style.display = 'none';
        const successStep = document.getElementById('appr-step-success');
        successStep.style.display = 'block';
        document.getElementById('appr-success-admno').textContent = admissionNumber;

        const waBody = document.getElementById('appr-wa-status-body');
        const waResend = document.getElementById('appr-wa-resend');
        if (waOpened && phone) {
            waBody.innerHTML = `WhatsApp opened in a new tab to <b>${escapeHtml(phone)}</b>.<br><span style="font-size:11px;color:#64748b;">If the tab didn't open, click Resend WhatsApp below.</span>`;
            waResend.style.display = 'inline-block';
        } else if (phone) {
            waBody.innerHTML = `Could not open WhatsApp automatically. Click <b>Resend WhatsApp</b> below to try again.`;
            waResend.style.display = 'inline-block';
        } else {
            waBody.innerHTML = `No phone number — student account created but no WhatsApp sent.`;
            waResend.style.display = 'none';
        }

        try {
            await dbAdd('whatsappLog', {
                id: 'WL-' + Date.now(),
                studentId: id,
                phone: phone,
                message: finalMessage,
                template: 'tpl-welcome',
                status: waOpened ? 'opened' : 'failed',
                sentAt: new Date().toISOString()
            });
        } catch (e) {}

        renderPendingRegistrations();
        updatePendingBadge();
        logAudit('approved', 'registration', { studentId: id, name, admissionNumber, admissionSeq: savedSeq, admissionLastSeqSynced: newSetting });
        logAudit('updated', 'admission-last-seq', { value: newSetting, studentId: id, studentName: name, admissionNumber });

        const modalTitle = document.querySelector('.modal-header h2, .modal-header h3, .modal-header');
        if (modalTitle) {
            const newTitle = modalTitle.cloneNode(true);
            newTitle.textContent = 'Approved — ' + name;
            modalTitle.parentNode.replaceChild(newTitle, modalTitle);
        }
    } catch (err) {
        showApprError('Approval failed: ' + err.message);
        console.error('Finalize approval error:', err);
        if (finalApproveBtn) { finalApproveBtn.disabled = false; finalApproveBtn.textContent = 'Finalize & Send Welcome'; }
    }
}

function showApprError(msg) {
    const errEl = document.getElementById('appr-error');
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
}

function resendWhatsAppFromModal() {
    if (!_approvalState.finalPhone || !_approvalState.finalMessage) return;
    const btn = document.getElementById('appr-wa-resend');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
    try {
        const result = sendWhatsApp(_approvalState.finalPhone, _approvalState.finalMessage);
        const waBody = document.getElementById('appr-wa-status-body');
        if (result && _approvalState.finalPhone) {
            waBody.innerHTML = `WhatsApp opened again to <b>${escapeHtml(_approvalState.finalPhone)}</b>.`;
        } else {
            waBody.innerHTML = `Could not open WhatsApp. Please verify the phone number manually.`;
        }
    } catch (e) {
        console.error('Resend WhatsApp error:', e);
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Resend WhatsApp'; }
}

async function approveRegistration(studentId) {
    return openApproveModal(studentId);
}

async function rejectRegistration(studentId) {
    if (!await showConfirm('Reject Registration', 'Mark this registration as rejected?')) return;

    const student = await dbGet('students', studentId);
    if (!student) return;
    student.status = 'rejected';
    student.rejectedAt = new Date().toISOString();
    await dbPut('students', student);
    renderPendingRegistrations();
    showToast('Registration rejected.', { type: 'warning' });
    logAudit('rejected', 'registration', { studentId, name: student.name });
}
