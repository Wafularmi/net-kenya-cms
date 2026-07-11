let studentHubCache = null;
let _hubActiveTab = 'overview';
let _hubModalOpen = false;
let _hubRenderedTabs = {};

function safeGetLocal(key, defaultValue) {
    try {
        const val = localStorage.getItem(key);
        return val ? JSON.parse(val) : defaultValue;
    } catch {
        return defaultValue;
    }
}
function safeSetLocal(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

async function loadStudentHubData(force) {
    if (!force && studentHubCache && Date.now() - studentHubCache.loadedAt < 300000) return studentHubCache;
    const core = ['students','courses','enrollments','exams','examRegistrations','quizzes','lessons','notes'];
    const batch = await dbGetBatch(core);
    if (studentHubCache) Object.assign(batch, { attendance: studentHubCache.attendance, payments: studentHubCache.payments, retakeRequests: studentHubCache.retakeRequests, seating: studentHubCache.seating, submissions: studentHubCache.submissions, grades: studentHubCache.grades });
    studentHubCache = { ...batch, loadedAt: Date.now() };
    return studentHubCache;
}

function invalidateStudentHubCache() { studentHubCache = null; _hubComputedCache = null; }

let _hubComputed = null;
let _hubComputedCache = null;

async function _hubLoadTabData(tab) {
    if (!studentHubCache) return;
    const needed = [];
    if (tab === 'overview' || !tab) { if (!studentHubCache.attendance) needed.push('attendance'); if (!studentHubCache.payments) needed.push('payments'); }
    if (tab === 'exams') { if (!studentHubCache.retakeRequests) needed.push('retakeRequests'); if (!studentHubCache.seating) needed.push('seating'); }
    if (tab === 'quizzes' || tab === 'overview' || !tab) { if (!studentHubCache.submissions) needed.push('submissions'); if (!studentHubCache.grades) needed.push('grades'); }
    if (!needed.length) return;
    const extra = await dbGetBatch(needed);
    Object.assign(studentHubCache, extra);
}

function hubSkeleton() {
    return `<div style="pointer-events:none;">
        <div style="background:linear-gradient(135deg,#1e3c72,#2a5298);height:110px;border-radius:14px;margin-bottom:16px;position:relative;overflow:hidden;"><div style="position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.08),transparent);animation:hub-shimmer 1.5s infinite;"></div></div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">${'<div style="height:70px;background:var(--bg-input);border-radius:8px;overflow:hidden;"><div style="width:100%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent);animation:hub-shimmer 1.5s infinite;"></div></div>'.repeat(4)}</div>
        <div style="height:40px;background:var(--bg-input);border-radius:8px;margin-bottom:16px;overflow:hidden;"><div style="width:100%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent);animation:hub-shimmer 1.5s infinite;"></div></div>
        <div style="height:120px;background:var(--bg-input);border-radius:8px;overflow:hidden;"><div style="width:100%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.06),transparent);animation:hub-shimmer 1.5s infinite;"></div></div>
    </div><style>@keyframes hub-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}</style>`;
}

function _hubBuildComputed(data, me) {
    const studentId = me.id;
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const allStudentIds = new Set([studentId, currentUser.username, currentUser.studentId, me.id, me.admissionNumber, me.phone, me.email].filter(Boolean));
    const enrolledIds = new Set((data.enrollments || []).filter(e => allStudentIds.has(e.studentId)).map(e => e.courseId));
    let myCourses = (data.courses || []).filter(c => enrolledIds.has(c.id));
    if (typeof sortCoursesByTranscriptOrder === 'function') myCourses = sortCoursesByTranscriptOrder(myCourses);
    let availableCourses = (data.courses || []).filter(c => c.published !== false && !enrolledIds.has(c.id));
    if (typeof sortCoursesByTranscriptOrder === 'function') availableCourses = sortCoursesByTranscriptOrder(availableCourses);
    const examRegIds = new Set((data.examRegistrations || []).filter(r => allStudentIds.has(r.studentId)).map(r => r.examId));
    const allCourseExams = (data.exams || []).filter(e =>
        e.published !== false && enrolledIds.has(e.courseId) &&
        (!me.studyCenterId || !e.studyCenterId || e.studyCenterId === me.studyCenterId)
    );
    const myRegisteredExams = allCourseExams.filter(e => examRegIds.has(e.id)).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const today = new Date().toISOString().split('T')[0];
    const upcomingRegisteredExams = myRegisteredExams.filter(e => e.date >= today);
    const pastRegisteredExams = myRegisteredExams.filter(e => e.date < today);
    const availableExams = allCourseExams.filter(e => !examRegIds.has(e.id)).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const upcomingAvailableExams = availableExams.filter(e => e.date >= today);
    const pastAvailableExams = availableExams.filter(e => e.date < today);
    const activeQuizzes = (data.quizzes || []).filter(q => enrolledIds.has(q.courseId) && q.published);
    const allGrades = (data.grades || []).filter(g => allStudentIds.has(g.studentId));
    const allSubs = (data.submissions || []).filter(s => allStudentIds.has(s.studentId));
    const submittedQuizIds = new Set(allSubs.map(s => s.quizId));
    const pendingQuizzes = activeQuizzes.filter(q => !submittedQuizIds.has(q.id));
    const completedQuizzes = activeQuizzes.filter(q => submittedQuizIds.has(q.id));
    const gradeKeys = new Set(allGrades.map(g => (g.quizId || '') + '|' + (g.examId || '')));
    const allScores = allGrades.map(g => {
        const exam = g.examId ? (data.exams || []).find(e => e.id === g.examId) : null;
        const quiz = !exam ? (data.quizzes || []).find(q => q.id === g.quizId) : null;
        const obj = exam || quiz;
        const course = (data.courses || []).find(c => c.id === g.courseId);
        const sub = allSubs.find(s => s.quizId === g.quizId || (g.examId && s.examId === g.examId));
        return { submission: sub || { score: g.score, grade: g.grade, submittedAt: g.gradedAt, pointsEarned: sub?.pointsEarned, totalPoints: sub?.totalPoints }, assessment: obj || { title: g.courseId, courseId: g.courseId, passMark: 50 }, course, grade: g, isExam: !!exam };
    });
    allSubs.forEach(s => {
        const key = (s.quizId || '') + '|' + (s.examId || '');
        if (gradeKeys.has(key)) return;
        const exam = s.examId ? (data.exams || []).find(e => e.id === s.examId) : null;
        const quiz = !exam ? (data.quizzes || []).find(q => q.id === s.quizId) : null;
        const obj = exam || quiz;
        const course = (data.courses || []).find(c => c.id === (obj?.courseId || quiz?.courseId));
        const gradeEntry = allGrades.find(g => g.quizId === s.quizId || (s.examId && g.examId === s.examId));
        allScores.push({
            submission: s,
            assessment: obj || { title: s.quizId, courseId: s.quizId, passMark: 50 },
            course,
            grade: gradeEntry || { score: s.score, grade: s.grade, gpa: 0, gradedAt: s.submittedAt },
            isExam: !!exam
        });
    });
    allScores.sort((a, b) => (b.submission?.submittedAt || b.grade?.gradedAt || '').localeCompare(a.submission?.submittedAt || a.grade?.gradedAt || ''));
    const myLessons = (data.lessons || []).filter(l => enrolledIds.has(l.courseId) && l.published !== false);
    const myNotes = (data.notes || []).filter(n => enrolledIds.has(n.courseId));
    return { me, data, studentId, enrolledIds, myCourses, availableCourses, examRegIds, myRegisteredExams, availableExams, upcomingRegisteredExams, pastRegisteredExams, upcomingAvailableExams, pastAvailableExams, pendingQuizzes, completedQuizzes, allScores, myLessons, myNotes };
}



function esc(s) { return escapeHtml(s == null ? '' : String(s)); }

function estimateReadTime(text) {
    if (!text) return 1;
    return Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length / 200));
}

