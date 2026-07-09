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

var _refreshTimers;
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
