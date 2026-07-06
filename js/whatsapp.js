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
        { id: 'tpl-fee', name: '💰 Fee Reminder', message: 'Dear {{name}},\n\nThis is a friendly reminder from {{school}} that your current fee balance is {{balance}}.\n\nPlease visit the finance office at your earliest convenience to clear your balance.\n\nThank you.\nGod bless.', category: 'finance' },
        { id: 'tpl-attendance', name: '⚠️ Attendance Warning', message: 'Dear {{name}},\n\nYour class attendance is currently below the required minimum ({{min}}%). Please attend all remaining classes to be eligible for exams.\n\nContact your course lecturer if you have any concerns.\n\n{{school}}', category: 'academic' },
        { id: 'tpl-exam', name: '📄 Exam Schedule', message: 'Dear {{name}},\n\nYour {{type}} exam for {{course}} is scheduled:\n📅 Date: {{date}}\n⏰ Time: {{time}}\n📍 Venue: {{venue}}\n\nPlease be on time and bring your student ID.\n\n{{school}}', category: 'academic' },
        { id: 'tpl-event', name: '📢 Event Notification', message: 'Dear {{name}},\n\nYou are invited to:\n📌 {{event}}\n📅 Date: {{date}}\n📍 Venue: {{venue}}\n\nYour presence is required.\n\n{{school}}', category: 'general' },
        { id: 'tpl-welcome', name: '👋 Welcome Message', message: 'Welcome to {{school}}, {{name}}! 🎓\n\nWe are excited to have you in our {{program}} program.\n\nMay God bless your studies and may this be a transformative season in your life.\n\n— {{school}} Administration', category: 'general' },
        { id: 'tpl-graduation', name: '🎓 Graduation Notice', message: 'Dear {{name}},\n\nCongratulations! You have been cleared for graduation from the {{program}} program.\n\n📅 Ceremony Date: {{date}}\n📍 Venue: {{venue}}\n\nPlease confirm your attendance at the Registrar\'s office.\n\n{{school}}', category: 'general' },
        { id: 'tpl-inactivity1', name: '⏰ Inactivity Warning 1', message: 'Dear {{name}},\n\nWe noticed you haven\'t logged in for 20 working days. Your account is still active, but please log in soon to stay on track.\n\nIf you\'re experiencing difficulties, please reach out to administration.\n\n{{school}}', category: 'academic' },
        { id: 'tpl-inactivity2', name: '🔒 Inactivity Warning 2', message: 'Dear {{name}},\n\nURGENT: Your account will be LOCKED in 3 working days due to inactivity (27 working days without login). Please log in immediately to keep your account active.\n\nContact {{school}} Administration for assistance.\n\n{{school}}', category: 'academic' }
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
        preview = msg.replace(/{{name}}/g, 'John Doe').replace(/{{school}}/g, schoolName).replace(/{{program}}/g, 'Theology').replace(/{{balance}}/g, 'KES 15,000.00');
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
    const content = `<div class="form-group"><label>Template Name *</label><input type="text" id="tpl-name" placeholder="e.g., Fee Reminder"></div><div class="form-group"><label>Category</label><select id="tpl-category"><option value="finance">💰 Finance</option><option value="academic">📚 Academic</option><option value="general">📢 General</option></select></div><div class="form-group"><label>Message *</label><textarea id="tpl-message" rows="5"></textarea></div><p style="font-size:11px;color:var(--text-muted);">Variables: {{name}}, {{balance}}, {{school}}, {{program}}, {{admission}}, {{phone}}, {{email}}, {{year}}</p>`;
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
    const content = `<div class="form-group"><label>Template Name *</label><input type="text" id="tpl-edit-name" value="${escapeHtml(tpl.name)}"></div><div class="form-group"><label>Category</label><select id="tpl-edit-category"><option value="finance" ${tpl.category==='finance'?'selected':''}>💰 Finance</option><option value="academic" ${tpl.category==='academic'?'selected':''}>📚 Academic</option><option value="general" ${tpl.category==='general'?'selected':''}>📢 General</option></select></div><div class="form-group"><label>Message *</label><textarea id="tpl-edit-message" rows="6">${escapeHtml(tpl.message)}</textarea></div><p style="font-size:11px;color:var(--text-muted);">Variables: {{name}}, {{balance}}, {{school}}, {{program}}, {{admission}}, {{phone}}, {{email}}, {{year}}</p>`;
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
