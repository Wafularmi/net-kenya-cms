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

function applyTemplateVars(message, student, schoolName, balance, admissionNumber, phone) {
    const admno = admissionNumber || (student && student.admissionNumber) || (student && student.id) || '';
    return message
        .replace(/{{name}}/g, student.name)
        .replace(/{{school}}/g, schoolName)
        .replace(/{{program}}/g, student.program || 'program')
        .replace(/{{balance}}/g, balance !== undefined ? formatCurrency(balance) : '0')
        .replace(/{{admissionNumber}}/g, admno)
        .replace(/{{admission}}/g, admno)
        .replace(/{{phone}}/g, phone || student.phone || '')
        .replace(/{{username}}/g, phone || student.phone || '')
        .replace(/{{password}}/g, admno)
        .replace(/{{email}}/g, student.email || '')
        .replace(/{{year}}/g, student.year || '1')
        .replace(/{{center}}/g, student.studyCenterId ? 'Study Center' : 'Main Campus')
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
