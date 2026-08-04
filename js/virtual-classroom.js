// ===================== Virtual Classroom Module =====================
function toggleVirtualSettings(prefix) {
    var enabled = document.getElementById(prefix + 'virtual-enabled');
    var settings = document.getElementById(prefix + 'virtual-settings');
    if (enabled && settings) settings.style.display = enabled.checked ? 'block' : 'none';
}
function getJitsiUrl(lesson) {
    var room = (lesson && lesson.virtualRoom) || '';
    if (!room) return '';
    if (/^https?:\/\//i.test(room)) return room + (lesson.virtualPassword ? '?jwt=' + encodeURIComponent(lesson.virtualPassword) : '');
    var origin = window.location.origin || 'https://netfoundation.ke';
    var base = origin.replace(/:3000$/, ':8080');
    if (base.indexOf('8080') === -1) base = 'https://meet.jit.si';
    return base + '/' + encodeURIComponent(room) + (lesson.virtualPassword ? '?jwt=' + encodeURIComponent(lesson.virtualPassword) : '');
}
async function loadAttendance(lessonId) {
    try {
        var records = await dbGetAll('attendance');
        return records.filter(function (a) { return a.lessonId === lessonId; }).sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
    } catch (e) { console.error('loadAttendance:', e); return []; }
}
async function exportAttendanceCsv(lessonId) {
    var rows = await loadAttendance(lessonId);
    var header = 'Student,Status,Date,Lesson ID';
    var lines = rows.map(function (r) {
        return [(r.studentId || r.student || ''), (r.status || ''), (r.date || r.createdAt || ''), r.lessonId || lessonId].join(',');
    });
    var csv = [header].concat(lines).join('\n');
    var blob = new Blob([csv], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = 'attendance-' + lessonId + '.csv'; a.click();
    URL.revokeObjectURL(url);
    showToast('Attendance CSV exported', { type: 'success' });
}
async function saveVirtualLesson(lessonId) {
    var lesson = await dbGet('lessons', lessonId);
    if (!lesson) return showToast('Lesson not found', { type: 'error' });
    lesson.virtualEnabled = document.getElementById('vc-virtual-enabled') ? document.getElementById('vc-virtual-enabled').checked : false;
    lesson.virtualRoom = (document.getElementById('vc-virtual-room') || { value: '' }).value.trim();
    lesson.virtualPassword = (document.getElementById('vc-virtual-password') || { value: '' }).value.trim();
    lesson.virtualScheduled = (document.getElementById('vc-virtual-scheduled') || { value: '' }).value;
    lesson.virtualRecording = document.getElementById('vc-virtual-recording') ? document.getElementById('vc-virtual-recording').checked : false;
    lesson.virtualLobby = document.getElementById('vc-virtual-lobby') ? document.getElementById('vc-virtual-lobby').checked : false;
    lesson.updatedAt = new Date().toISOString();
    await dbPut('lessons', lesson);
    showToast('Virtual Classroom settings saved', { type: 'success' });
    renderVirtualClassroomTab(lesson, lessonId, true);
}
async function renderVirtualClassroomTab(lesson, lessonId, canEdit) {
    var user = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    var role = user.role || 'student';
    var isTeacher = ['admin', 'registrar', 'lecturer', 'coordinator'].indexOf(role) !== -1;
    var enabled = !!lesson.virtualEnabled;
    var jitsiUrl = enabled ? getJitsiUrl(lesson) : '';
    var safeLessonId = String(lessonId).replace(/[^a-zA-Z0-9]/g, '');
    var jitsiId = 'jitsi-' + safeLessonId;
    var html = '';
    if (canEdit) {
        html += '<div style="margin-bottom:16px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);">';
        html += '<b>Virtual Classroom Settings</b>';
        html += '<div style="display:flex;align-items:center;gap:8px;margin-top:8px;"><input type="checkbox" id="vc-virtual-enabled" ' + (enabled ? 'checked' : '') + ' onchange="toggleVirtualSettings(\'vc-\')"><label for="vc-virtual-enabled" style="margin:0;font-size:13px;margin-left:6px;">Enable Virtual Classroom for this lesson</label></div>';
        html += '<div id="vc-virtual-settings" style="display:' + (enabled ? 'block' : 'none') + ';margin-top:12px;">';
        html += '<div style="margin-bottom:8px;"><label>Room Name / URL</label><input type="text" id="vc-virtual-room" value="' + esc(lesson.virtualRoom || '') + '" placeholder="e.g. netcohort or https://meet.jit.si/netcohort" style="width:100%;"></div>';
        html += '<div style="margin-bottom:8px;"><label>Password</label><input type="password" id="vc-virtual-password" value="' + esc(lesson.virtualPassword || '') + '"></div>';
        html += '<div style="margin-bottom:8px;"><label>Scheduled Time</label><input type="datetime-local" id="vc-virtual-scheduled" value="' + (lesson.virtualScheduled ? String(lesson.virtualScheduled).replace(' ', 'T').slice(0, 16) : '') + '"></div>';
        html += '<div style="display:flex;gap:12px;"><div><input type="checkbox" id="vc-virtual-recording" ' + (lesson.virtualRecording ? 'checked' : '') + '> <label style="margin:0;font-size:13px;">Record session</label></div>';
        html += '<div><input type="checkbox" id="vc-virtual-lobby" ' + (lesson.virtualLobby ? 'checked' : '') + '> <label style="margin:0;font-size:13px;">Enable lobby</label></div></div>';
        html += '</div>';
        html += '<button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="saveVirtualLesson(\'' + lessonId + '\')">Save Settings</button>';
        html += '</div>';
    }
    if (enabled && jitsiUrl) {
        html += '<div style="margin-top:16px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><b>Live Class: ' + (lesson.title || 'Lesson') + '</b>';
        if (isTeacher && canEdit) html += '<span style="font-size:11px;color:var(--text-muted);">Moderator access</span>';
        html += '</div>';
        html += '<div id="' + jitsiId + '" style="position:relative;width:100%;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:10px;border:1px solid var(--border);background:#000;">';
        html += '<iframe src="' + jitsiUrl + '" id="' + jitsiId + '-iframe" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allow="camera;microphone;fullscreen" allowfullscreen></iframe>';
        html += '</div>';
        html += '<div style="margin-top:10px;font-size:11px;color:var(--text-muted);">Room: ' + (lesson.virtualRoom || '') + (lesson.virtualPassword ? ' (Password set)' : '') + '</div>';
        html += '</div>';
        html += '<div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;"><b>Attendance</b><button class="btn btn-outline btn-sm" onclick="exportAttendanceCsv(\'' + lessonId + '\')">Export CSV</button></div>';
        html += '<div id="vc-attendance-' + safeLessonId + '" style="margin-top:8px;font-size:12px;color:var(--text-muted);">Loading...</div>';
        html += '</div>';
        loadAttendance(lessonId).then(function (recs) {
            var box = document.getElementById('vc-attendance-' + safeLessonId);
            if (!box) return;
            if (!recs.length) { box.innerHTML = '<p style="color:var(--text-muted);">No attendance records yet.</p>'; return; }
            var t = '<table style="width:100%;border-collapse:collapse;"><tr><th style="text-align:left;padding:4px;">Student</th><th style="text-align:left;padding:4px;">Status</th><th style="text-align:left;padding:4px;">Date</th></tr>';
            recs.slice(0, 50).forEach(function (r) {
                t += '<tr><td style="padding:4px;">' + esc(r.studentId || r.student || '') + '</td><td style="padding:4px;">' + esc(r.status || '') + '</td><td style="padding:4px;">' + esc(r.date || '') + '</td></tr>';
            });
            t += '</table>';
            box.innerHTML = t;
        });
    } else if (enabled) {
        html += '<p style="color:var(--text-muted);">Room name not configured.</p>';
    } else if (canEdit) {
        html += '<p style="color:var(--text-muted);">Enable the Virtual Classroom above to add a Jitsi Meet session to this lesson.</p>';
    }
    var container = document.getElementById('lesson-tab-content');
    if (container) container.innerHTML = html;
}
function esc(s) {
    var d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML;
}
// Override switchLessonTab to handle the "virtual" tab (delegate others to original)
var _vcOrigSwitchLessonTab = (typeof switchLessonTab !== 'undefined') ? switchLessonTab : null;
window.switchLessonTab = async function (tab, lessonId) {
    try {
        var btns = document.querySelectorAll('#lesson-mgr-tabs .tab-btn');
        if (btns.length) btns.forEach(function (b) { b.classList.remove('active'); });
        if (window.event && window.event.target && window.event.target.closest) {
            var t = window.event.target.closest('.tab-btn');
            if (t) t.classList.add('active');
        }
    } catch (e) {}
    if (tab === 'virtual') {
        try {
            var lesson = await dbGet('lessons', lessonId);
            if (!lesson) { document.getElementById('lesson-tab-content').innerHTML = '<p>Lesson not found</p>'; return; }
            var user = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
            var perms = getRolePermissions(user.role || 'student');
            await renderVirtualClassroomTab(lesson, lessonId, perms.indexOf('courses') !== -1);
        } catch (err) {
            console.error('VC tab error:', err);
            document.getElementById('lesson-tab-content').innerHTML = '<p style="color:var(--danger);">Error loading Virtual Classroom.</p>';
        }
        return;
    }
    if (_vcOrigSwitchLessonTab) {
        try { await _vcOrigSwitchLessonTab(tab, lessonId); }
        catch (e) { console.error('vc wrapper orig error:', e); }
    }
};
// Student-facing: "Join Live Class" from lesson lists
async function joinLiveLesson(lessonId) {
    var lesson = await dbGet('lessons', lessonId);
    if (!lesson || !lesson.virtualEnabled) return showToast('No virtual class for this lesson', { type: 'warning' });
    var url = getJitsiUrl(lesson);
    if (!url) return showToast('Virtual room not configured', { type: 'warning' });
    window.open(url, '_blank');
    showToast('Joining live class...', { type: 'info' });
    try {
        var u = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
        await dbAdd('attendance', { id: 'ATT-' + Date.now(), lessonId: lessonId, studentId: u.username || u.studentId, student: u.studentId, status: 'present', date: new Date().toISOString(), createdAt: new Date().toISOString() });
    } catch (e) { console.error('attendance ping:', e); }
}
// Attach "Join Live Class" / "Manage VC" buttons to the lessons list in course view
var _vcOrigRenderLessons = (typeof renderLessons !== 'undefined') ? renderLessons : null;
window.renderLessons = async function () {
    try { if (_vcOrigRenderLessons) await _vcOrigRenderLessons(); } catch (e) { console.error('vc renderLessons orig:', e); }
    try {
        var container = document.getElementById('lessons-list');
        var user = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
        var role = user.role || 'student';
        var lessonsArr = await dbGetAll('lessons');
        var active = lessonsArr.filter(function (l) { return !!l.virtualEnabled; });
        if (!container || !active.length) return;
        active.forEach(function (l) {
            if (container.querySelector('[data-vc-lesson=' + l.id + ']')) return;
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;';
            var label = document.createElement('span'); label.textContent = (l.title || l.id) + ' - Live'; label.style.fontWeight = '600';
            row.appendChild(label);
            if (role === 'student') {
                var jb = document.createElement('button'); jb.textContent = 'Join Live Class'; jb.className = 'btn btn-success btn-sm';
                jb.onclick = (function (id) { return function () { joinLiveLesson(id); }; })(l.id);
                row.appendChild(jb);
            } else {
                var cb = document.createElement('button'); cb.textContent = 'Manage VC';
                cb.onclick = (function (id) { return function () { manageLesson(id); }; })(l.id);
                cb.style.marginLeft = '8px';
                row.appendChild(cb);
            }
            row.setAttribute('data-vc-lesson', l.id);
            container.appendChild(row);
        });
    } catch (e) { console.error('vc renderLessons attach:', e); }
};
// ==================== End Virtual Classroom Module ====================
