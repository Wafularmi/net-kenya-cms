// Server-authoritative lesson drip engine.
// Mirrors the client-side drip rules but runs on the server so unlocks and
// completions are trusted, tamper-proof, and consistent across devices.
//
// Rules (all enforced HERE, not on the client device):
//   - completion  = note read for >= required seconds AND the lesson video (when
//                   the lesson has one) watched for >= DRIP_VIDEO_RATIO of its
//                   duration AND every linked (published) quiz best score >=
//                   DRIP_PASS (50)
//   - chain       = lesson N in a drip course unlocks only when all earlier drip
//                   lessons are complete, the pacing window has elapsed, and the
//                   weekly fee target is current
//   - pace        = course.dripDaysBetween days after the previous lesson was
//                   unlocked/completed (0 = instant; default 3.5 days)
//   - fees        = weekly fee gate (settings: feeGate) with per-region overrides,
//                   per-student exemptions/amounts, waivers and approved agreements
'use strict';

const DRIP_PASS = 50;
const DRIP_DEFAULT_PACE_DAYS = 3.5;
// A lesson video counts as watched once this fraction of its real duration has
// actually been played (the client only credits forward playback, so scrubbing
// to the end does not count).
const DRIP_VIDEO_RATIO = 0.9;

function dripRecId(prefix, sid, lid) {
    return prefix + '-' + String(sid).replace(/[^A-Za-z0-9-]/g, '') + '-' + String(lid).replace(/[^A-Za-z0-9-]/g, '');
}

function dripModeOfLesson(l) {
    if (!l) return 'immediate';
    if (l.releaseMode === 'drip' || l.releaseMode === 'date' || l.releaseMode === 'immediate') return l.releaseMode;
    return l.publishAt ? 'date' : 'immediate';
}

function dripReadEstimateSecs(content) {
    let words = 0;
    try { words = String(content || '').split(/\s+/).filter(Boolean).length; } catch (e) { words = 0; }
    const mins = Math.max(1, Math.ceil(words / 200));
    return Math.max(15, mins * 60);
}

function dripLessonContent(db, lesson) {
    const note = (db.notes || []).find(n => String(n.lessonId) === String(lesson.id));
    return (note && note.content) || lesson.description || lesson.reference || '';
}

function dripPaceMs(course) {
    let d = DRIP_DEFAULT_PACE_DAYS;
    if (course && typeof course.dripDaysBetween === 'number' && course.dripDaysBetween >= 0) d = course.dripDaysBetween;
    if (course && course.dripDaysBetween != null && course.dripDaysBetween !== '' && !isNaN(parseFloat(course.dripDaysBetween))) {
        const f = parseFloat(course.dripDaysBetween);
        if (f >= 0) d = f;
    }
    return Math.round(d * 86400000);
}

// Lesson parts are grouped into UNITS by the leading "Lesson N" prefix of the
// title (e.g. "Lesson 1 ...", "Lesson 1 VIDEO 1" all belong to "Lesson 1").
// Within a unit the chain advances INSTANTLY (Notes -> VIDEO 1 -> VIDEO 2...);
// the course pace gap only applies between UNITS (Lesson 1 -> Lesson 2).
// Lessons without a "Lesson N" prefix are each their own unit (unchanged).
function dripGroupOfLesson(l) {
    try {
        const m = /^Lesson\s+(\d+)/i.exec(String((l && l.title) || '').trim());
        if (m) return 'L' + parseInt(m[1], 10);
    } catch (e) {}
    return 'T' + String((l && l.id) || '');
}
function dripSameLessonUnit(a, b) {
    return dripGroupOfLesson(a) === dripGroupOfLesson(b);
}

function dripStartOfWeek(d) {
    const dt = d ? new Date(d) : new Date();
    if (isNaN(dt.getTime())) { const n = new Date(); n.setHours(0, 0, 0, 0); n.setDate(n.getDate() - ((n.getDay() + 6) % 7)); return n; }
    const dow = (dt.getDay() + 6) % 7;
    const s = new Date(dt);
    s.setHours(0, 0, 0, 0);
    s.setDate(s.getDate() - dow);
    return s;
}