async function renderStudentHub() {
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const content = document.getElementById('student-hub-content');
    if (!content) return;
    if (!currentUser || currentUser.role !== 'student') {
        content.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted);"><h3>Student Hub</h3><p>This area is for students only.</p></div>';
        return;
    }

    const hasCache = studentHubCache && Date.now() - studentHubCache.loadedAt < 300000;

    if (!hasCache) content.innerHTML = `
        <div style="position:relative;min-height:400px;display:flex;align-items:center;justify-content:center;">
            <div style="position:absolute;inset:0;background:rgba(255,255,255,0.7);backdrop-filter:blur(2px);border-radius:12px;z-index:5;"></div>
            <div style="position:relative;z-index:6;text-align:center;padding:40px;">
                <div style="width:40px;height:40px;border:4px solid #e2e8f0;border-top-color:var(--accent,#2563eb);border-radius:50%;animation:hub-load-spin 0.8s linear infinite;margin:0 auto 16px;"></div>
                <div style="font-size:14px;color:#475569;font-weight:500;">Preparing your dashboard...</div>
            </div>
        </div>
        <style>@keyframes hub-load-spin{to{transform:rotate(360deg)}}</style>`;

    try {
        const data = await loadStudentHubData();
        const me = (data.students || []).find(s =>
            s.id === currentUser.studentId || s.id === currentUser.username ||
            (s.phone && s.phone === currentUser.username) || s.email === currentUser.username
        );
        if (!me) { content.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted);"><h3>Profile not found</h3><p>Please contact the administrator to link your account.</p></div>'; return; }

        _hubStudent = me;
        _hubData = data;
        await _hubLoadTabData('overview');
        if (_hubComputedCache && _hubComputedCache.dataVersion === studentHubCache?.loadedAt && _hubComputedCache.meId === me.id) {
            _hubComputed = _hubComputedCache.computed;
        } else {
            _hubComputed = _hubBuildComputed(data, me);
            _hubComputedCache = { computed: _hubComputed, dataVersion: studentHubCache?.loadedAt, meId: me.id };
        }
        if (Object.keys(_hubLastRetakeStatuses).length === 0) {
            (data.retakeRequests || []).filter(r => r.studentId === me.id).forEach(r => { _hubLastRetakeStatuses[r.id] = r.status; });
        }
        _hubRenderedTabs = {};

        const c = _hubComputed;
        content.innerHTML = `
            <div style="background:linear-gradient(135deg,#1e3c72 0%,#2a5298 50%,#3a6ab8 100%);color:#fff;padding:28px 24px;border-radius:14px;margin-bottom:20px;box-shadow:0 6px 20px rgba(30,60,114,0.25);position:relative;overflow:hidden;">
                <div style="position:absolute;top:-40px;right:-40px;width:160px;height:160px;background:rgba(255,255,255,0.06);border-radius:50%;"></div>
                <div style="position:absolute;bottom:-60px;right:60px;width:120px;height:120px;background:rgba(255,255,255,0.04);border-radius:50%;"></div>
                <div style="position:relative;z-index:1;">
                    <div style="font-size:13px;opacity:0.85;margin-bottom:4px;">Welcome back,</div>
                    <h1 style="margin:0 0 6px 0;font-size:26px;font-weight:700;">${esc(me.name)}</h1>
                    <div style="font-size:13px;opacity:0.9;">${esc(me.admissionNumber || '')} · ${esc(me.program || 'No program assigned')}${me.year ? ' · Year ' + me.year : ''}</div>
                </div>
                <div id="hub-live-pill" style="position:absolute;top:14px;right:14px;display:flex;align-items:center;gap:6px;padding:6px 12px;background:rgba(255,255,255,0.95);border:1px solid rgba(255,255,255,0.5);border-radius:20px;font-size:12px;font-weight:600;color:#1e3c72;z-index:2;box-shadow:0 2px 6px rgba(0,0,0,0.15);">
                    <span id="hub-live-dot" style="width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 0 rgba(74,222,128,0.7);animation:hub-pulse 2s infinite;flex-shrink:0;"></span>
                    <span id="hub-live-text">Live</span>
                </div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px;">
                <div class="stat-card" style="cursor:pointer;" onclick="switchHubTab('courses')"><div class="stat-label">📚 Enrolled Courses</div><div class="stat-value" style="color:var(--success);">${c.myCourses.length}</div></div>
                <div class="stat-card" style="cursor:pointer;" onclick="switchHubTab('exams')"><div class="stat-label">📝 My Exams</div><div class="stat-value" style="color:var(--accent);">${c.myRegisteredExams.length}</div></div>
                <div class="stat-card" style="cursor:pointer;" onclick="switchHubTab('quizzes')"><div class="stat-label">📋 Pending Quizzes</div><div class="stat-value" style="color:var(--warning);">${c.pendingQuizzes.length}</div></div>
                <div class="stat-card" style="cursor:pointer;" onclick="switchHubTab('notes')"><div class="stat-label">📄 Study Notes</div><div class="stat-value">${c.myNotes.length}</div></div>
            </div>

            <div style="display:flex;gap:4px;margin-bottom:16px;border-bottom:2px solid var(--border);overflow-x:auto;">
                <button class="hub-tab active" data-tab="overview" onclick="switchHubTab('overview',this)" style="padding:10px 18px;border:none;background:none;border-bottom:3px solid var(--accent);color:var(--accent);font-weight:600;cursor:pointer;white-space:nowrap;font-size:13px;">Overview</button>
                <button class="hub-tab" data-tab="courses" onclick="switchHubTab('courses',this)" style="padding:10px 18px;border:none;background:none;border-bottom:3px solid transparent;color:var(--text-muted);font-weight:600;cursor:pointer;white-space:nowrap;font-size:13px;">📚 Courses</button>
                <button class="hub-tab" data-tab="exams" onclick="switchHubTab('exams',this)" style="padding:10px 18px;border:none;background:none;border-bottom:3px solid transparent;color:var(--text-muted);font-weight:600;cursor:pointer;white-space:nowrap;font-size:13px;">📝 Exams</button>
                <button class="hub-tab" data-tab="quizzes" onclick="switchHubTab('quizzes',this)" style="padding:10px 18px;border:none;background:none;border-bottom:3px solid transparent;color:var(--text-muted);font-weight:600;cursor:pointer;white-space:nowrap;font-size:13px;">📋 Quizzes</button>
                <button class="hub-tab" data-tab="notes" onclick="switchHubTab('notes',this)" style="padding:10px 18px;border:none;background:none;border-bottom:3px solid transparent;color:var(--text-muted);font-weight:600;cursor:pointer;white-space:nowrap;font-size:13px;">📄 Notes</button>
                <button class="hub-tab" data-tab="discussions" onclick="switchHubTab('discussions',this)" style="padding:10px 18px;border:none;background:none;border-bottom:3px solid transparent;color:var(--text-muted);font-weight:600;cursor:pointer;white-space:nowrap;font-size:13px;">💬 Discussions</button>
            </div>

            <div id="hub-tab-overview">${renderHubOverview(c.me, c.myCourses, c.upcomingRegisteredExams, c.pendingQuizzes, c.completedQuizzes, c.data)}</div>
            <div id="hub-tab-courses" style="display:none;"></div>
            <div id="hub-tab-exams" style="display:none;"></div>
            <div id="hub-tab-quizzes" style="display:none;"></div>
            <div id="hub-tab-notes" style="display:none;"></div>
            <div id="hub-tab-discussions" style="display:none;"><div class="card"><p style="color:var(--text-muted);text-align:center;padding:40px;">Loading discussions...</p></div></div>
        `;
        _hubRenderedTabs.overview = true;

        if (_hubActiveTab && _hubActiveTab !== 'overview') {
            switchHubTab(_hubActiveTab, null);
        }

        setTimeout(() => { _hubLastUpdate = Date.now(); _updateHubRefreshButton(); }, 0);
    } catch (err) {
        console.error('Student Hub error:', err);
        try {
            const fb = await loadStudentHubData();
            const me = (fb.students || []).find(s => s.id === currentUser.studentId || s.id === currentUser.username || s.email === currentUser.username || s.phone === currentUser.username);
            const enrolledIds = new Set((fb.enrollments || []).filter(e => e.studentId === (me?.id || '')).map(e => e.courseId));
            const examRegIds = new Set((fb.examRegistrations || []).filter(r => r.studentId === (me?.id || '')).map(r => r.examId));
            const upcomingExams = (fb.exams || []).filter(e => e.published !== false && enrolledIds.has(e.courseId) && (!me?.studyCenterId || !e.studyCenterId || e.studyCenterId === me.studyCenterId)).sort((a, b) => (a.date || '').localeCompare(b.date || '')).slice(0, 10);
            const courses = (fb.courses || []);
            content.innerHTML = `
                <div style="background:linear-gradient(135deg,#1e3c72,#2a5298);color:#fff;padding:24px;border-radius:12px;margin-bottom:16px;"><h2 style="margin:0 0 4px 0;">${me ? esc(me.name) : 'Student'}</h2><div style="font-size:13px;opacity:0.9;">${me ? esc(me.admissionNumber || '') : ''}</div></div>
                <h3 style="color:var(--accent);margin-bottom:12px;">📝 Upcoming Exams</h3>
                ${upcomingExams.length ? upcomingExams.map(e => { const course = courses.find(c => c.id === e.courseId); const r = examRegIds.has(e.id); return `<div class="card" style="margin-bottom:8px;border-left:4px solid ${r ? 'var(--success)' : 'var(--warning)'};"><div style="font-weight:700;">${esc(e.title || course?.code || 'Exam')}</div><div style="font-size:12px;color:var(--text-muted);margin-top:4px;">${course ? esc(course.name) : ''} — ${formatDate(e.date)} ${esc(e.time || '')}</div><span class="badge badge-${r ? 'success' : 'warning'}" style="margin-top:4px;">${r ? '✓ Registered' : 'Not registered'}</span></div>`; }).join('') : '<div style="color:var(--text-muted);padding:20px;text-align:center;">No upcoming exams.</div>'}
                <div style="text-align:center;margin-top:20px;"><a href="#" onclick="renderStudentHub();return false;" style="color:var(--accent);">Try full Hub →</a></div>`;
        } catch (fbErr) {
            content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--danger);">Error loading Student Hub. Please refresh the page.</div>';
        }
    }
}

