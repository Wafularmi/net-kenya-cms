var _discussionsCache;
const BASE = '/api/discussions';
var esc = window.escapeHtml || function(s) { return s == null ? '' : String(s); };

function timeAgo(ts) {
    if (!ts) return '';
    const now = Date.now();
    const d = new Date(ts).getTime();
    const sec = Math.floor((now - d) / 1000);
    if (sec < 10) return 'Just now';
    if (sec < 60) return sec + 's ago';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    if (d > yesterday.getTime()) return 'Yesterday';
    const day = Math.floor(hr / 24);
    if (day < 7) return day + 'd ago';
    const date = new Date(ts);
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

function avatarHTML(name, size) {
    const s = size || 32;
    const initial = (name || '?').charAt(0).toUpperCase();
    const colors = ['#e53935','#d81b60','#8e24aa','#5e35b1','#3949ab','#1e88e5','#039be5','#00acc1','#00897b','#43a047','#7cb342','#c0ca33','#fdd835','#ffb300','#fb8c00','#f4511e','#6d4c41','#757575','#546e7a'];
    const ci = (name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length;
    return `<div style="width:${s}px;height:${s}px;border-radius:50%;background:${colors[ci]};color:#fff;display:flex;align-items:center;justify-content:center;font-size:${Math.round(s*0.45)}px;font-weight:700;flex-shrink:0;">${initial}</div>`;
}

function renderThread(replies, courseId, messageId, curUser, isStaff, userId, depth, isMain) {
    if (!replies || !replies.length) return '';
    const maxInit = 2;
    const total = replies.length;
    const showMore = total > maxInit;
    const shown = showMore ? replies.slice(0, maxInit) : replies;
    const hidden = showMore ? replies.slice(maxInit) : [];
    const threadId = 'thread-' + messageId + (isMain ? '' : '-' + depth);

    let html = '';
    shown.forEach(r => html += renderReply(r, courseId, messageId, curUser, isStaff, userId, depth));
    if (showMore) {
        const remain = total - maxInit;
        html += `<div id="more-${threadId}" style="margin-left:${depth*32+40}px;"><button class="fb-more-replies" onclick="expandThread('${messageId}','${courseId}',${depth},${isMain})">View ${remain} more ${remain === 1 ? 'reply' : 'replies'}</button></div>`;
        html += `<div id="extra-${threadId}" style="display:none;">`;
        hidden.forEach(r => html += renderReply(r, courseId, messageId, curUser, isStaff, userId, depth));
        html += '</div>';
    }
    return html;
}

function renderReply(r, courseId, messageId, curUser, isStaff, userId, depth) {
    const likes = r.likes || [];
    const liked = likes.includes(userId);
    const childReplies = r.replies || [];
    const replyId = r.id;
    const indent = depth === 0 ? 0 : 32;
    const borderLeft = depth === 0 ? '' : 'border-left:2px solid var(--border);';

    return `<div class="fb-reply" style="margin-left:${indent}px;${borderLeft}padding-left:${depth === 0 ? '0' : '12px'};margin-top:2px;">
        <div class="fb-reply-body">
            ${avatarHTML(r.userName, 28)}
            <div style="flex:1;min-width:0;">
                <div style="background:var(--bg-input);border-radius:12px;padding:6px 10px;display:inline-block;max-width:100%;">
                    <div style="font-weight:600;font-size:12px;color:var(--accent);">${esc(r.userName)} <span style="font-weight:400;font-size:10px;color:var(--text-muted);">${esc(r.userRole)}</span></div>
                    <div style="font-size:13px;line-height:1.45;margin-top:1px;white-space:pre-wrap;word-break:break-word;">${esc(r.content)}</div>
                </div>
                <div style="display:flex;gap:14px;margin-top:2px;padding-left:4px;align-items:center;">
                    <button class="fb-action ${liked ? 'fb-action-active' : ''}" onclick="toggleLike('${messageId}','${courseId}','${replyId}')" style="font-size:11px;padding:2px 0;">Like${likes.length ? ' ' + likes.length : ''}</button>
                    <button class="fb-action" onclick="showReplyFormInline('${messageId}','${courseId}','${replyId}')" style="font-size:11px;padding:2px 0;">Reply</button>
                    <span class="fb-time">${timeAgo(r.timestamp)}</span>
                </div>
                <div id="reply-inline-${messageId}-${replyId}"></div>
                ${childReplies.length ? renderThread(childReplies, courseId, messageId, curUser, isStaff, userId, depth + 1, false) : ''}
            </div>
        </div>
    </div>`;
}

function renderInlineReplyForm(messageId, courseId, replyId) {
    return `<div class="fb-inline-reply" style="margin-top:4px;">
        <textarea rows="1" placeholder="Write a reply..." class="fb-reply-input" id="fb-input-${messageId}-${replyId}" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitReplyInline('${messageId}','${courseId}','${replyId}')}"></textarea>
        <div style="display:flex;gap:6px;margin-top:4px;">
            <button class="btn btn-primary btn-sm" onclick="submitReplyInline('${messageId}','${courseId}','${replyId}')" style="font-size:11px;padding:3px 10px;">Post</button>
            <button class="btn btn-sm btn-outline" onclick="cancelReplyInline('${messageId}','${replyId}')" style="font-size:11px;padding:3px 10px;">Cancel</button>
        </div>
    </div>`;
}

function renderMainReplyForm(messageId, courseId) {
    return `<div class="fb-inline-reply" style="margin-top:8px;display:flex;gap:8px;align-items:start;">
        ${avatarHTML((JSON.parse(sessionStorage.getItem('currentUser')||'{}').name || 'U'), 28)}
        <div style="flex:1;">
            <textarea rows="1" placeholder="Write a reply..." class="fb-reply-input" id="fb-input-${messageId}" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitReplyInline('${messageId}','${courseId}')}"></textarea>
            <div style="display:flex;gap:6px;margin-top:4px;justify-content:flex-end;">
                <button class="btn btn-primary btn-sm" onclick="submitReplyInline('${messageId}','${courseId}')" style="font-size:11px;padding:3px 10px;">Post Reply</button>
            </div>
        </div>
    </div>`;
}

async function discFetch(path, opts) {
    const res = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

function injectFbStyles() {
    if (document.getElementById('fb-disc-styles')) return;
    const style = document.createElement('style');
    style.id = 'fb-disc-styles';
    style.textContent = `
.fb-feed{display:flex;flex-direction:column;gap:10px;}
.fb-post{background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px 16px 8px;position:relative;}
.fb-post.fb-pinned{border-left:3px solid var(--accent);}
.fb-pin-badge{position:absolute;top:-1px;right:12px;font-size:10px;background:var(--accent);color:#fff;padding:1px 8px;border-radius:0 0 6px 6px;font-weight:600;}
.fb-post-header{display:flex;gap:10px;align-items:start;}
.fb-post-content{font-size:14px;line-height:1.55;margin-top:8px;padding:0 2px;white-space:pre-wrap;word-break:break-word;color:var(--text);}
.fb-post-actions{display:flex;gap:4px;margin-top:8px;padding-top:6px;border-top:1px solid var(--border);}
.fb-action-button{display:flex;align-items:center;gap:4px;padding:4px 10px;border:none;background:none;cursor:pointer;font-size:12px;font-weight:500;color:var(--text-muted);border-radius:6px;transition:background .15s;}
.fb-action-button:hover{background:var(--bg-input);color:var(--text);}
.fb-action-button.fb-action-active{color:var(--accent);font-weight:600;}
.fb-action-icon{font-size:13px;}
.fb-replies-section{margin-top:4px;padding-top:4px;}
.fb-reply{margin-bottom:1px;}
.fb-reply-body{display:flex;gap:6px;align-items:start;}
.fb-action{background:none;border:none;cursor:pointer;color:var(--text-muted);font-weight:500;border-radius:4px;transition:color .15s;}
.fb-action:hover{color:var(--accent);text-decoration:underline;}
.fb-action.fb-action-active{color:var(--accent);font-weight:600;}
.fb-time{font-size:10px;color:var(--text-muted);}
.fb-more-replies{background:none;border:none;cursor:pointer;font-size:12px;font-weight:500;color:var(--text-muted);padding:4px 0;}
.fb-more-replies:hover{color:var(--accent);text-decoration:underline;}
.fb-icon-btn{background:none;border:none;cursor:pointer;font-size:13px;padding:4px 6px;border-radius:6px;transition:background .15s;opacity:0.5;}
.fb-icon-btn:hover{background:var(--bg-input);opacity:1;}
.fb-inline-reply{margin-top:6px;}
.fb-reply-input{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:20px;background:var(--bg-input);color:var(--text);font-size:13px;resize:none;outline:none;box-sizing:border-box;font-family:inherit;transition:border-color .15s;}
.fb-reply-input:focus{border-color:var(--accent);}
`;
    document.head.appendChild(style);
}

async function renderDiscussions() {
    injectFbStyles();
    const container = document.getElementById('discussions-list');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">Loading discussions...</div>';

    try {
        const courses = await dbGetAll('courses');
        const filterEl = document.getElementById('disc-course-filter');
        const currentVal = filterEl.value;
        filterEl.innerHTML = '<option value="">All Courses</option>' + courses.map(c => `<option value="${c.id}">${esc(c.code)} — ${esc(c.name)}</option>`).join('');
        filterEl.value = currentVal;

        const selectedCourse = filterEl.value;
        let allMessages = [];

        if (selectedCourse) {
            try {
                const data = await discFetch('/' + encodeURIComponent(selectedCourse));
                allMessages = data.messages || [];
            } catch { allMessages = []; }
        } else {
            const results = await Promise.all(courses.map(c =>
                discFetch('/' + encodeURIComponent(c.id)).then(d => (d.messages || []).map(m => ({ ...m, courseId: c.id }))).catch(() => [])
            ));
            allMessages = results.flat();
        }

        allMessages.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.timestamp) - new Date(a.timestamp));

        const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
        const isStaff = ['admin', 'lecturer', 'registrar'].includes(currentUser.role);
        const userId = currentUser.studentId || currentUser.username;

        let html = '<div class="fb-feed">';
        if (!allMessages.length) {
            html += '<div style="text-align:center;padding:60px 20px;color:var(--text-muted);background:var(--bg-card);border-radius:12px;"><div style="font-size:48px;margin-bottom:8px;">💬</div><h3 style="margin:0 0 4px;">No discussions yet</h3><p style="margin:0;font-size:13px;">Select a course and start a new discussion!</p></div>';
        } else {
            allMessages.forEach(m => {
                const course = courses.find(c => c.id === m.courseId);
                const courseLabel = course ? esc(course.code) : esc(m.courseId);
                const isOwn = m.userId === currentUser.username || m.userId === currentUser.studentId;
                const likes = m.likes || [];
                const replies = m.replies || [];
                const liked = likes.includes(userId);

                html += `<div class="fb-post ${m.pinned ? 'fb-pinned' : ''}">
                    ${m.pinned ? '<div class="fb-pin-badge">📌 Pinned</div>' : ''}
                    ${m.locked ? '<div class="fb-pin-badge" style="background:var(--danger);">🔒 Locked</div>' : ''}
                    <div class="fb-post-header">
                        ${avatarHTML(m.userName, 36)}
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:600;font-size:13px;color:var(--accent);">${esc(m.userName)}</div>
                            <div style="display:flex;gap:6px;align-items:center;font-size:11px;color:var(--text-muted);">
                                <span>${esc(m.userRole)}</span>
                                <span>·</span>
                                <span>${courseLabel}</span>
                                <span>·</span>
                                <span>${timeAgo(m.timestamp)}</span>
                            </div>
                        </div>
                        <div style="display:flex;gap:2px;flex-shrink:0;">
                            ${isStaff ? `
                                <button class="fb-icon-btn" onclick="togglePin('${m.id}','${m.courseId}',${m.pinned})" title="${m.pinned ? 'Unpin' : 'Pin'}">📌</button>
                                <button class="fb-icon-btn" onclick="toggleLock('${m.id}','${m.courseId}',${m.locked})" title="${m.locked ? 'Unlock' : 'Lock'}">🔒</button>
                                <button class="fb-icon-btn" onclick="deleteDiscussion('${m.id}','${m.courseId}')" title="Delete" style="color:var(--danger);">🗑️</button>
                            ` : ''}
                        </div>
                    </div>
                    <div class="fb-post-content">${esc(m.content)}</div>
                    <div class="fb-post-actions">
                        <button class="fb-action-button ${liked ? 'fb-action-active' : ''}" onclick="toggleLike('${m.id}','${m.courseId}')">
                            <span class="fb-action-icon">👍</span> Like${likes.length ? ' ' + likes.length : ''}
                        </button>
                        <button class="fb-action-button" onclick="showMainReplyForm('${m.id}')">
                            <span class="fb-action-icon">💬</span> Reply
                        </button>
                    </div>
                    <div id="replies-${m.id}" class="fb-replies-section">
                        ${renderThread(replies, m.courseId || courseId, m.id, currentUser, isStaff, userId, 0, true)}
                        <div id="main-reply-form-${m.id}">
                            ${renderMainReplyForm(m.id, m.courseId || courseId)}
                        </div>
                    </div>
                </div>`;
            });
        }
        html += '</div>';
        container.innerHTML = html;

        const btn = document.querySelector('#screen-discussions .screen-actions .btn-primary');
        if (btn && selectedCourse) btn.style.display = 'inline-flex';
        else if (btn) btn.style.display = 'none';
    } catch (err) {
        console.error('renderDiscussions error:', err);
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--danger);">Error loading discussions.</div>';
    }
}

