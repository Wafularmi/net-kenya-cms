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

let _approvalState = {};

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

    const BUILTIN_MSG = `Dear {{name}},

Welcome to {{school}}! Your registration has been approved.

Below are your login details:

Program: {{program}}
Username: {{phone}}
Admission Number: {{admission}}
Password: {{admission}}

Please use the Username and Password above to log in to the student portal where you will access your courses, quizzes, and more.

For any questions, contact the administration office.

{{school}} Administration`;

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
            const knownSubs = {
                '{{admissionNumber}}': admissionNumber, '{{admission}}': admissionNumber,
                '{{password}}': admissionNumber, '{{username}}': phone, '{{phone}}': phone,
                '{{name}}': name, '{{email}}': email, '{{program}}': program,
                '{{school}}': _approvalState.schoolName, '{{balance}}': '0',
                '{{year}}': String(year), '{{min}}': '75'
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