async function switchHubTab(tab, btn) {
    _hubActiveTab = tab;
    document.querySelectorAll('.hub-tab').forEach(t => {
        t.classList.remove('active');
        t.style.borderBottomColor = 'transparent';
        t.style.color = 'var(--text-muted)';
    });
    if (btn) {
        btn.classList.add('active');
        btn.style.borderBottomColor = 'var(--accent)';
        btn.style.color = 'var(--accent)';
    } else {
        const target = document.querySelector(`.hub-tab[data-tab="${tab}"]`);
        if (target) { target.classList.add('active'); target.style.borderBottomColor = 'var(--accent)'; target.style.color = 'var(--accent)'; }
    }
    document.querySelectorAll('[id^="hub-tab-"]').forEach(el => el.style.display = 'none');
    const container = document.getElementById('hub-tab-' + tab);
    if (!_hubRenderedTabs[tab]) {
        let c = _hubComputed;
        if (!c) return;
        if (tab !== 'overview') await _hubLoadTabData(tab);
        if (tab !== 'overview' && studentHubCache && studentHubCache.loadedAt !== c.data?.loadedAt) {
            const me = _hubGetMe();
            if (me) { c = _hubBuildComputed(studentHubCache, me); _hubComputed = c; _hubComputedCache = { computed: c, dataVersion: studentHubCache.loadedAt, meId: me.id }; }
        }
        try {
            if (tab === 'courses') container.innerHTML = renderHubCourses(c.me, c.myCourses, c.availableCourses, c.data);
            else if (tab === 'exams') container.innerHTML = renderHubExams(c.me, c.upcomingRegisteredExams, c.pastRegisteredExams, c.upcomingAvailableExams, c.pastAvailableExams, c.data);
            else if (tab === 'quizzes') container.innerHTML = renderHubQuizzes(c.me, c.pendingQuizzes, c.completedQuizzes, c.data, c.allScores);
            else if (tab === 'notes') container.innerHTML = renderHubNotes(c.me, c.myCourses, c.myLessons, c.myNotes, c.data);
            else if (tab === 'discussions') { delete _hubRenderedTabs.discussions; container.style.display = 'block'; renderHubDiscussions(c.me, c.data); return; }
        } catch (e) { container.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Unable to load this section.</div>'; }
        _hubRenderedTabs[tab] = true;
    }
    container.style.display = 'block';
    if (tab === 'notes') renderHubNotesSearch();
}

function renderHubOverview(me, myCourses, myExams, pendingQuizzes, completedQuizzes, data) {
    const mySubmissions = (data.submissions || []).filter(s => s.studentId === me.id);
    const myPayments = (data.payments || []).filter(p => p.studentId === me.id);
    const totalPaid = myPayments.reduce((s, p) => s + (p.amount || 0), 0);
    const myAttendance = (data.attendance || []).filter(a => a.studentId === me.id);
    const attended = myAttendance.filter(a => a.status === 'present' || a.status === 'late').length;
    const attendancePct = myAttendance.length ? Math.round((attended / myAttendance.length) * 100) : 0;

    return `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;">
            <div class="card" style="border-top:3px solid var(--success);">
                <h3 style="color:var(--accent);margin-bottom:12px;display:flex;align-items:center;gap:8px;">📚 Recent Courses</h3>
                ${myCourses.length ? myCourses.slice(0, 4).map(c => `
                    <div class="event-item" style="padding:8px 0;">
                        <span><b>${esc(c.code)}</b> — ${esc(c.name)}</span>
                    </div>
                `).join('') : '<div style="color:var(--text-muted);padding:12px;text-align:center;">No courses yet. <a href="#" onclick="switchHubTab(\'courses\', document.querySelector(\'.hub-tab[data-tab=courses]\'));return false;" style="color:var(--accent);">Enroll now →</a></div>'}
            </div>

            <div class="card" style="border-top:3px solid var(--accent);">
                <h3 style="color:var(--accent);margin-bottom:12px;display:flex;align-items:center;gap:8px;">📝 Upcoming Exams</h3>
                ${myExams.length ? myExams.slice(0, 4).map(e => {
                    const course = myCourses.find(c => c.id === e.courseId);
                    return `<div class="event-item" style="padding:8px 0;">
                        <div><b>${esc(e.title || course?.code || 'Exam')}</b></div>
                        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${course ? esc(course.name) : ''} · ${formatDate(e.date)} ${esc(e.time || '')}</div>
                    </div>`;
                }).join('') : '<div style="color:var(--text-muted);padding:12px;text-align:center;">No exams registered. <a href="#" onclick="switchHubTab(\'exams\', document.querySelector(\'.hub-tab[data-tab=exams]\'));return false;" style="color:var(--accent);">Register →</a></div>'}
            </div>

            <div class="card" style="border-top:3px solid var(--warning);">
                <h3 style="color:var(--accent);margin-bottom:12px;display:flex;align-items:center;gap:8px;">📋 Pending Quizzes</h3>
                ${pendingQuizzes.length ? pendingQuizzes.slice(0, 4).map(q => {
                    const course = myCourses.find(c => c.id === q.courseId);
                    return `<div class="event-item" style="padding:8px 0;">
                        <div><b>${esc(q.title)}</b></div>
                        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${course ? esc(course.name) : q.courseId}</div>
                    </div>`;
                }).join('') : '<div style="color:var(--text-muted);padding:12px;text-align:center;">🎉 All quizzes completed!</div>'}
            </div>

            <div class="card" style="border-top:3px solid var(--info);">
                <h3 style="color:var(--accent);margin-bottom:12px;display:flex;align-items:center;gap:8px;">📊 My Stats</h3>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                    <div style="text-align:center;padding:8px;background:var(--bg-input);border-radius:6px;">
                        <div style="font-size:20px;font-weight:700;color:${attendancePct >= 75 ? 'var(--success)' : 'var(--danger)'};">${attendancePct}%</div>
                        <div style="font-size:10px;color:var(--text-muted);">Attendance</div>
                    </div>
                    <div style="text-align:center;padding:8px;background:var(--bg-input);border-radius:6px;">
                        <div style="font-size:20px;font-weight:700;color:var(--success);">${completedQuizzes.length}</div>
                        <div style="font-size:10px;color:var(--text-muted);">Quizzes Done</div>
                    </div>
                    <div style="text-align:center;padding:8px;background:var(--bg-input);border-radius:6px;">
                        <div style="font-size:20px;font-weight:700;color:var(--accent);">${myCourses.length}</div>
                        <div style="font-size:10px;color:var(--text-muted);">Courses</div>
                    </div>
                    <div style="text-align:center;padding:8px;background:var(--bg-input);border-radius:6px;">
                        <div style="font-size:20px;font-weight:700;color:var(--warning);">${pendingQuizzes.length}</div>
                        <div style="font-size:10px;color:var(--text-muted);">To Do</div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function renderHubCourses(me, myCourses, availableCourses, data) {
    return `
        <div style="margin-bottom:24px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <h3 style="color:var(--accent);margin:0;">📚 My Enrolled Courses <span style="color:var(--text-muted);font-weight:400;font-size:13px;">(${myCourses.length})</span></h3>
            </div>
            ${myCourses.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;">${myCourses.map(c => `
                <div class="card" style="border-left:4px solid var(--success);transition:box-shadow 0.2s;" onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.08)'" onmouseout="this.style.boxShadow=''">
                    <div style="font-weight:700;font-size:15px;color:var(--text);">${esc(c.code)}</div>
                    <div style="color:var(--text);font-size:13px;margin-top:4px;font-weight:500;">${esc(c.name)}</div>
                    ${c.description ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted);line-height:1.5;">${esc(c.description.substring(0, 120))}${c.description.length > 120 ? '...' : ''}</div>` : ''}
                    <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;">
                        <button class="btn btn-outline btn-sm" onclick="switchHubTab('notes', document.querySelector('.hub-tab[data-tab=notes]'))">📄 View Notes</button>
                        <button class="btn btn-outline btn-sm" onclick="hubDropCourse('${c.id}','${esc(me.name)}')" style="color:var(--danger);border-color:var(--danger);">Drop</button>
                    </div>
                </div>
            `).join('')}</div>` : '<div class="card" style="text-align:center;padding:40px;color:var(--text-muted);"><div style="font-size:40px;margin-bottom:8px;">📚</div><div>You haven\'t enrolled in any courses yet.</div><div style="font-size:12px;margin-top:8px;">Browse available courses below to get started.</div></div>'}
        </div>

        <div>
            <h3 style="color:var(--accent);margin-bottom:12px;">➕ Available Courses <span style="color:var(--text-muted);font-weight:400;font-size:13px;">(${availableCourses.length})</span></h3>
            ${availableCourses.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;">${availableCourses.map(c => `
                <div class="card" style="border-left:4px solid var(--accent);">
                    <div style="font-weight:700;font-size:15px;">${esc(c.code)}</div>
                    <div style="color:var(--text);font-size:13px;margin-top:4px;font-weight:500;">${esc(c.name)}</div>
                    ${c.description ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted);line-height:1.5;">${esc(c.description.substring(0, 120))}${c.description.length > 120 ? '...' : ''}</div>` : ''}
                    <div style="margin-top:12px;">
                        <button class="btn btn-primary btn-sm" onclick="hubEnrollCourse('${c.id}','${esc(me.name)}')">➕ Enroll Now</button>
                    </div>
                </div>
            `).join('')}</div>` : '<div class="card" style="text-align:center;padding:40px;color:var(--text-muted);">No more courses available for enrollment.</div>'}
        </div>
    `;
}

function _hubGetMe() {
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const data = studentHubCache;
    if (!data) return null;
    return (data.students || []).find(s => s.id === currentUser.studentId || s.id === currentUser.username || s.email === currentUser.username || s.phone === currentUser.username);
}

function _hubCachePush(store, record) {
    if (!studentHubCache || !studentHubCache[store]) return;
    const idx = studentHubCache[store].findIndex(r => r.id === record.id);
    if (idx >= 0) studentHubCache[store][idx] = record;
    else studentHubCache[store].push(record);
}

function _hubCacheRemove(store, id) {
    if (!studentHubCache || !studentHubCache[store]) return;
    studentHubCache[store] = studentHubCache[store].filter(r => r.id !== id);
}

async function hubEnrollCourse(courseId, studentName) {
    if (!await showConfirm('Enroll in Course', `Enroll ${studentName} in this course?`)) return;
    const data = studentHubCache || await loadStudentHubData();
    const me = _hubGetMe();
    if (!me) return showToast('Student profile not found', { type: 'danger' });
    if ((data.enrollments || []).find(e => e.studentId === me.id && e.courseId === courseId)) return showToast('Already enrolled');
    const record = { id: `ENR-${courseId}-${me.id}`, courseId, studentId: me.id, enrolledAt: new Date().toISOString() };
    await dbPut('enrollments', record);
    _hubCachePush('enrollments', record);
    showToast('✅ Enrolled!');
    logAudit('created', 'enrollment', { studentId: me.id, courseId });
    renderStudentHub();
}

async function hubDropCourse(courseId, studentName) {
    if (!await showConfirm('Drop Course', `Drop this course for ${studentName}?`)) return;
    const data = studentHubCache || await loadStudentHubData();
    const me = _hubGetMe();
    if (!me) return;
    const enr = (data.enrollments || []).find(e => e.studentId === me.id && e.courseId === courseId);
    if (enr) { await dbDelete('enrollments', enr.id); _hubCacheRemove('enrollments', enr.id); }
    showToast('Course dropped');
    logAudit('deleted', 'enrollment', { studentId: me.id, courseId });
    renderStudentHub();
}

function _hubExamStatus(exam) {
    if (!exam.date) return { status: 'upcoming', label: 'No date set', color: 'var(--text-muted)' };
    const now = new Date();
    const examDate = new Date(exam.date);
    let examStart = null, examEnd = null;
    if (exam.time) {
        const parts = exam.time.replace(/\s/g, '').split('-');
        const [sh, sm] = (parts[0] || '00:00').split(':').map(Number);
        examStart = new Date(exam.date);
        examStart.setHours(sh || 0, sm || 0, 0, 0);
        if (parts[1]) {
            const [eh, em] = parts[1].split(':').map(Number);
            examEnd = new Date(exam.date);
            examEnd.setHours(eh || 23, em || 59, 59, 999);
        } else {
            const dur = (exam.duration || 180) * 60000;
            examEnd = new Date(examStart.getTime() + dur);
        }
    } else {
        const dur = (exam.duration || 180) * 60000;
        examStart = new Date(exam.date);
        examStart.setHours(9, 0, 0, 0);
        examEnd = new Date(examStart.getTime() + dur);
    }
    const msUntil = examStart - now;
    const msAfter = now - examEnd;
    if (msAfter > 0) return { status: 'ended', label: 'Exam ended', color: 'var(--text-muted)', examStart, examEnd };
    if (msUntil <= 0 && msAfter <= 0) return { status: 'active', label: 'In Progress — Take Now!', color: 'var(--success)', examStart, examEnd };
    const mins = Math.floor(msUntil / 60000);
    if (mins <= 30) return { status: 'soon', label: `Starts in ${mins} min`, color: 'var(--warning)', examStart, examEnd };
    if (mins <= 1440) return { status: 'today', label: `Starts in ${Math.floor(mins / 60)}h ${mins % 60}m`, color: 'var(--accent)', examStart, examEnd };
    const days = Math.ceil(msUntil / 86400000);
    return { status: 'upcoming', label: `${days} day${days !== 1 ? 's' : ''} away`, color: days <= 7 ? 'var(--danger)' : days <= 30 ? 'var(--warning)' : 'var(--text-muted)', examStart, examEnd };
}

function renderHubExams(me, upcomingRegisteredExams, pastRegisteredExams, upcomingAvailableExams, pastAvailableExams, data) {
    const myCourses = (data.courses || []);
    const mySubmissions = (data.submissions || []).filter(s => s.studentId === me.id);
    const myRetakeRequests = (data.retakeRequests || []).filter(r => r.studentId === me.id);
    const approvedSuppIds = new Set(myRetakeRequests.filter(r => r.status === 'approved' && r.supplementaryExamId).map(r => r.supplementaryExamId));
    const displayUpcomingReg = upcomingRegisteredExams.filter(e => !(e.type === 'supplementary' && approvedSuppIds.has(e.id)));
    const pendingReqExamIds = new Set(myRetakeRequests.filter(r => r.status === 'pending').map(r => r.examId));

    function examCard(e, isRegistered, extra) {
        const course = myCourses.find(c => c.id === e.courseId);
        const exam = _hubExamStatus(e);
        const mySub = isRegistered ? mySubmissions.find(s => s.quizId === e.id || (e.linkedQuizId && s.quizId === e.linkedQuizId)) : null;
        const passed = mySub && mySub.status === 'pass';
        const typeLabel = e.type === 'final' ? '📄 Final' : e.type === 'supplementary' ? '🔄 Supplementary' : '📝 Midterm';
        const pendingRequest = myRetakeRequests.find(r => r.examId === e.id && r.status === 'pending');
        const approvedRequest = myRetakeRequests.find(r => r.examId === e.id && r.status === 'approved');
        const rejectedRequest = myRetakeRequests.find(r => r.examId === e.id && r.status === 'rejected');
        const suppExam = approvedRequest && approvedRequest.supplementaryExamId ? (data.exams || []).find(ex => ex.id === approvedRequest.supplementaryExamId) : null;
        const hasActiveSupp = suppExam && !passed;
        const canRequestRetake = exam.status === 'ended' && (!mySub || (mySub && !passed));
        let actionBtn = '';
        let borderColor = extra?.borderColor || 'var(--accent)';
        if (hasActiveSupp) {
            const suppStatus = _hubExamStatus(suppExam);
            borderColor = 'var(--success)';
            actionBtn = `<button class="btn btn-success btn-sm" onclick="startExam('${suppExam.id}')" style="font-size:13px;padding:8px 16px;font-weight:600;">🔄 Take Supplementary Exam</button><div style="font-size:11px;color:var(--text-muted);margin-top:4px;">📅 ${formatDate(suppExam.date)} ${esc(suppExam.time || '')} · ${suppStatus.label}</div>`;
        } else if (pendingRequest) {
            actionBtn = `<span class="badge badge-warning" style="font-size:11px;padding:4px 10px;">⏳ Request Pending</span>`;
        } else if (rejectedRequest) {
            actionBtn = `<span class="badge badge-danger" style="font-size:11px;padding:4px 10px;">❌ Re-take Rejected${rejectedRequest.adminNote ? ': ' + esc(rejectedRequest.adminNote) : ''}</span>`;
        } else if (isRegistered && canRequestRetake) {
            borderColor = 'var(--warning)';
            actionBtn = `<button class="btn btn-outline btn-sm" onclick="hubRequestRetake('${e.id}')" style="font-size:12px;border-color:var(--warning);color:var(--warning);">📋 Request Re-take</button>`;
        } else if (isRegistered && mySub) {
            borderColor = passed ? 'var(--success)' : 'var(--danger)';
            actionBtn = `<span class="badge badge-${passed ? 'success' : 'danger'}" style="font-size:12px;padding:6px 12px;">${passed ? '✅ Passed' : '❌ Failed'} — ${mySub.score || 0}%</span>`;
        } else if (isRegistered) {
            if (exam.status === 'active') borderColor = 'var(--success)';
            actionBtn = `<button class="btn btn-primary btn-sm" onclick="startExam('${e.id}')" style="font-size:12px;">📝 Take Exam</button>`;
        } else if (!isRegistered && e.date < (extra?.today || new Date().toISOString().split('T')[0]) && !pendingReqExamIds.has(e.id)) {
            borderColor = 'var(--warning)';
            actionBtn = `<button class="btn btn-outline btn-sm" onclick="hubRequestMissedExam('${e.id}')" style="font-size:12px;border-color:var(--warning);color:var(--warning);">📋 Request Exam</button>`;
        } else if (!isRegistered) {
            actionBtn = `<button class="btn btn-primary btn-sm" onclick="hubRegisterExam('${e.id}','${esc(me.name)}')">Register</button>`;
        }
        return `<div class="card" style="margin-bottom:10px;border-left:4px solid ${borderColor};">
            <div style="display:flex;justify-content:space-between;align-items:start;gap:12px;">
                <div style="flex:1;">
                    <div style="font-weight:700;font-size:15px;">${esc(e.title || course?.code || 'Exam')} <span class="badge badge-info" style="font-size:9px;">${typeLabel}</span></div>
                    <div style="color:var(--text);font-size:13px;margin-top:4px;">${course ? esc(course.name) : ''}</div>
                    <div style="display:flex;gap:12px;margin-top:8px;font-size:12px;color:var(--text-muted);flex-wrap:wrap;">
                        <span>📅 ${formatDate(e.date)}</span>
                        <span>🕐 ${esc(e.time || 'TBA')}</span>
                        <span>📍 ${esc(e.venue || 'TBA')}</span>
                        ${e.duration ? `<span>⏱ ${e.duration} min</span>` : ''}
                        <span style="color:${exam.color};font-weight:600;">${exam.label}</span>
                    </div>
                </div>
                <div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
                    ${actionBtn}
                    ${isRegistered && !mySub && !hasActiveSupp ? `<button class="btn btn-outline btn-sm" onclick="hubDropExam('${e.id}','${esc(me.name)}')" style="color:var(--danger);border-color:var(--danger);font-size:11px;">Drop</button>` : ''}
                </div>
            </div>
        </div>`;
    }

    return `
        <div style="margin-bottom:24px;">
            <h3 style="color:var(--accent);margin-bottom:12px;">📝 Upcoming Registered Exams <span style="color:var(--text-muted);font-weight:400;font-size:13px;">(${displayUpcomingReg.length})</span></h3>
            ${displayUpcomingReg.length ? displayUpcomingReg.map(e => examCard(e, true)).join('') : '<div class="card" style="text-align:center;padding:40px;color:var(--text-muted);">No upcoming registered exams.</div>'}
        </div>

        <div style="margin-bottom:24px;">
            <h3 style="color:var(--accent);margin-bottom:12px;">📋 Past Registered Exams <span style="color:var(--text-muted);font-weight:400;font-size:13px;">(${pastRegisteredExams.length})</span></h3>
            ${pastRegisteredExams.length ? pastRegisteredExams.map(e => examCard(e, true)).join('') : '<div class="card" style="text-align:center;padding:40px;color:var(--text-muted);">No past registered exams.</div>'}
        </div>

        <div style="margin-bottom:24px;">
            <h3 style="color:var(--accent);margin-bottom:12px;">➕ Upcoming Available Exams <span style="color:var(--text-muted);font-weight:400;font-size:13px;">(${upcomingAvailableExams.length})</span></h3>
            ${upcomingAvailableExams.length ? upcomingAvailableExams.map(e => examCard(e, false)).join('') : '<div class="card" style="text-align:center;padding:40px;color:var(--text-muted);">No upcoming exams available for registration.</div>'}
        </div>

        <div style="margin-bottom:24px;">
            <h3 style="color:var(--accent);margin-bottom:12px;">📋 Missed Exams <span style="color:var(--text-muted);font-weight:400;font-size:13px;">(${pastAvailableExams.length})</span></h3>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">Missed an exam or registered late? Click "Request Exam" to ask for a supplementary session.</div>
            ${pastAvailableExams.length ? pastAvailableExams.map(e => examCard(e, false, { today: new Date().toISOString().split('T')[0] })).join('') : '<div class="card" style="text-align:center;padding:40px;color:var(--text-muted);">No missed exams.</div>'}
        </div>

        ${renderHubRetakeRequests(myRetakeRequests)}
    `;
}

async function hubRegisterExam(examId, studentName) {
    if (!await showConfirm('Register for Exam', `Register ${studentName} for this exam?`)) return;
    const me = _hubGetMe();
    if (!me) return;
    const data = studentHubCache || await loadStudentHubData();
    if ((data.examRegistrations || []).find(r => r.studentId === me.id && r.examId === examId)) return showToast('Already registered');
    const allSeats = (data.seating || []).filter(s => s.examId === examId);
    const maxSeat = allSeats.reduce((m, s) => Math.max(m, s.seatNumber || 0), 0);
    const regRecord = { id: `EXREG-${examId}-${me.id}`, examId, studentId: me.id, registeredAt: new Date().toISOString() };
    const seatRecord = { id: `SEAT-${examId}-${me.id}`, examId, studentId: me.id, seatNumber: maxSeat + 1, createdAt: new Date().toISOString() };
    await Promise.all([dbPut('examRegistrations', regRecord), dbPut('seating', seatRecord)]);
    _hubCachePush('examRegistrations', regRecord);
    _hubCachePush('seating', seatRecord);
    showToast('✅ Registered!');
    logAudit('created', 'examRegistration', { studentId: me.id, examId });
    renderStudentHub();
}

async function hubDropExam(examId, studentName) {
    if (!await showConfirm('Drop Exam', `Drop this exam for ${studentName}?`)) return;
    const me = _hubGetMe();
    if (!me) return;
    const data = studentHubCache || await loadStudentHubData();
    const reg = (data.examRegistrations || []).find(r => r.studentId === me.id && r.examId === examId);
    if (reg) { await dbDelete('examRegistrations', reg.id); _hubCacheRemove('examRegistrations', reg.id); }
    showToast('Exam dropped');
    logAudit('deleted', 'examRegistration', { studentId: me.id, examId });
    renderStudentHub();
}

async function hubRequestMissedExam(examId) {
    const me = _hubGetMe();
    if (!me) return showToast('Could not identify your student profile', { type: 'danger' });
    const data = studentHubCache || await loadStudentHubData();
    const exam = (data.exams || []).find(e => e.id === examId);
    if (!exam) return showToast('Exam not found', { type: 'danger' });
    const course = (data.courses || []).find(c => c.id === exam.courseId);
    const existing = (data.retakeRequests || []).find(r => r.studentId === me.id && r.examId === examId && r.status === 'pending');
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
    showModal('Request Exam', content, `<button class="btn btn-primary" onclick="hubSubmitMissedRequest('${examId}')">Submit Request</button>`);
}

async function hubSubmitMissedRequest(examId) {
    const reason = document.getElementById('missed-reason')?.value.trim();
    if (!reason) return showToast('Please provide a reason', { type: 'danger' });
    const me = _hubGetMe();
    if (!me) return showToast('Could not identify your student profile', { type: 'danger' });
    const data = studentHubCache || await loadStudentHubData();
    const existing = (data.retakeRequests || []).find(r => r.studentId === me.id && r.examId === examId && r.status === 'pending');
    if (existing) return showToast('You already have a pending request for this exam', { type: 'warning' });
    const record = { id: `RET-${examId}-${me.id}`, examId, studentId: me.id, reason, status: 'pending', requestType: 'missed', createdAt: new Date().toISOString() };
    await dbPut('retakeRequests', record);
    _hubCachePush('retakeRequests', record);
    closeModal();
    showToast('✅ Request submitted. Awaiting admin approval.');
    logAudit('created', 'retakeRequest', { studentId: me.id, examId, requestType: 'missed' });
    renderStudentHub();
}

function hubRequestRetake(examId) {
    const data = studentHubCache;
    const exam = (data?.exams || []).find(e => e.id === examId);
    const course = exam ? (data?.courses || []).find(c => c.id === exam.courseId) : null;
    const examTitle = exam?.title || course?.code || 'Exam';
    const content = `
        <div style="margin-bottom:16px;">
            <div style="padding:12px;background:var(--bg-input);border-radius:8px;margin-bottom:16px;">
                <div style="font-weight:600;font-size:14px;margin-bottom:4px;">📝 ${esc(examTitle)}</div>
                <div style="font-size:12px;color:var(--text-muted);">Your request will be sent to the admin for approval. If approved, a supplementary exam will be scheduled.</div>
            </div>
            <div class="form-group">
                <label>Reason for re-take request *</label>
                <textarea id="retake-reason" rows="4" placeholder="Explain why you missed the exam..." style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13px;resize:vertical;"></textarea>
            </div>
        </div>
    `;
    showModal('Request Re-take', content, `<button class="btn btn-primary" onclick="hubSubmitRetakeRequest('${examId}')">Submit Request</button>`);
}

async function hubSubmitRetakeRequest(examId) {
    const reason = document.getElementById('retake-reason')?.value.trim();
    if (!reason) return showToast('Please provide a reason', { type: 'danger' });
    const data = studentHubCache || await loadStudentHubData();
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const me = (data.students || []).find(s => s.id === currentUser.studentId || s.id === currentUser.username || s.email === currentUser.username || s.phone === currentUser.username);
    if (!me) { console.error('hubSubmitRetakeRequest: student not found', currentUser); return showToast('Could not identify student', { type: 'danger' }); }
    const existing = (data.retakeRequests || []).find(r => r.studentId === me.id && r.examId === examId && r.status === 'pending');
    if (existing) return showToast('You already have a pending request for this exam', { type: 'warning' });
    const record = {
        id: `RET-${examId}-${me.id}`,
        examId,
        studentId: me.id,
        reason,
        status: 'pending',
        createdAt: new Date().toISOString()
    };
    console.log('hubSubmitRetakeRequest: saving', record);
    try {
        await dbPut('retakeRequests', record);
    } catch(e) { console.error('hubSubmitRetakeRequest: dbPut failed', e); return showToast('Failed to submit request: ' + e.message, { type: 'danger' }); }
    _hubCachePush('retakeRequests', record);
    _hubLastRetakeStatuses[record.id] = 'pending';
    closeModal();
    showToast('✅ Request submitted!');
    logAudit('created', 'retakeRequest', { studentId: me.id, examId });
    renderStudentHub();
}

function renderHubRetakeRequests(data) {
    if (!data || !data.length) return '';
    return `
        <div style="margin-top:24px;">
            <h3 style="color:var(--accent);margin-bottom:12px;">📋 Retake Requests <span style="color:var(--text-muted);font-weight:400;font-size:13px;">(${data.length})</span></h3>
            ${data.map(r => {
                const exam = _hubComputed?.data?.exams?.find(e => e.id === r.examId);
                const statusColors = { pending: 'var(--warning)', approved: 'var(--success)', rejected: 'var(--danger)' };
                const statusLabels = { pending: '⏳ Pending', approved: '✅ Approved', rejected: '❌ Rejected' };
                return `<div class="card" style="margin-bottom:10px;border-left:4px solid ${statusColors[r.status] || 'var(--text-muted)'};">
                    <div style="display:flex;justify-content:space-between;align-items:start;gap:12px;">
                        <div style="flex:1;">
                            <div style="font-weight:700;font-size:14px;">${esc(exam?.title || exam?.courseId || 'Exam')}</div>
                            <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">${esc(r.reason.substring(0, 100))}${r.reason.length > 100 ? '...' : ''}</div>
                            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Submitted: ${formatDate(r.createdAt)}</div>
                            ${r.adminNote ? `<div style="font-size:11px;color:var(--accent);margin-top:4px;">Admin: ${esc(r.adminNote)}</div>` : ''}
                        </div>
                        <span class="badge" style="background:${statusColors[r.status]};color:#fff;font-size:11px;padding:4px 10px;">${statusLabels[r.status] || r.status}</span>
                    </div>
                </div>`;
            }).join('')}
        </div>
    `;
}

function renderHubQuizzes(me, pendingQuizzes, completedQuizzes, data, allScores) {
    const myCourses = (data.courses || []);
    const quizScores = allScores.filter(s => !s.isExam);
    const examScores = allScores.filter(s => s.isExam);
    const totalScores = allScores.length;
    const passedCount = allScores.filter(s => {
        const passMark = s.assessment?.passMark || 50;
        return (s.grade?.score || s.submission?.score || 0) >= passMark;
    }).length;
    const failedCount = totalScores - passedCount;
    const avgScore = totalScores > 0 ? Math.round(allScores.reduce((sum, s) => sum + (s.grade?.score || s.submission?.score || 0), 0) / totalScores) : 0;
    return `
        <div style="margin-bottom:24px;">
            <h3 style="color:var(--accent);margin-bottom:12px;">📋 Pending Quizzes <span style="color:var(--text-muted);font-weight:400;font-size:13px;">(${pendingQuizzes.length})</span></h3>
            ${pendingQuizzes.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;">${pendingQuizzes.map(q => {
                const course = myCourses.find(c => c.id === q.courseId);
                return `<div class="card" style="border-left:4px solid var(--warning);">
                    <div style="display:flex;justify-content:space-between;align-items:start;gap:8px;">
                        <div style="flex:1;">
                            <div style="font-weight:700;font-size:15px;">${esc(q.title)}</div>
                            <div style="color:var(--text);font-size:13px;margin-top:4px;">${course ? esc(course.name) : esc(q.courseId)}</div>
                            ${q.dueDate ? `<div style="font-size:11px;color:var(--warning);margin-top:6px;">⏰ Due: ${formatDate(q.dueDate)}</div>` : ''}
                        </div>
                        <span class="badge badge-warning">Pending</span>
                    </div>
                    <div style="margin-top:10px;">
                        <button class="btn btn-primary btn-sm" onclick="hubGoToQuiz('${q.id}')">Take Quiz →</button>
                    </div>
                </div>`;
            }).join('')}</div>` : '<div class="card" style="text-align:center;padding:40px;color:var(--text-muted);"><div style="font-size:40px;margin-bottom:8px;">🎉</div><div>All quizzes completed!</div><div style="font-size:12px;margin-top:8px;">Great job staying on top of your work.</div></div>'}
        </div>

        <div style="margin-bottom:24px;">
            <h3 style="color:var(--accent);margin-bottom:16px;">📊 Your Grades</h3>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px;">
                <div class="card" style="text-align:center;padding:16px;border-top:3px solid var(--accent);">
                    <div style="font-size:28px;font-weight:800;color:var(--accent);">${totalScores}</div>
                    <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Total Scores</div>
                </div>
                <div class="card" style="text-align:center;padding:16px;border-top:3px solid var(--success);">
                    <div style="font-size:28px;font-weight:800;color:var(--success);">${passedCount}</div>
                    <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Passed</div>
                </div>
                <div class="card" style="text-align:center;padding:16px;border-top:3px solid var(--danger);">
                    <div style="font-size:28px;font-weight:800;color:var(--danger);">${failedCount}</div>
                    <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Failed</div>
                </div>
                <div class="card" style="text-align:center;padding:16px;border-top:3px solid var(--info);">
                    <div style="font-size:28px;font-weight:800;color:var(--info);">${avgScore}%</div>
                    <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Average</div>
                </div>
            </div>

            <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
                <button class="btn btn-sm ${!window._hubScoreFilter || window._hubScoreFilter === 'all' ? 'btn-primary' : 'btn-outline'}" onclick="window._hubScoreFilter='all';_hubRenderTab('quizzes')">All (${totalScores})</button>
                <button class="btn btn-sm ${window._hubScoreFilter === 'quiz' ? 'btn-primary' : 'btn-outline'}" onclick="window._hubScoreFilter='quiz';_hubRenderTab('quizzes')">Quizzes (${quizScores.length})</button>
                <button class="btn btn-sm ${window._hubScoreFilter === 'exam' ? 'btn-primary' : 'btn-outline'}" onclick="window._hubScoreFilter='exam';_hubRenderTab('quizzes')">Exams (${examScores.length})</button>
            </div>

            ${allScores.length ? `
            <div class="card" style="overflow-x:auto;padding:0;">
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="background:var(--bg-input);border-bottom:2px solid var(--border);">
                            <th style="padding:10px 12px;text-align:left;font-weight:600;">#</th>
                            <th style="padding:10px 12px;text-align:left;font-weight:600;">Assessment</th>
                            <th style="padding:10px 12px;text-align:left;font-weight:600;">Course</th>
                            <th style="padding:10px 12px;text-align:left;font-weight:600;">Type</th>
                            <th style="padding:10px 12px;text-align:center;font-weight:600;">Score</th>
                            <th style="padding:10px 12px;text-align:center;font-weight:600;">Grade</th>
                            <th style="padding:10px 12px;text-align:center;font-weight:600;">Points</th>
                            <th style="padding:10px 12px;text-align:center;font-weight:600;">Pass Mark</th>
                            <th style="padding:10px 12px;text-align:center;font-weight:600;">Status</th>
                            <th style="padding:10px 12px;text-align:center;font-weight:600;">Date</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${allScores.filter(s => {
                            if (window._hubScoreFilter === 'quiz') return !s.isExam;
                            if (window._hubScoreFilter === 'exam') return s.isExam;
                            return true;
                        }).map((s, idx) => {
                            const { grade: g, assessment: obj, course, isExam } = s;
                            const pct = g.score || 0;
                            const passMark = obj.passMark || 50;
                            const passed = pct >= passMark;
                            const gradeLabel = g.grade || '--';
                            const typeLabel = isExam ? (obj.type === 'supplementary' ? 'Supplementary' : obj.type === 'final' ? 'Final Exam' : obj.type === 'midterm' ? 'Midterm' : 'Exam') : (obj.assessmentType === 'cat' ? 'CAT' : obj.assessmentType === 'exam' ? 'Exam Quiz' : 'Quiz');
                            const typeBadge = isExam ? 'badge-danger' : 'badge-info';
                            const rowBg = idx % 2 === 1 ? 'background:var(--bg-input);' : '';
                            return `<tr style="${rowBg}border-bottom:1px solid var(--border);">
                                <td style="padding:10px 12px;color:var(--text-muted);">${idx + 1}</td>
                                <td style="padding:10px 12px;font-weight:600;">${esc(obj.title || 'Untitled')}</td>
                                <td style="padding:10px 12px;">${course ? esc(course.code || course.name) : '--'}</td>
                                <td style="padding:10px 12px;"><span class="badge ${typeBadge}" style="font-size:10px;">${typeLabel}</span></td>
                                <td style="padding:10px 12px;text-align:center;font-weight:700;color:${passed ? 'var(--success)' : 'var(--danger)'};">${pct}%</td>
                                <td style="padding:10px 12px;text-align:center;font-weight:600;">${gradeLabel}</td>
                                <td style="padding:10px 12px;text-align:center;">${parseFloat(g.gpa || 0).toFixed(2)}</td>
                                <td style="padding:10px 12px;text-align:center;">${passMark}%</td>
                                <td style="padding:10px 12px;text-align:center;"><span class="badge badge-${passed ? 'success' : 'danger'}" style="font-size:10px;">${passed ? 'Pass' : 'Fail'}</span></td>
                                <td style="padding:10px 12px;text-align:center;font-size:11px;color:var(--text-muted);">${formatDate(g.gradedAt)}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            ` : '<div class="card" style="text-align:center;padding:40px;color:var(--text-muted);"><div style="font-size:40px;margin-bottom:8px;">📝</div><div>No scores yet</div><div style="font-size:12px;margin-top:8px;">Complete quizzes and exams to see your grades here.</div></div>'}
        </div>
    `;
}

function _hubRenderTab(tab) {
    const c = _hubComputed;
    if (!c) return;
    const el = document.getElementById('hub-tab-' + tab);
    if (!el) return;
    if (tab === 'quizzes') el.innerHTML = renderHubQuizzes(c.me, c.pendingQuizzes, c.completedQuizzes, c.data, c.allScores);
    else if (tab === 'exams') el.innerHTML = renderHubExams(c.me, c.myRegisteredExams, c.availableExams, c.data);
    else if (tab === 'courses') el.innerHTML = renderHubCourses(c.me, c.myCourses, c.availableCourses, c.data);
    else if (tab === 'notes') el.innerHTML = renderHubNotes(c.me, c.myCourses, c.myLessons, c.myNotes, c.data);
    else if (tab === 'discussions') renderHubDiscussions(c.me, c.data);
}
async function renderHubDiscussions(me, data) {
    const container = document.getElementById('hub-tab-discussions');
    if (!container) return;
    if (!me || !data) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);"><div style="font-size:40px;margin-bottom:8px;">💬</div><div>No discussions available.</div></div>';
        return;
    }
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const userId = currentUser.studentId || currentUser.username;
    const myCourses = (data.courses || []).filter(c => (data.enrollments || []).find(e => e.studentId === me.id && e.courseId === c.id));

    let html = '<div style="margin-bottom:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><select id="hub-disc-course" class="filter-select" style="flex:1;min-width:200px;max-width:400px;" onchange="renderHubDiscussions(_hubGetMe(),_hubData)"><option value="">All My Courses</option>' + myCourses.map(c => '<option value="' + esc(c.id) + '">' + esc(c.code) + ' — ' + esc(c.name) + '</option>').join('') + '</select>';
    html += '<button class="btn btn-primary btn-sm" onclick="' + (myCourses.length ? 'var e=document.getElementById(\'hub-disc-course\');showNewDiscussionModal(e?e.value:\'\')' : 'showToast(\'You are not enrolled in any courses yet\',{type:\'warning\'})') + '">+ New Discussion</button></div>';

    if (!myCourses.length) {
        html += '<div style="text-align:center;padding:40px;color:var(--text-muted);"><div style="font-size:40px;margin-bottom:8px;">📚</div><div>Enroll in courses first to start or join discussions.</div><button class="btn btn-primary" style="margin-top:12px;" onclick="switchHubTab(\'courses\',document.querySelector(\'.hub-tab[data-tab=courses]\'))">Browse Courses</button></div>';
        container.innerHTML = html;
        return;
    }

    try {
        const selected = document.getElementById('hub-disc-course')?.value || '';
        const courseIds = selected ? [selected] : myCourses.map(c => c.id);
        const results = await Promise.all(courseIds.map(cid =>
            fetch('/api/discussions/' + encodeURIComponent(cid)).then(r => r.ok ? r.json() : Promise.reject('HTTP ' + r.status)).then(d => (d.messages || []).map(m => ({ ...m, courseId: cid }))).catch(() => [])
        ));
        const allMessages = results.flat().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.timestamp) - new Date(a.timestamp));

        if (!allMessages.length) {
            html += '<div style="text-align:center;padding:40px;color:var(--text-muted);"><div style="font-size:40px;margin-bottom:8px;">💬</div><div>No discussions yet in your courses.</div></div>';
        } else {
            html += '<div style="display:flex;flex-direction:column;gap:10px;">';
            allMessages.forEach(m => {
                const course = data.courses.find(c => c.id === m.courseId);
                const courseLabel = course ? esc(course.code) : '';
                const date = new Date(m.timestamp).toLocaleString();
                const likes = m.likes || [];
                const replies = m.replies || [];
                const liked = likes.includes(userId);
                const replyFormId = 'hub-reply-form-' + m.id;
                const repliesId = 'hub-replies-' + m.id;

                html += '<div class="card" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;border-left:4px solid ' + (m.pinned ? 'var(--accent)' : m.locked ? 'var(--danger)' : 'var(--border)') + ';font-size:13px;">' +
                    '<div>' +
                        (m.pinned ? '<span style="font-size:10px;background:var(--accent);color:#fff;padding:1px 6px;border-radius:3px;font-weight:600;">📌 Pinned</span>' : '') +
                        '<div style="font-weight:600;font-size:13px;">' + esc(m.userName) + ' <span style="font-weight:400;font-size:11px;color:var(--text-muted);">(' + esc(m.userRole) + ') · ' + courseLabel + '</span></div>' +
                        '<div style="margin-top:6px;line-height:1.5;white-space:pre-wrap;">' + esc(m.content) + '</div>' +
                        '<div style="margin-top:4px;font-size:10px;color:var(--text-muted);">' + date + '</div>' +
                        '<div style="display:flex;gap:10px;margin-top:8px;padding-top:6px;border-top:1px solid var(--border);align-items:center;">' +
                            '<button class="btn btn-sm ' + (liked ? 'btn-primary' : 'btn-outline') + '" onclick="hubToggleLike(\'' + m.id + '\',\'' + m.courseId + '\')" style="font-size:10px;padding:3px 8px;">' +
                                '👍 <span id="hub-like-count-' + m.id + '">' + likes.length + '</span>' +
                            '</button>' +
                            (!m.locked ? '<button class="btn btn-sm btn-outline" onclick="hubShowReplyForm(\'' + m.id + '\')" style="font-size:10px;padding:3px 8px;">💬 Reply</button>' : '') +
                            '<span style="font-size:10px;color:var(--text-muted);">' + replies.length + ' ' + (replies.length === 1 ? 'reply' : 'replies') + '</span>' +
                        '</div>' +
                    '</div>' +
                    '<div style="border-left:1px solid var(--border);padding-left:12px;">' +
                        '<div id="' + repliesId + '">' +
                            replies.map(function(r) {
                                return '<div style="padding:5px 0;border-bottom:1px solid var(--bg);font-size:12px;">' +
                                    '<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">' +
                                        '<span style="font-weight:600;">' + esc(r.userName) + '</span>' +
                                        '<span class="badge badge-info" style="font-size:8px;">' + esc(r.userRole) + '</span>' +
                                        '<span style="font-size:9px;color:var(--text-muted);">' + new Date(r.timestamp).toLocaleString() + '</span>' +
                                    '</div>' +
                                    '<div style="margin-top:2px;line-height:1.5;white-space:pre-wrap;">' + esc(r.content) + '</div>' +
                                '</div>';
                            }).join('') +
                            '<div id="' + replyFormId + '" style="display:none;margin-top:6px;">' +
                                '<textarea rows="2" placeholder="Write a reply..." style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-size:12px;resize:vertical;box-sizing:border-box;"></textarea>' +
                                '<div style="display:flex;gap:6px;margin-top:5px;">' +
                                    '<button class="btn btn-primary btn-sm" onclick="hubSubmitReply(\'' + m.id + '\',\'' + m.courseId + '\')" style="font-size:10px;padding:3px 10px;">Post Reply</button>' +
                                    '<button class="btn btn-sm btn-outline" onclick="hubHideReplyForm(\'' + m.id + '\')" style="font-size:10px;padding:3px 10px;">Cancel</button>' +
                                '</div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            });
            html += '</div>';
        }
    } catch (e) {
        console.error('renderHubDiscussions error:', e);
        html += '<div style="color:var(--danger);padding:20px;text-align:center;">Error loading discussions.</div>';
    }

    container.innerHTML = html;
}

function hubShowReplyForm(messageId) {
    const form = document.getElementById('hub-reply-form-' + messageId);
    if (form) form.style.display = 'block';
}

function hubHideReplyForm(messageId) {
    const form = document.getElementById('hub-reply-form-' + messageId);
    if (form) {
        form.style.display = 'none';
        const ta = form.querySelector('textarea');
        if (ta) ta.value = '';
    }
}

async function hubSubmitReply(messageId, courseId) {
    const form = document.getElementById('hub-reply-form-' + messageId);
    if (!form) return;
    const ta = form.querySelector('textarea');
    const content = ta?.value.trim();
    if (!content) return showToast('Reply cannot be empty!', { type: 'danger' });

    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const userName = currentUser.name || currentUser.username || 'Unknown';
    const userId = currentUser.studentId || currentUser.username;
    const userRole = currentUser.role || 'student';

    try {
        await fetch('/api/discussions/' + encodeURIComponent(courseId) + '/' + messageId, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reply', userId, userName, userRole, content })
        });
        showToast('Reply posted!');
        renderHubDiscussions(_hubGetMe(), _hubData);
    } catch (err) {
        showToast('Failed to reply: ' + err.message, { type: 'danger' });
    }
}

async function hubToggleLike(messageId, courseId) {
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const userId = currentUser.studentId || currentUser.username;
    if (!userId) return showToast('Could not identify user', { type: 'danger' });

    try {
        await fetch('/api/discussions/' + encodeURIComponent(courseId) + '/' + messageId, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'like', userId, userRole: currentUser.role })
        });
        renderHubDiscussions(_hubGetMe(), _hubData);
    } catch (err) {
        showToast('Failed: ' + err.message, { type: 'danger' });
    }
}

function hubGoToQuiz(quizId) {
    if (typeof startQuiz === 'function') {
        startQuiz(quizId);
    } else {
        showScreen('quizzes');
        setTimeout(() => {
            const quizEl = document.querySelector(`[data-quiz-id="${quizId}"]`) || document.querySelector(`[onclick*="${quizId}"]`);
            if (quizEl) quizEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 500);
    }
}

function renderHubNotes(me, myCourses, myLessons, myNotes, data) {
    if (!myCourses.length) {
        return '<div class="card" style="text-align:center;padding:60px;color:var(--text-muted);"><div style="font-size:48px;margin-bottom:12px;">📄</div><h3 style="margin-bottom:8px;">No Notes Available</h3><p>Enroll in courses to access study notes.</p></div>';
    }
    const readLessons = safeGetLocal('read-lessons-' + me.id, {});
    let html = `
        <div style="margin-bottom:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input type="text" id="hub-notes-search" placeholder="🔍 Search notes..." oninput="filterHubNotes()" style="flex:1;min-width:200px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13px;">
            <select id="hub-notes-filter" onchange="filterHubNotes()" style="padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13px;">
                <option value="all">All Courses</option>
                ${myCourses.map(c => `<option value="${esc(c.id)}">${esc(c.code)}</option>`).join('')}
            </select>
        </div>
        <div id="hub-notes-list">
    `;
    myCourses.forEach(course => {
        const courseLessons = myLessons.filter(l => l.courseId === course.id).sort((a, b) => (a.order || 0) - (b.order || 0));
        const courseNotes = myNotes.filter(n => n.courseId === course.id);
        const lessonIds = courseLessons.map(l => l.id);
        const totalRead = courseLessons.filter(l => readLessons[l.id]).length;
        const progressPct = courseLessons.length ? Math.round((totalRead / courseLessons.length) * 100) : 0;
        html += `
            <div class="hub-note-course" data-course-id="${esc(course.id)}" style="margin-bottom:20px;">
                <div class="card" style="border-top:3px solid var(--accent);">
                    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
                        <div>
                            <h3 style="color:var(--accent);margin:0 0 4px 0;">${esc(course.code)} — ${esc(course.name)}</h3>
                            <div style="color:var(--text-muted);font-size:12px;">${courseLessons.length} lesson${courseLessons.length !== 1 ? 's' : ''} · ${courseNotes.length} note${courseNotes.length !== 1 ? 's' : ''} · ${totalRead}/${courseLessons.length} read</div>
                        </div>
                        ${courseLessons.length ? `<div style="min-width:140px;">
                            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Progress: ${progressPct}%</div>
                            <div style="height:6px;background:var(--bg-input);border-radius:3px;overflow:hidden;">
                                <div style="height:100%;background:linear-gradient(90deg,var(--success),var(--accent));width:${progressPct}%;transition:width 0.3s;"></div>
                            </div>
                        </div>` : ''}
                    </div>
                    ${courseLessons.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;">${courseLessons.map(l => {
                        const lessonNote = courseNotes.find(n => n.lessonId === l.id);
                        const generalNotes = courseNotes.filter(n => !n.lessonId);
                        const content = lessonNote?.content || l.description || l.reference || '';
                        const readTime = estimateReadTime(content);
                        const isRead = readLessons[l.id];
                        const hasVideo = !!l.videoUrl;
                        const videoLocked = hasVideo && !isRead;
                        return `
                            <div class="hub-note-card" data-search="${esc((l.title + ' ' + (l.description || '') + ' ' + (lessonNote?.title || '') + ' ' + (lessonNote?.content || '')).toLowerCase())}" onclick="viewHubLessonNote('${l.id}','${esc(course.id)}')" style="border:1px solid ${isRead ? 'var(--success)' : 'var(--border)'};border-radius:10px;padding:14px;cursor:pointer;transition:all 0.2s;background:var(--bg-card);" onmouseover="this.style.borderColor='var(--accent)';this.style.transform='translateY(-2px)';this.style.boxShadow='0 4px 12px rgba(0,0,0,0.08)';" onmouseout="this.style.borderColor='${isRead ? 'var(--success)' : 'var(--border)'}';this.style.transform='';this.style.boxShadow='';">
                                <div style="display:flex;justify-content:space-between;align-items:start;gap:8px;margin-bottom:6px;">
                                    <div style="font-weight:600;font-size:14px;line-height:1.3;">${isRead ? '✅' : hasVideo ? '🎬' : '📖'} ${esc(l.title)}</div>
                                    ${hasVideo ? '<span style="background:var(--accent);color:#fff;font-size:9px;font-weight:700;padding:2px 7px;border-radius:4px;white-space:nowrap;">VIDEO</span>' : ''}
                                </div>
                                ${l.description ? `<div style="color:var(--text-muted);font-size:12px;line-height:1.4;margin-bottom:8px;">${esc(l.description.substring(0, 90))}${l.description.length > 90 ? '...' : ''}</div>` : ''}
                                <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--text-muted);">
                                    <span>${hasVideo ? '🎬 Video lesson' : '⏱ ' + readTime + ' min read'}</span>
                                    ${hasVideo ? (videoLocked ? '<span style="color:var(--text-muted);font-size:10px;">🔒 Read notes first</span>' : '<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();viewStudentLesson(\'' + l.id + '\')" style="padding:4px 12px;font-size:11px;font-weight:600;">▶ Watch Now</button>') : (lessonNote ? '<span style="color:var(--success);">📄 Notes</span>' : '<span>No notes yet</span>')}
                                </div>
                            </div>
                        `;
                    }).join('')}</div>` : '<div style="color:var(--text-muted);padding:12px;text-align:center;">No lessons published yet.</div>'}
                    ${courseNotes.filter(n => !n.lessonId).length ? `<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border);">
                        <h4 style="font-size:12px;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">📄 General Notes</h4>
                        ${courseNotes.filter(n => !n.lessonId).map(n => `
                            <div class="hub-note-card event-item" data-search="${esc((n.title + ' ' + (n.content || '')).toLowerCase())}" onclick="viewHubNote('${n.id}')" style="cursor:pointer;padding:10px;border-radius:6px;margin-bottom:4px;" onmouseover="this.style.background='var(--bg-input)'" onmouseout="this.style.background=''">
                                <div style="display:flex;justify-content:space-between;align-items:center;">
                                    <span><b>${esc(n.title)}</b></span>
                                    <span style="color:var(--text-muted);font-size:11px;">${formatDate(n.createdAt)}</span>
                                </div>
                            </div>
                        `).join('')}
                    </div>` : ''}
                </div>
            </div>
        `;
    });
    html += '</div>';
    html += '<div id="hub-notes-empty" style="display:none;text-align:center;padding:40px;color:var(--text-muted);">No notes match your search.</div>';
    return html;
}