// Fee gate decision for a learner. Returns lock detail; ok=true means drip may advance.
function dripFeeOk(db, sid) {
    const none = { ok: true, target: 0, paid: 0, cumulativeTarget: 0, deadlineMs: 0, weeksElapsed: 1, msg: '' };
    let me = (db.students || []).find(s => String(s.id) === String(sid) || String(s.admissionNumber || '') === String(sid));
    if (!me && sid) me = { id: String(sid) };
    if (!me) return none;
    let gate = null;
    try {
        const rec = (db.settings || []).find(r => r && r.key === 'feeGate');
        gate = rec ? (rec.value && typeof rec.value === 'object' ? rec.value : rec) : null;
    } catch (e) { gate = null; }
    if (!gate || !gate.enabled || !(Number(gate.amount) > 0)) return none;
    if (gate.mode === 'per-region' && me.studyCenterId) {
        const center = (db.studyCenters || []).find(c => String(c.id) === String(me.studyCenterId));
        const rid = center ? (center.regionId || '') : '';
        const rc = rid && gate.regions ? gate.regions[rid] : null;
        if (rc && rc.enabled) {
            gate = Object.assign({}, gate, {
                amount: (rc.amount || gate.amount || 0), day: (rc.day != null ? rc.day : (gate.day != null ? gate.day : 1)),
                time: rc.time || gate.time || '12:00', scope: rc.scope || 'all', overrides: rc.overrides || {}
            });
        }
    }
    const ov = (gate.overrides && gate.overrides[me.id]) || {};
    if (ov.exempt) return none;
    const scope = gate.scope || 'all';
    if (scope === 'selected' && !ov.picked) return none;
    if (scope === 'except' && ov.picked) return none;
    const target = (ov.amount > 0 ? ov.amount : gate.amount) || 0;
    if (!(target > 0)) return none;
    const anchor = dripStartOfWeek(me.enrollDate || me.registrationRequestedAt || me.createdAt);
    const weeksElapsed = Math.max(1, Math.floor((Date.now() - anchor.getTime()) / (7 * 86400000)) + 1);
    const cumulativeTarget = weeksElapsed * target;
    const mine = (db.payments || []).filter(p => String(p.studentId) === String(me.id));
    const totalPaid = mine.reduce((s, p) => s + (Number(p.amount) || 0), 0) +
        (db.waivers || []).filter(w => String(w.studentId) === String(me.id)).reduce((s, w) => s + (Number(w.amount) || 0), 0);
    const today = new Date().toISOString().split('T')[0];
    const agreement = (db.feeAgreements || []).find(a => String(a.studentId) === String(me.id) && a.status === 'approved' && String(a.dueDate || '') >= today);
    if (agreement) return Object.assign({}, none, { target, paid: totalPaid, cumulativeTarget, weeksElapsed });
    const dayOff = (parseInt(gate.day != null ? gate.day : 1, 10) + 6) % 7;
    const ws = dripStartOfWeek(new Date());
    const deadline = new Date(ws);
    deadline.setDate(ws.getDate() + dayOff);
    const parts = String(gate.time || '12:00').split(':');
    deadline.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
    if (Date.now() < deadline.getTime()) return Object.assign({}, none, { target, paid: totalPaid, cumulativeTarget, deadlineMs: deadline.getTime(), weeksElapsed });
    const met = totalPaid >= cumulativeTarget;
    return { ok: met, target, paid: totalPaid, cumulativeTarget, deadlineMs: deadline.getTime(), weeksElapsed, msg: met ? '' : 'weekly fee target not met' };
}

function dripQuizBestForLesson(db, sid, lessonId) {
    const quizzes = (db.quizzes || []).filter(q => q && String(q.lessonId) === String(lessonId) && q.published !== false);
    if (!quizzes.length) return { required: false, best: -1, attemptsUsed: 0, retriesLeft: 0, maxRetries: 2, passed: false, skipped: false };
    const qids = new Set(quizzes.map(q => String(q.id)));
    let best = -1;
    const scores = [];
    (db.submissions || []).forEach(s => {
        if (qids.has(String(s.quizId)) && String(s.studentId) === String(sid) && s.status !== 'pending_review' && typeof s.score === 'number') {
            scores.push(Number(s.score));
            if (s.score > best) best = s.score;
        }
    });
    (db.grades || []).forEach(g => {
        if (qids.has(String(g.quizId)) && String(g.studentId) === String(sid) && typeof g.score === 'number') {
            scores.push(Number(g.score));
            if (g.score > best) best = g.score;
        }
    });
    const maxRetries = quizzes.reduce((m, q) => Math.max(m, Number(q.maxRetakes != null ? q.maxRetakes : 2) || 0), 0);
    const attemptsUsed = scores.length;
    const retriesLeft = Math.max(0, maxRetries - Math.max(0, attemptsUsed - 1));
    const comp = (db.lessonCompletions || []).find(r => String(r.studentId) === String(sid) && String(r.lessonId) === String(lessonId));
    const skipped = !!(comp && comp.quizSkippedAt);
    return { required: true, best, attemptsUsed, retriesLeft, maxRetries, quizIds: Array.from(qids), passed: best >= DRIP_PASS, skipped, quizzes: quizzes.length };
}

