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

let _carouselTimer = null;
let _carouselIndex = 0;
let _carouselAlerts = [];

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

let bgRefreshTimer = null;
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