function renderHubNotesSearch() {}

function filterHubNotes() {
    const q = (document.getElementById('hub-notes-search')?.value || '').toLowerCase();
    const courseId = document.getElementById('hub-notes-filter')?.value || 'all';
    let visibleCount = 0;
    document.querySelectorAll('.hub-note-course').forEach(courseEl => {
        const matchesCourse = courseId === 'all' || courseEl.dataset.courseId === courseId;
        let courseHasVisible = false;
        courseEl.querySelectorAll('.hub-note-card').forEach(card => {
            const matchesSearch = !q || (card.dataset.search || '').includes(q);
            const show = matchesCourse && matchesSearch;
            card.style.display = show ? '' : 'none';
            if (show) { courseHasVisible = true; visibleCount++; }
        });
        courseEl.style.display = courseHasVisible ? '' : 'none';
    });
    const emptyEl = document.getElementById('hub-notes-empty');
    if (emptyEl) emptyEl.style.display = visibleCount === 0 ? 'block' : 'none';
}

async function viewHubLessonNote(lessonId, courseId) {
    try {
        const data = await loadStudentHubData();
        const lesson = (data.lessons || []).find(l => l.id === lessonId);
        const course = (data.courses || []).find(c => c.id === courseId);
        const note = (data.notes || []).find(n => n.lessonId === lessonId);
        if (!lesson) return showToast('Lesson not found', { type: 'danger' });

        const content = note?.content || lesson.description || lesson.reference || 'No content available for this lesson yet.';
        const readTime = estimateReadTime(content);
        const courseLessons = (data.lessons || []).filter(l => l.courseId === courseId && l.published !== false).sort((a, b) => (a.order || 0) - (b.order || 0));
        const currentIdx = courseLessons.findIndex(l => l.id === lessonId);
        const prevLesson = currentIdx > 0 ? courseLessons[currentIdx - 1] : null;
        const nextLesson = currentIdx >= 0 && currentIdx < courseLessons.length - 1 ? courseLessons[currentIdx + 1] : null;

        const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
        const data2 = await loadStudentHubData();
        const me = (data2.students || []).find(s => s.id === currentUser.studentId || s.id === currentUser.username || s.email === currentUser.username || s.phone === currentUser.username);
        if (me) {
            const readKey = 'read-lessons-' + me.id;
            const readLessons = safeGetLocal(readKey, {});
            readLessons[lessonId] = Date.now();
            safeSetLocal(readKey, readLessons);
        }

        const contentEscaped = esc(content);
        const safeContent = contentEscaped.replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/\\/g, '\\\\');
        const videoHtml = lesson.videoUrl ? `<div style="max-width:720px;margin:0 auto 20px;">${embedVideo(lesson.videoUrl)}</div>` : '';
        const html = `
            <div style="max-width:760px;margin:0 auto;">
                ${videoHtml}
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">${esc(course?.code || '')} · ${esc(course?.name || '')}</div>
                <h2 style="color:var(--accent);margin:0 0 4px 0;font-size:24px;line-height:1.3;">${esc(lesson.title)}</h2>
                <div style="display:flex;gap:12px;font-size:12px;color:var(--text-muted);margin-bottom:20px;flex-wrap:wrap;align-items:center;">
                    ${lesson.videoUrl ? '<span style="background:var(--accent);color:#fff;padding:2px 8px;border-radius:4px;font-weight:700;font-size:10px;">🎬 VIDEO</span>' : ''}
                    <span>⏱ ${readTime} min read</span>
                    ${currentIdx >= 0 ? `<span>📖 Lesson ${currentIdx + 1} of ${courseLessons.length}</span>` : ''}
                    ${note ? '<span style="color:var(--success);">📄 Study notes attached</span>' : ''}
                </div>
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.85;color:var(--text);white-space:pre-line;padding:0 0 24px 0;border-bottom:1px solid var(--border);">${contentEscaped}</div>
                <div style="display:flex;justify-content:space-between;gap:8px;margin-top:20px;flex-wrap:wrap;">
                    ${prevLesson ? `<button class="btn btn-outline" onclick="closeModal();viewHubLessonNote('${prevLesson.id}','${courseId}')" style="text-align:left;">← <span style="display:block;font-size:11px;opacity:0.7;">Previous</span><span style="font-weight:600;">${esc(prevLesson.title)}</span></button>` : '<div></div>'}
                    ${nextLesson ? `<button class="btn btn-primary" onclick="closeModal();viewHubLessonNote('${nextLesson.id}','${courseId}')" style="text-align:right;">→ <span style="display:block;font-size:11px;opacity:0.8;">Next</span><span style="font-weight:600;">${esc(nextLesson.title)}</span></button>` : '<div></div>'}
                </div>
            </div>
        `;

        const noteId = note ? note.id : null;
        showModal('📖 ' + lesson.title, html, `<button class="btn btn-outline" onclick="hubPrintNote()">🖨 Print</button> <button class="btn btn-outline" onclick="hubCopyNote(\`${safeContent}\`)">📋 Copy</button> ${noteId ? `<button class="btn btn-outline" onclick="downloadNote('${noteId}','pdf')">⬇ PDF</button>` : `<button class="btn btn-outline" onclick="hubDownloadText(\`${safeContent}\`,'${esc(lesson.title)}')">⬇ PDF</button>`} <button class="btn btn-success" onclick="closeModal();renderStudentHub();">✓ Marked as Read</button>`);
    } catch (err) {
        console.error('viewHubLessonNote error:', err);
        showToast('Error opening note', { type: 'danger' });
    }
}