// A lesson's ordered list of videos. Lessons keep working with the single
// `videoUrl` they already have; staff can add more and they are served in the
// order shown. Each video gets a stable id so watch progress can be tracked
// per video rather than per lesson.
function dripLessonVideos(lesson) {
    if (!lesson) return [];
    const list = Array.isArray(lesson.videos) ? lesson.videos : [];
    const out = [];
    list.forEach((v, i) => {
        const url = String((v && (v.url || v.videoUrl || v.link)) || '').trim();
        if (!url) return;
        out.push({
            id: String((v && v.id) || ('V' + (i + 1))),
            title: String((v && v.title) || ('Video ' + (i + 1))),
            url,
            required: v && v.required === false ? false : true
        });
    });
    const legacy = String(lesson.videoUrl || lesson.video || lesson.videoLink || '').trim();
    if (legacy && !out.some(v => v.url === legacy)) {
        out.unshift({ id: 'V1', title: 'Video 1', url: legacy, required: true });
    }
    out.forEach((v, i) => { v.index = i + 1; });
    return out;
}

// Videos that must be watched before the lesson can complete.
function dripRequiredVideos(lesson) {
    return dripLessonVideos(lesson).filter(v => v.required !== false && dripVideoTrackable(v.url));
}

// Watch state for every video of a lesson, in order. A video only opens once
// the previous one is finished, so they are watched one at a time.
function dripVideoStates(lesson, comp) {
    const progress = (comp && comp.videoProgress && typeof comp.videoProgress === 'object') ? comp.videoProgress : {};
    const list = dripLessonVideos(lesson);
    const states = [];
    let prevDone = true;   // the first video is always open once the lesson is
    list.forEach(v => {
        const trackable = dripVideoTrackable(v.url);
        const p = progress[v.id] || {};
        const dur = Number(p.durationSecs) || 0;
        const seen = Number(p.secs) || 0;
        const done = !trackable ? true
            : !!(p.doneAt || (comp && comp.videoDoneAt && v.id === 'V1'))
                || (dur > 0 && seen > 0 && seen >= dur * DRIP_VIDEO_RATIO);
        states.push({
            id: v.id, title: v.title, url: v.url, index: v.index,
            trackable, required: v.required !== false,
            secs: seen, durationSecs: dur,
            done,
            state: done ? 'done' : (prevDone ? 'open' : 'locked'),
            pct: dur > 0 ? Math.min(100, Math.round((seen / dur) * 100)) : (done ? 100 : 0)
        });
        // Only a finished video unlocks the next one.
        prevDone = done;
    });
    return states;
}

// Every required video of the lesson watched.
function dripVideosDone(lesson, comp) {
    const req = dripRequiredVideos(lesson);
    if (!req.length) return true;
    const states = dripVideoStates(lesson, comp);
    return req.every(v => { const st = states.find(s => s.id === v.id); return !st || st.done; });
}

// Record watch progress for one video of a lesson.
function dripRecordVideoProgress(comp, videoId, secs, durationSecs) {
    if (!comp || comp.videoProgress == null) comp.videoProgress = {};
    const key = String(videoId || 'V1');
    const p = comp.videoProgress[key] || { secs: 0, durationSecs: 0 };
    const s = Number(secs);
    const d = Number(durationSecs);
    if (Number.isFinite(s) && s >= 0) p.secs = Math.max(p.secs || 0, Math.round(s));
    if (Number.isFinite(d) && d > 0) p.durationSecs = Math.round(d);
    const dur = p.durationSecs || 0;
    if (dur > 0 && p.secs >= dur * DRIP_VIDEO_RATIO) {
        if (!p.doneAt) p.doneAt = new Date().toISOString();
    }
    comp.videoProgress[key] = p;
    return p;
}

