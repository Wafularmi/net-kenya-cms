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
    const today = new Date().toISOString().split('T')[0];
    const myExams = (exams || []).filter(e => e.published !== false && enrolledCourseIds.has(e.courseId) && (!me.studyCenterId || !e.studyCenterId || e.studyCenterId === me.studyCenterId) && e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    
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
    html += available.map(q => {
        const course = (await dbGetAll('courses')).find(c => c.id === q.courseId);
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