async function viewHubNote(noteId) {
    try {
        const data = await loadStudentHubData();
        const note = (data.notes || []).find(n => n.id === noteId);
        if (!note) return showToast('Note not found', { type: 'danger' });
        const course = (data.courses || []).find(c => c.id === note.courseId);
        const readTime = estimateReadTime(note.content || '');
        const safeContent = esc(note.content || '').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/\\/g, '\\\\');
        const html = `
            <div style="max-width:760px;margin:0 auto;">
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">${esc(course?.code || '')} · ${esc(course?.name || '')}</div>
                <h2 style="color:var(--accent);margin:0 0 4px 0;font-size:24px;line-height:1.3;">${esc(note.title)}</h2>
                <div style="display:flex;gap:12px;font-size:12px;color:var(--text-muted);margin-bottom:20px;flex-wrap:wrap;">
                    <span>⏱ ${readTime} min read</span>
                    <span>📅 ${formatDate(note.createdAt)}</span>
                </div>
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.85;color:var(--text);white-space:pre-line;">${esc(note.content || '')}</div>
            </div>
        `;
        showModal('📄 ' + note.title, html, `<button class="btn btn-outline" onclick="hubPrintNote()">🖨 Print</button> <button class="btn btn-outline" onclick="hubCopyNote(\`${safeContent}\`)">📋 Copy</button> <button class="btn btn-outline" onclick="downloadNote('${note.id}','pdf')">⬇ PDF</button>`);
    } catch (err) {
        console.error('viewHubNote error:', err);
        showToast('Error opening note', { type: 'danger' });
    }
}