// ---- Lesson video ----------------------------------------------------------
// A lesson's video source, if any. Kept in one place so the server and the
// completion rule agree on what counts as "this lesson has a video".
function dripLessonVideo(lesson) {
    if (!lesson) return '';
    return String(lesson.videoUrl || lesson.video || lesson.videoLink || '').trim();
}

// Only embeddable/servable sources can be watched-tracked (a bare "open this
// link" URL cannot report play progress), so only those gate completion.
function dripVideoTrackable(url) {
    const s = String(url || '').trim();
    if (!s) return false;
    if (/vimeo\.com\/(?:video\/|channels\/[^\/]+\/)?\d+/i.test(s)) return true;
    if (/youtube\.com\/(?:watch\?|embed\/|shorts\/)|youtu\.be\//i.test(s)) return true;
    if (/\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(s)) return true;
    return false;
}
function dripVideoRequired(lesson) {
    return dripVideoTrackable(dripLessonVideo(lesson));
}
// Watched-enough test. Needs a known real duration AND enough credited seconds,
// or an already-stamped videoDoneAt (e.g. granted by staff).
function dripVideoDone(comp) {
    if (!comp) return false;
    if (comp.videoDoneAt) return true;
    const dur = Number(comp.videoDurationSecs) || 0;
    const seen = Number(comp.videoSecs) || 0;
    if (!(dur > 0) || !(seen > 0)) return false;
    return seen >= dur * DRIP_VIDEO_RATIO;
}

// Recompute a learner's completion for one lesson (read time + video watch +
// linked quizzes). Returns the upserted completion row and whether it just
// flipped to complete. An already-stamped completedAt is never revoked, so
// adding a video to a lesson later cannot un-complete work already done.
function dripEvalCompletion(db, sid, lesson, opts) {
    opts = opts || {};
    db.lessonCompletions = db.lessonCompletions || [];
    const requiredSecs = dripReadEstimateSecs(opts.useContent != null ? opts.useContent : dripLessonContent(db, lesson));
    let comp = db.lessonCompletions.find(r => String(r.studentId) === String(sid) && String(r.lessonId) === String(lesson.id));
    const wasComplete = !!(comp && comp.completedAt);
    if (!comp) {
        comp = { id: dripRecId('LC', sid, lesson.id), studentId: String(sid), lessonId: String(lesson.id), courseId: String(lesson.courseId || ''), readSecs: 0, requiredSecs };
        db.lessonCompletions.push(comp);
    }
    comp.requiredSecs = requiredSecs;
    const readDone = (comp.readSecs || 0) >= requiredSecs;
    const videoStates = dripVideoStates(lesson, comp);
    const reqVideos = dripRequiredVideos(lesson);
    const videoRequired = reqVideos.length > 0;
    const videoDone = !videoRequired || dripVideosDone(lesson, comp);
    const q = dripQuizBestForLesson(db, sid, lesson.id);
    // A failed lesson quiz blocks the next lesson, but only until the retries
    // are used up - or until the learner chooses to continue anyway.
    const quizPassed = !q.required || q.passed;
    const quizOverlooked = !!(q.required && q.skipped);
    const quizDone = quizPassed || quizOverlooked;
    if (q.best >= 0) comp.quizBest = q.best;
    comp.quizAttemptsUsed = q.attemptsUsed || 0;
    comp.quizRetriesLeft = q.retriesLeft || 0;
    const now = new Date().toISOString();
    if (readDone && !comp.readDoneAt) comp.readDoneAt = now;
    if (videoRequired) comp.videoRequired = true;
    if (videoDone && videoRequired && !comp.videoDoneAt) comp.videoDoneAt = now;
    if (quizPassed && !comp.quizPassedAt) comp.quizPassedAt = now;
    if (readDone && videoDone && quizDone && !comp.completedAt) comp.completedAt = now;
    comp.justCompleted = !wasComplete && !!comp.completedAt;
    if (opts.resetForRepeat) {
        comp.readSecs = 0; comp.readDoneAt = null; comp.quizPassedAt = null; comp.quizBest = undefined; comp.completedAt = null;
        comp.videoSecs = 0; comp.videoDurationSecs = undefined; comp.videoDoneAt = null; comp.videoProgress = {};
        comp.quizSkippedAt = null;
        comp.justCompleted = false;
    }
    // Per-video watch states travel with the completion row so the hub can
    // show Video 1, Video 2 ... each opening only after the previous is done.
    comp.videoStates = dripVideoStates(lesson, comp);
    comp.quizState = q.required
        ? (q.passed ? 'passed' : (q.skipped ? 'overlooked' : (q.retriesLeft > 0 ? 'retry' : 'failed')))
        : 'none';
    const idx = db.lessonCompletions.findIndex(r => String(r.studentId) === String(sid) && String(r.lessonId) === String(lesson.id));
    if (idx >= 0) db.lessonCompletions[idx] = comp; else db.lessonCompletions.push(comp);
    return comp;
}

// ---- Course-level lesson rollup -------------------------------------------
// How many of a course's published lessons one learner has completed, and
// whether that is ALL of them. This is what turns per-lesson reading + video
// progress into a course-coverage signal.
function dripCourseLessonRollup(db, sid, courseId) {
    const lessons = (db.lessons || []).filter(l => l && l.published !== false && String(l.courseId) === String(courseId));
    const total = lessons.length;
    if (!total) return { hasLessons: false, total: 0, done: 0, complete: false };
    const mine = (db.lessonCompletions || []).filter(r => String(r.studentId) === String(sid) && r && r.completedAt);
    const doneIds = new Set(mine.map(r => String(r.lessonId)));
    let done = 0;
    lessons.forEach(l => { if (doneIds.has(String(l.id))) done++; });
    return { hasLessons: true, total, done, complete: done === total };
}

// One pass over lessons + completions -> { 'studentId|courseId': {total,done,complete} }
// for every learner who has completed at least one lesson. Lessons that are not
// published members of that course are ignored, and duplicate rows never
// double count.
function dripLessonCoverIndex(db) {
    const byCourse = {};
    (db.lessons || []).forEach(l => {
        if (!l || l.published === false || l.courseId == null) return;
        const c = String(l.courseId);
        if (!byCourse[c]) byCourse[c] = new Set();
        byCourse[c].add(String(l.id));
    });
    const idx = {};
    (db.lessonCompletions || []).forEach(r => {
        if (!r || !r.completedAt || r.courseId == null) return;
        const ids = byCourse[String(r.courseId)];
        if (!ids || !ids.has(String(r.lessonId))) return;
        const key = String(r.studentId) + '|' + String(r.courseId);
        if (!idx[key]) idx[key] = { total: ids.size, done: 0, _seen: new Set() };
        if (idx[key]._seen.has(String(r.lessonId))) return;
        idx[key]._seen.add(String(r.lessonId));
        idx[key].done++;
    });
    Object.keys(idx).forEach(k => {
        const e = idx[k];
        e.complete = e.total > 0 && e.done >= e.total;
        delete e._seen;
    });
    return idx;
}

// Sweep a learner's unlock chain across all (or one) course. Grants whatever is
// due; idempotent and self-healing. Returns changed flag + current fee state.
function dripSweep(db, sid, courseIdOnly) {
    db.lessonUnlocks = db.lessonUnlocks || [];
    db.lessonCompletions = db.lessonCompletions || [];
    const myU = db.lessonUnlocks.filter(r => String(r.studentId) === String(sid));
    const myC = db.lessonCompletions.filter(r => String(r.studentId) === String(sid));
    const ordered = (db.lessons || []).filter(l => l && l.published !== false && (!courseIdOnly || String(l.courseId) === String(courseIdOnly))).sort((a, b) => (a.order || 0) - (b.order || 0));
    const byCourse = {};
    ordered.forEach(l => { if (l.courseId != null) (byCourse[l.courseId] = byCourse[l.courseId] || []).push(l); });
    const fee = dripFeeOk(db, sid);
    let changed = false;
    for (const cid of Object.keys(byCourse)) {
        const drips = byCourse[cid].filter(l => dripModeOfLesson(l) === 'drip');
        if (!drips.length) continue;
        const course = (db.courses || []).find(c => String(c.id) === String(cid));
        const paceMs = dripPaceMs(course);
        if (!fee.ok) break;
        for (let i = 0; i < drips.length; i++) {
            const l = drips[i];
            if (myU.some(r => String(r.lessonId) === String(l.id))) continue;
            if (i === 0) {
                db.lessonUnlocks.push({ id: dripRecId('LU', sid, l.id), studentId: String(sid), lessonId: String(l.id), courseId: String(l.courseId || ''), unlockedAt: new Date().toISOString(), by: 'drip' });
                changed = true;
                continue;
            }
            const prev = drips[i - 1];
            const pc = myC.find(r => String(r.lessonId) === String(prev.id));
            if (!pc || !pc.completedAt) break;
            const pu = myU.find(r => String(r.lessonId) === String(prev.id));
            const anchor = Math.max(pu ? (+new Date(pu.unlockedAt) || 0) : 0, +new Date(pc.completedAt) || 0);
            // No gap between parts of the SAME lesson unit (Notes -> VIDEO 1 ->
            // VIDEO 2 -> ...); the course pace only applies between units.
            const gapMs = dripSameLessonUnit(prev, l) ? 0 : paceMs;
            if (gapMs > 0 && Date.now() - anchor < gapMs) break;
            db.lessonUnlocks.push({ id: dripRecId('LU', sid, l.id), studentId: String(sid), lessonId: String(l.id), courseId: String(l.courseId || ''), unlockedAt: new Date().toISOString(), by: 'drip' });
            changed = true;
        }
    }
    return { changed, fee };
}

function dripMapsFor(db, sid) {
    return {
        unlocks: (db.lessonUnlocks || []).filter(r => String(r.studentId) === String(sid)),
        completions: (db.lessonCompletions || []).filter(r => String(r.studentId) === String(sid))
    };
}

// Describe the next lesson to present to the learner after `afterLessonId`.
function dripNextInfo(db, sid, courseId, afterLessonId) {
    const ordered = (db.lessons || []).filter(l => l && l.published !== false && String(l.courseId) === String(courseId)).sort((a, b) => (a.order || 0) - (b.order || 0));
    const drips = ordered.filter(l => dripModeOfLesson(l) === 'drip');
    const idx = drips.findIndex(l => String(l.id) === String(afterLessonId));
    if (idx < 0 || idx + 1 >= drips.length) return null;
    const nx = drips[idx + 1];
    const myU = (db.lessonUnlocks || []).filter(r => String(r.studentId) === String(sid));
    const myC = (db.lessonCompletions || []).filter(r => String(r.studentId) === String(sid));
    if (myU.some(r => String(r.lessonId) === String(nx.id))) return { lessonId: nx.id, title: nx.title, reason: 'open' };
    const fee = dripFeeOk(db, sid);
    if (!fee.ok) return { lessonId: nx.id, title: nx.title, reason: 'fees', fee: { target: fee.target, paid: fee.paid, cumulativeTarget: fee.cumulativeTarget, deadlineMs: fee.deadlineMs } };
    const prev = drips[idx];
    const pc = myC.find(r => String(r.lessonId) === String(prev.id));
    if (!pc || !pc.completedAt) return { lessonId: nx.id, title: nx.title, reason: 'prev' };
    const course = (db.courses || []).find(c => String(c.id) === String(courseId));
    const paceMs = dripPaceMs(course);
    const pu = myU.find(r => String(r.lessonId) === String(prev.id));
    const anchor = Math.max(pu ? (+new Date(pu.unlockedAt) || 0) : 0, +new Date(pc.completedAt) || 0);
    const gapMs = dripSameLessonUnit(prev, nx) ? 0 : paceMs;
    if (gapMs > 0 && Date.now() - anchor < gapMs) {
        const paceDays = (course && course.dripDaysBetween != null && course.dripDaysBetween !== '' && !isNaN(parseFloat(course.dripDaysBetween))) ? parseFloat(course.dripDaysBetween) : DRIP_DEFAULT_PACE_DAYS;
        return { lessonId: nx.id, title: nx.title, reason: 'pace', paceDays, opensAtMs: anchor + gapMs };
    }
    return { lessonId: nx.id, title: nx.title, reason: 'open' };
}

module.exports = {
    DRIP_PASS, DRIP_DEFAULT_PACE_DAYS, DRIP_VIDEO_RATIO,
    dripRecId, dripModeOfLesson, dripReadEstimateSecs, dripLessonContent, dripPaceMs,
    dripGroupOfLesson, dripSameLessonUnit,
    dripLessonVideo, dripVideoTrackable, dripVideoRequired, dripVideoDone,
    dripLessonVideos, dripRequiredVideos, dripVideoStates, dripVideosDone, dripRecordVideoProgress,
    dripStartOfWeek, dripFeeOk, dripQuizBestForLesson, dripEvalCompletion, dripSweep,
    dripMapsFor, dripNextInfo, dripCourseLessonRollup, dripLessonCoverIndex
};