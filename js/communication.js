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

let commSearchTimer;
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
        preview = msg.replace(/{{name}}/g, 'John Doe').replace(/{{school}}/g, schoolName).replace(/{{program}}/g, 'Theology').replace(/{{admission}}/g, 'INST/GEN/01-24/001').replace(/{{phone}}/g, '2547XXXXXXXX').replace(/{{balance}}/g, 'KES 15,000.00').replace(/{{email}}/g, 'student@example.com');
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