function hubDownloadText(content, title) {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
<style>body{font-family:'Segoe UI',Arial,sans-serif;margin:40px;color:#1e293b;line-height:1.8;white-space:pre-line;}@media print{body{margin:20px;}}</style></head><body>${content}</body></html>`;
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 300);
    showToast('Opening PDF print dialog...');
}
function hubPrintNote() {
    const content = document.querySelector('.modal-content, .modal-body, [class*="modal"]');
    window.print();
}

function hubCopyNote(content) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(content).then(() => showToast('📋 Copied to clipboard!')).catch(() => fallbackCopy(content));
    } else {
        fallbackCopy(content);
    }
}

function fallbackCopy(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        showToast(ok ? '📋 Copied!' : 'Copy failed', { type: ok ? 'success' : 'danger' });
    } catch {
        showToast('Copy not supported', { type: 'danger' });
    }
}

(function rebuildNavWithLatest() {
    function tryRebuild() {
        if (typeof buildNavigation !== 'function') return false;
        const session = sessionStorage.getItem('currentUser');
        if (!session) return false;
        try {
            const user = JSON.parse(session);
            if (user && user.role) {
                buildNavigation(user);
                return true;
            }
        } catch {}
        return false;
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(tryRebuild, 100));
    } else {
        setTimeout(tryRebuild, 100);
    }
    setTimeout(tryRebuild, 500);
    setTimeout(tryRebuild, 1500);
})();