function showMainReplyForm(messageId) {
    const container = document.getElementById('main-reply-form-' + messageId);
    if (container) {
        const textarea = container.querySelector('.fb-reply-input');
        if (textarea) { textarea.focus(); textarea.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
}

function showReplyFormInline(messageId, courseId, replyId) {
    const container = document.getElementById('reply-inline-' + messageId + '-' + replyId);
    if (!container) return;
    const isOpen = container.querySelector('.fb-inline-reply');
    if (isOpen) { isOpen.remove(); return; }
    container.innerHTML = renderInlineReplyForm(messageId, courseId, replyId);
    const ta = document.getElementById('fb-input-' + messageId + '-' + replyId);
    if (ta) { ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

function cancelReplyInline(messageId, replyId) {
    const key = replyId ? messageId + '-' + replyId : messageId;
    const form = document.getElementById('fb-input-' + key)?.closest('.fb-inline-reply');
    if (form) form.remove();
}

async function submitReplyInline(messageId, courseIdOverride, replyId) {
    const courseEl = document.getElementById('disc-course-filter');
    const courseId = courseIdOverride || courseEl?.value;
    if (!courseId) return showToast('Course not selected', { type: 'danger' });

    const key = replyId ? messageId + '-' + replyId : messageId;
    const ta = document.getElementById('fb-input-' + key);
    const content = ta?.value.trim();
    if (!content) return;

    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const userName = currentUser.name || currentUser.username || 'Unknown';
    const userId = currentUser.studentId || currentUser.username;
    const userRole = currentUser.role || 'student';

    try {
        const body = { action: 'reply', userId, userName, userRole, content };
        if (replyId) body.parentReplyId = replyId;
        await discFetch('/' + encodeURIComponent(courseId) + '/' + messageId, {
            method: 'PUT',
            body: JSON.stringify(body)
        });
        if (ta) ta.value = '';
        renderDiscussions();
    } catch (err) {
        showToast('Failed to reply: ' + err.message, { type: 'danger' });
    }
}

async function toggleLike(messageId, courseId, replyId) {
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const userId = currentUser.studentId || currentUser.username;
    if (!userId) return showToast('Could not identify user', { type: 'danger' });
    const courseEl = document.getElementById('disc-course-filter');
    const cId = courseId || courseEl?.value;
    if (!cId) return showToast('Course not selected', { type: 'danger' });

    try {
        const body = { action: 'like', userId, userRole: currentUser.role };
        if (replyId) body.replyId = replyId;
        await discFetch('/' + encodeURIComponent(cId) + '/' + messageId, {
            method: 'PUT',
            body: JSON.stringify(body)
        });
        renderDiscussions();
    } catch (err) {
        showToast('Failed: ' + err.message, { type: 'danger' });
    }
}

function expandThread(messageId, courseId, depth, isMain) {
    const threadId = 'thread-' + messageId + (isMain ? '' : '-' + depth);
    document.getElementById('more-' + threadId).style.display = 'none';
    document.getElementById('extra-' + threadId).style.display = 'block';
}

function showNewDiscussionModal(courseId) {
    let courseEl = document.getElementById('disc-course-filter');
    let selectedCourse = courseId || courseEl?.value;
    if (!selectedCourse) {
        const hubEl = document.getElementById('hub-disc-course');
        if (hubEl && hubEl.value) {
            selectedCourse = hubEl.value;
            courseEl = hubEl;
        }
    }
    if (!selectedCourse) {
        showToast('Please select a course first', { type: 'warning' });
        (courseEl || document.getElementById('disc-course-filter'))?.focus();
        return;
    }

    const label = courseEl?.options[courseEl.selectedIndex]?.text || 'Selected course';
    const content = `
        <div class="form-group">
            <label>Course</label>
            <div style="padding:8px 12px;background:var(--bg-input);border-radius:6px;font-weight:600;font-size:14px;">${label}</div>
        </div>
        <div class="form-group">
            <label>Message *</label>
            <textarea id="disc-new-content" rows="5" placeholder="Type your question or message..." style="width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-size:13px;resize:vertical;" required></textarea>
        </div>
    `;

    showModal('New Discussion', content, `<button class="btn btn-primary" onclick="submitNewDiscussion('${selectedCourse}')">Post Message</button>`);
}

async function submitNewDiscussion(courseId) {
    const content = document.getElementById('disc-new-content')?.value.trim();
    if (!content) return showToast('Message cannot be empty!', { type: 'danger' });

    const courseEl = document.getElementById('disc-course-filter');
    const hubEl = document.getElementById('hub-disc-course');
    let courseIdVal = courseId || courseEl?.value || hubEl?.value;
    if (!courseIdVal) return showToast('Course not selected', { type: 'danger' });

    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const userName = currentUser.name || currentUser.username || 'Unknown';
    const userId = currentUser.studentId || currentUser.username;
    const userRole = currentUser.role || 'student';

    try {
        const result = await discFetch('/' + encodeURIComponent(courseIdVal), {
            method: 'POST',
            body: JSON.stringify({ userId, userName, userRole, content })
        });
        closeModal();
        showToast('Message posted!');
        renderDiscussions();
        logAudit('created', 'discussion', { courseId, messageId: result.message?.id });
    } catch (err) {
        showToast('Failed to post: ' + err.message, { type: 'danger' });
    }
}

async function togglePin(messageId, courseId, current) {
    const action = current ? 'unpin' : 'pin';
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const courseEl = document.getElementById('disc-course-filter');
    const cId = courseId || courseEl?.value;
    if (!cId) return;
    try {
        await discFetch('/' + encodeURIComponent(cId) + '/' + messageId, {
            method: 'PUT',
            body: JSON.stringify({ action, userRole: currentUser.role })
        });
        renderDiscussions();
        logAudit('updated', 'discussion', { messageId, action });
    } catch (err) {
        showToast('Failed: ' + err.message, { type: 'danger' });
    }
}

async function toggleLock(messageId, courseId, current) {
    const action = current ? 'unlock' : 'lock';
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const courseEl = document.getElementById('disc-course-filter');
    const cId = courseId || courseEl?.value;
    if (!cId) return;
    try {
        await discFetch('/' + encodeURIComponent(cId) + '/' + messageId, {
            method: 'PUT',
            body: JSON.stringify({ action, userRole: currentUser.role })
        });
        renderDiscussions();
        logAudit('updated', 'discussion', { messageId, action });
    } catch (err) {
        showToast('Failed: ' + err.message, { type: 'danger' });
    }
}

async function deleteDiscussion(messageId, courseId) {
    if (!await showConfirm('Delete Message', 'Delete this discussion message permanently?')) return;
    const currentUser = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    const courseEl = document.getElementById('disc-course-filter');
    const cId = courseId || courseEl?.value;
    if (!cId) return;
    try {
        await discFetch('/' + encodeURIComponent(cId) + '/' + messageId, {
            method: 'PUT',
            body: JSON.stringify({ action: 'delete', userRole: currentUser.role })
        });
        renderDiscussions();
        logAudit('deleted', 'discussion', { messageId });
    } catch (err) {
        showToast('Failed: ' + err.message, { type: 'danger' });
    }
}
