// Server-authoritative lesson drip engine.
// Mirrors the client-side drip rules but runs on the server so unlocks and
// completions are trusted, tamper-proof, and consistent across devices.
//
// Rules (all enforced HERE, not on the client device):
//   - completion  = note read for >= required seconds AND every linked (published)
//                   quiz best score >= DRIP_PASS (50)
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
    if ((db.quizzes || []).length === 0) return { required: false, best: -1 };
    const qids = new Set(db.quizzes.filter(q => String(q.lessonId) === String(lessonId) && q.published !== false).map(q => String(q.id)));
    if (!qids.size) return { required: false, best: -1 };
    let best = -1;
    (db.submissions || []).forEach(s => {
        if (qids.has(String(s.quizId)) && String(s.studentId) === String(sid) && s.status !== 'pending_review' && typeof s.score === 'number') {
            if (s.score > best) best = s.score;
        }
    });
    (db.grades || []).forEach(g => {
        if (qids.has(String(g.quizId)) && String(g.studentId) === String(sid) && typeof g.score === 'number') {
            if (g.score > best) best = g.score;
        }
    });
    return { required: true, best };
}

// Recompute a learner's completion for one lesson (read time + linked quizzes).
// Returns the upserted completion row and whether it just flipped to complete.
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
    const q = dripQuizBestForLesson(db, sid, lesson.id);
    const quizDone = !q.required || q.best >= DRIP_PASS;
    if (q.best >= 0) comp.quizBest = q.best;
    const now = new Date().toISOString();
    if (readDone && !comp.readDoneAt) comp.readDoneAt = now;
    if (quizDone && !comp.quizPassedAt) comp.quizPassedAt = now;
    if (readDone && quizDone && !comp.completedAt) comp.completedAt = now;
    comp.justCompleted = !wasComplete && !!comp.completedAt;
    if (opts.resetForRepeat) {
        comp.readSecs = 0; comp.readDoneAt = null; comp.quizPassedAt = null; comp.quizBest = undefined; comp.completedAt = null;
        comp.justCompleted = false;
    }
    const idx = db.lessonCompletions.findIndex(r => String(r.studentId) === String(sid) && String(r.lessonId) === String(lesson.id));
    if (idx >= 0) db.lessonCompletions[idx] = comp; else db.lessonCompletions.push(comp);
    return comp;
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
    DRIP_PASS, DRIP_DEFAULT_PACE_DAYS,
    dripRecId, dripModeOfLesson, dripReadEstimateSecs, dripLessonContent, dripPaceMs,
    dripGroupOfLesson, dripSameLessonUnit,
    dripStartOfWeek, dripFeeOk, dripQuizBestForLesson, dripEvalCompletion, dripSweep,
    dripMapsFor, dripNextInfo
};