let _hubLastRetakeStatuses = {};
function _hubCheckRetakeAlerts() {
    try {
        const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
        const data = studentHubCache;
        if (!data) return;
        const me = (data.students || []).find(s => s.id === currentUser.studentId || s.id === currentUser.username || s.email === currentUser.username || s.phone === currentUser.username);
        if (!me) return;
        const myRequests = (data.retakeRequests || []).filter(r => r.studentId === me.id);
        for (const r of myRequests) {
            const prev = _hubLastRetakeStatuses[r.id];
            if (prev && prev !== 'approved' && r.status === 'approved') {
                showToast('🎉 Your retake request has been APPROVED! A supplementary exam has been scheduled.', { type: 'success', duration: 8000 });
            } else if (prev && prev !== 'rejected' && r.status === 'rejected') {
                showToast('❌ Your retake request was not approved.' + (r.adminNote ? ' Reason: ' + r.adminNote : ''), { type: 'danger', duration: 6000 });
            }
            _hubLastRetakeStatuses[r.id] = r.status;
        }
    } catch {}
}
let _hubSSE = null;
let _hubPollInterval = null;
let _hubTimestampInterval = null;
let _hubLastUpdate = Date.now();
let _hubRenderDebounce = null;
const _hubRelevantStores = ['notes','lessons','courses','enrollments','exams','examRegistrations','quizzes','submissions','students','payments','attendance','grades','retakeRequests'];

