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
        return `<tr><td><b>${s.admissionNumber || s.id}</b></td><td><div><b>${s.name}</b></div><div style="font-size:11px;color:var(--text-muted);">${s.email || ''}</div></td><td>${center ? center.name : 'Main'}</td><td>${s.program || '--'}</td><td>Year ${s.year || 1}</td><td><span class="badge badge-${statusClass}">${s.status || 'active'}</span></td><td style="color:${balance > 0 ? 'var(--warning)' : 'var(--success)'};font-weight:600;">${formatCurrency(balance)}</td><td><button class="btn btn-outline btn-sm" onclick="viewStudent('${s.id}')">View</button> <button class="btn btn-outline btn-sm" onclick="editStudent('${s.id}')">Edit</button> <button class="btn btn-primary btn-sm" onclick="adminEnrollStudentInCourse('${s.id}')" title="Enroll in Course">📚</button> <button class="btn btn-warning btn-sm" onclick="adminRegisterStudentForExam('${s.id}')" title="Register for Exam">📝</button> <button class="btn btn-info btn-sm" onclick="adminEnrollStudentInQuiz('${s.id}')" title="Join Quiz">📋</button> <button class="btn btn-secondary btn-sm" onclick="adminChangeStudentProgram('${s.id}')" title="Change Program">🎓</button> ${phone ? `<div class="wa-dropdown" style="display:inline-block;position:relative;"><button class="btn btn-success btn-sm" onclick="toggleWADropdown(event, '${s.id}')">📱</button><div id="wa-drop-${s.id}" class="wa-drop-menu" style="display:none;position:absolute;right:0;top:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:4px;min-width:180px;z-index:50;box-shadow:var(--shadow-lg);"><div class="wa-drop-item" onclick="quickWhatsAppStudent('${s.id}')">💬 Custom Message</div><div class="wa-drop-item" onclick="quickWhatsAppStudent('${s.id}','tpl-fee')">💰 Fee Reminder</div><div class="wa-drop-item" onclick="quickWhatsAppStudent('${s.id}','tpl-attendance')">⚠️ Attendance Alert</div><div class="wa-drop-item" onclick="quickWhatsAppStudent('${s.id}','tpl-welcome')">👋 Welcome</div></div></div>` : ''} <button class="btn btn-danger btn-sm" onclick="deleteStudent('${s.id}')">Del</button></td></tr>`;
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

    const content = `<input type="hidden" id="student-edit-id" value="${student ? student.id : ''}"><div class="form-group"><label>Full Name *</label><input type="text" id="student-name" value="${student ? student.name : ''}" required></div><div class="form-row"><div class="form-group"><label>Email</label><input type="email" id="student-email" value="${student ? student.email || '' : ''}"></div><div class="form-group"><label>Phone</label><input type="text" id="student-phone" value="${student ? student.phone || '' : ''}"></div></div><div class="form-row"><div class="form-group"><label>Date of Birth</label><input type="date" id="student-dob" value="${student ? student.dob || '' : ''}"></div><div class="form-group"><label>Gender</label><select id="student-gender"><option value="">Select</option><option value="male" ${student && student.gender === 'male' ? 'selected' : ''}>Male</option><option value="female" ${student && student.gender === 'female' ? 'selected' : ''}>Female</option></select></div></div><div class="form-group"><label>Study Center *</label><select id="student-center" onchange="onStudentCenterChange()"><option value="">Select Study Center...</option>${centers.map(c => `<option value="${c.id}" ${student && student.studyCenterId === c.id ? 'selected' : ''}>${c.name} (${c.code})</option>`).join('')}</select></div><div style="padding:12px;background:var(--bg-input);border-radius:var(--radius);margin-bottom:12px;"><div style="font-size:12px;font-weight:600;color:var(--accent);margin-bottom:8px;">Admission Number</div><div class="form-row"><div class="form-group"><label>Generation Mode</label><select id="adm-mode" onchange="toggleAdmissionMode()"><option value="auto" ${student && student.admMode === 'manual' ? '' : 'selected'}>Auto-Generate</option><option value="manual" ${student && student.admMode === 'manual' ? 'selected' : ''}>Manual Entry</option></select></div><div class="form-group"><label>Registration Date</label><input type="date" id="adm-date" value="${student ? student.enrollDate || new Date().toISOString().split('T')[0] : new Date().toISOString().split('T')[0]}" onchange="updateAdmissionPreview()"></div></div><div id="adm-auto-section"><div style="font-size:13px;margin-top:4px;">Format: <b>${initials}</b> / <span id="adm-preview-center">XXXX</span> / <span id="adm-preview-month">${defaultMonth}</span> - <span id="adm-preview-year">${defaultYear}</span> / <span id="adm-preview-seq">001</span></div><div style="font-size:18px;font-weight:700;color:var(--accent);margin-top:8px;" id="adm-full-preview">${initials}/XXXX/${defaultMonth}-${defaultYear}/001</div></div><div id="adm-manual-section" style="display:none;"><div class="form-group"><label>Manual Admission Number</label><input type="text" id="adm-manual-input" value="${student ? student.admissionNumber || '' : ''}" placeholder="Enter custom admission number"></div></div></div><div class="form-row"><div class="form-group"><label>Program</label><select id="student-program" onchange="onStudentProgramChange(this)"><option value="">Select Program...</option>${programs.map(p => `<option value="${p}" ${student && student.program === p ? 'selected' : ''}>${p}</option>`).join('')}${student && student.program && !programs.includes(student.program) ? `<option value="${student.program}" selected>${student.program}</option>` : ''}</select></div><div class="form-group"><label>Year</label><input type="number" id="student-year" value="${student ? student.year || 1 : 1}" min="1" max="5"></div></div><div class="form-row"><div class="form-group"><label>Fee Amount</label><input type="number" id="student-fee" value="${student ? getCachedStudentFee(student) : 0}"></div><div class="form-group"><label>Installment Plan</label><select id="student-installment"><option value="">None</option><option value="2" ${student && student.installments == 2 ? 'selected' : ''}>2 Payments</option><option value="3" ${student && student.installments == 3 ? 'selected' : ''}>3 Payments</option><option value="4" ${student && student.installments == 4 ? 'selected' : ''}>4 Payments</option></select></div></div><div class="form-row"><div class="form-group"><label>Status</label><select id="student-status"><option value="active" ${student && student.status === 'active' ? 'selected' : ''}>Active</option><option value="inactive" ${student && student.status === 'inactive' ? 'selected' : ''}>Inactive</option><option value="graduated" ${student && student.status === 'graduated' ? 'selected' : ''}>Graduated</option><option value="suspended" ${student && student.status === 'suspended' ? 'selected' : ''}>Suspended</option><option value="dropped" ${student && student.status === 'dropped' ? 'selected' : ''}>Dropped</option></select></div></div><div class="form-group"><label>Address</label><textarea id="student-address">${student ? student.address || '' : ''}</textarea></div><div class="form-group"><label>Emergency Contact</label><input type="text" id="student-emergency" value="${student ? student.emergency || '' : ''}"></div><div class="form-group"><label>Notes</label><textarea id="student-notes">${student ? student.notes || '' : ''}</textarea></div>`;
    showModal(isEdit ? 'Edit Student' : 'Add New Student', content, `<button class="btn btn-primary" onclick="saveStudent()">${isEdit ? 'Update' : 'Enroll'}</button>`);
    onStudentCenterChange();
    updateAdmissionPreview();
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
        year: parseInt(document.getElementById('student-year').value) || 1,
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
