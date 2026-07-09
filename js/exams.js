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