function _hubIsActive() {
    const el = document.getElementById('screen-student-hub');
    return el && el.classList.contains('active') && !document.hidden;
}

function _hubDebouncedRender() {
    if (_hubRenderDebounce) clearTimeout(_hubRenderDebounce);
    _hubRenderDebounce = setTimeout(() => {
        if (_hubModalOpen || document.querySelector('.modal, .modal-overlay, [class*="modal"]:not(.hidden)')) {
            invalidateStudentHubCache();
            return;
        }
        if (typeof renderStudentHub === 'function') renderStudentHub();
        _hubRenderDebounce = null;
    }, 400);
}

function _updateHubRefreshButton() {
    const btn = document.querySelector('#screen-student-hub .screen-actions button[onclick="renderStudentHub()"]');
    if (btn) {
        const secs = Math.floor((Date.now() - _hubLastUpdate) / 1000);
        if (secs < 3) btn.innerHTML = '🟢 Live';
        else if (secs < 60) btn.innerHTML = `🔄 ${secs}s ago`;
        else btn.innerHTML = `🔄 ${Math.floor(secs/60)}m ago`;
    }
    const pillText = document.getElementById('hub-live-text');
    const pillDot = document.getElementById('hub-live-dot');
    if (pillText) {
        const secs = Math.floor((Date.now() - _hubLastUpdate) / 1000);
        if (secs < 3) { pillText.textContent = 'Live'; if (pillDot) pillDot.style.background = '#4ade80'; }
        else if (secs < 60) { pillText.textContent = `${secs}s ago`; if (pillDot) pillDot.style.background = '#fbbf24'; }
        else { pillText.textContent = `${Math.floor(secs/60)}m ago`; if (pillDot) pillDot.style.background = '#f87171'; }
    }
}

function startHubLiveSync() {
    if (_hubSSE) { try { _hubSSE.close(); } catch {} _hubSSE = null; }
    if (_hubPollInterval) { clearInterval(_hubPollInterval); _hubPollInterval = null; }
    if (_hubTimestampInterval) { clearInterval(_hubTimestampInterval); _hubTimestampInterval = null; }

    document.addEventListener('visibilitychange', () => {
        if (!_hubIsActive()) return;
        if (document.visibilityState === 'visible') {
            invalidateStudentHubCache();
            _hubDebouncedRender();
        }
    });

    _hubPollInterval = setInterval(() => {
        if (_hubIsActive()) {
            invalidateStudentHubCache();
            _hubDebouncedRender();
        }
    }, 120000);

    _hubTimestampInterval = setInterval(_updateHubRefreshButton, 1000);

    try {
        _hubSSE = new EventSource('/api/events');
        _hubSSE.addEventListener('db-change', (e) => {
            try {
                const { store } = JSON.parse(e.data || '{}');
                if (_hubRelevantStores.includes(store) && _hubIsActive()) {
                    invalidateStudentHubCache();
                    _hubDebouncedRender();
                    const labels = {
                        grades: '📊 New grade posted',
                        retakeRequests: '📋 Retake request updated',
                        quizzes: '📋 New quiz available'
                    };
                    if (typeof showToast === 'function' && labels[store]) {
                        showToast(labels[store], { duration: 2000 });
                    }
                    if (store === 'retakeRequests') setTimeout(_hubCheckRetakeAlerts, 500);
                }
            } catch {}
        });
        _hubSSE.onerror = () => {
            try { if (_hubSSE && _hubSSE.readyState === EventSource.CLOSED) {
                setTimeout(startHubLiveSync, 5000);
            } } catch {}
        };
    } catch (err) {
        console.warn('Student Hub SSE unavailable, using polling only:', err);
    }
}

(function initHubLiveSync() {
    function go() { startHubLiveSync(); }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', go);
    } else {
        go();
    }
})();

const _origRenderStudentHub = renderStudentHub;
renderStudentHub = async function() {
    _hubLastUpdate = Date.now();
    await _origRenderStudentHub.apply(this, arguments);
    _updateHubRefreshButton();
};

if (typeof showModal === 'function') {
    const _origShowModal = showModal;
    window.showModal = function() { _hubModalOpen = true; return _origShowModal.apply(this, arguments); };
}
if (typeof closeModal === 'function') {
    const _origCloseModal = closeModal;
    window.closeModal = function() { _hubModalOpen = false; return _origCloseModal.apply(this, arguments); };
}
