'use strict';

// Server-side course-sequence gate.
//
// The browser has enforced the transcript/program order since it was added,
// but that is only a UI guard: a student can call the DB/drip endpoints
// directly and read content for a course that is still locked. This module is
// the authoritative copy of the rule. It mirrors the client's
// `studentCourseStatuses` / `isCourseCovered` logic so the server and the UI
// agree, while keeping the decision out of the browser.
//
// Lock sources, in order:
//   1. contentGate.students[studentId].exempt       -> no gate at all
//   2. contentGate.students[studentId].locks[id]    -> per-student override
//   3. contentGate.centers[centerId] (per-center)   -> scope override
//   4. contentGate.regions[regionId] (per-region)   -> scope override
//   5. contentGate.locks                            -> global default
// A lock value is 'locked', 'unlocked', or absent ('auto' = sequence rule).
// A course is accessible when it is already covered, is the current course in
// the sequence, or has an explicit 'unlocked' override. An explicit 'locked'
// override blocks the current/future course but never hides completed work.

const DEFAULT_TRANSCRIPT_ORDER = [
    "GOD'S CALL TO MINISTRY",
    "GOD'S WAY OF SALVATION",
    "OLD TESTAMENT SURVEY",
    "NEW TESTAMENT SURVEY",
    "PASTORAL CARE",
    "TEMPERAMENTS",
    "CHRISTIAN MARRIAGE AND FAMILY",
    "TEACHING GOD'S WAY",
    "LIVING FOR CHRIST",
    "DIACONAL MINISTRY",
    "PASSION FOR PREACHING",
    "THE CHURCH THE BODY OF CHRIST"
];

const CACHE_TTL_MS = 10000;
const CACHE_MAX_ENTRIES = 5000;
const _cache = new Map();

function arr(v) { return Array.isArray(v) ? v : []; }

function settingRecord(db, key) {
    return arr(db && db.settings).find(s => s && s.key === key) || null;
}

function settingValue(db, key) {
    const rec = settingRecord(db, key);
    if (!rec) return null;
    return rec.value !== undefined ? rec.value : rec;
}

function transcriptOrder(db) {
    const academic = settingValue(db, 'academic');
    const fromSettings = academic && Array.isArray(academic.transcriptCourseOrder)
        ? academic.transcriptCourseOrder
        : null;
    const list = (fromSettings && fromSettings.length) ? fromSettings : DEFAULT_TRANSCRIPT_ORDER;
    return list.map(x => String(x || '').toUpperCase()).filter(Boolean);
}

function courseSeq(course, allCourses, order) {
    if (course && Number(course.order) > 0) return Number(course.order);
    const tList = order || [];
    const idx = tList.indexOf(String((course && course.name) || '').toUpperCase());
    if (idx !== -1) return idx + 1;
    const list = allCourses || [];
    const unlisted = list.filter(c =>
        tList.indexOf(String((c && c.name) || '').toUpperCase()) === -1 &&
        !(c && Number(c.order) > 0)
    ).sort((a, b) => String(a.code || a.name || a.id) < String(b.code || b.name || b.id) ? -1 : 1);
    const pos = unlisted.findIndex(c => course && String(c.id) === String(course.id));
    return tList.length + 1 + (pos === -1 ? unlisted.length : pos);
}

function sortCoursesBySequence(courses, order) {
    const list = arr(courses);
    return list.slice().sort((a, b) => courseSeq(a, list, order) - courseSeq(b, list, order));
}

function buildLessonCoverIndex(lessons, lessonCompletions) {
    const byCourse = {};
    arr(lessons).forEach(l => {
        if (!l || l.published === false || l.courseId == null) return;
        const c = String(l.courseId);
        if (!byCourse[c]) byCourse[c] = new Set();
        byCourse[c].add(String(l.id));
    });
    const idx = {};
    arr(lessonCompletions).forEach(r => {
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

function courseLessonRollup(data, studentId, courseId) {
    if (!data || !Array.isArray(data.lessons)) return null;
    const idx = data._lessonCoverIdx;
    if (idx) {
        const e = idx[String(studentId) + '|' + String(courseId)];
        if (!e || !e.total) return { hasLessons: false, total: 0, done: 0, complete: false };
        return { hasLessons: true, total: e.total, done: e.done, complete: !!e.complete };
    }
    const comps = arr(data.lessonCompletions);
    const lessons = data.lessons.filter(l => l && l.published !== false && String(l.courseId) === String(courseId));
    if (!lessons.length) return { hasLessons: false, total: 0, done: 0, complete: false };
    const doneIds = new Set(comps.filter(r => String(r.studentId) === String(studentId) && r && r.completedAt).map(r => String(r.lessonId)));
    let done = 0;
    lessons.forEach(l => { if (doneIds.has(String(l.id))) done++; });
    return { hasLessons: true, total: lessons.length, done, complete: done === lessons.length };
}

function coursePassMark(course) {
    return (course && Number(course.passMark) > 0) ? Number(course.passMark) : 50;
}

function isCourseCovered(studentId, courseId, data) {
    if (!studentId || !courseId || !data) return false;
    const manual = arr(data.courseCompletions).some(c =>
        String(c.studentId) === String(studentId) &&
        String(c.courseId) === String(courseId) &&
        c.covered !== false
    );
    if (manual) return true;
    const roll = courseLessonRollup(data, studentId, courseId);
    if (roll && roll.hasLessons && roll.complete) return true;
    const course = arr(data.courses).find(c => String(c.id) === String(courseId));
    const pm = coursePassMark(course);
    const passedGrade = arr(data.grades).some(g =>
        String(g.studentId) === String(studentId) &&
        String(g.courseId) === String(courseId) &&
        Number(g.score) >= pm
    );
    if (passedGrade) return true;
    const quizzes = arr(data.quizzes);
    const exams = arr(data.exams);
    const passedSub = arr(data.submissions).some(s => {
        if (String(s.studentId) !== String(studentId) || s.status !== 'pass') return false;
        const q = s.quizId ? quizzes.find(x => String(x.id) === String(s.quizId)) : null;
        const e = s.examId ? exams.find(x => String(x.id) === String(s.examId))
            : (s.quizId ? exams.find(x => String(x.linkedQuizId) === String(s.quizId)) : null);
        const cid = (q && q.courseId) || (e && e.courseId) || '';
        return String(cid) === String(courseId);
    });
    return !!passedSub;
}

function studentCourseStatuses(studentId, courses, data) {
    const work = sortCoursesBySequence(courses || [], data && data._transcriptOrder);
    const out = {};
    let currentFound = false;
    work.forEach(c => {
        if (isCourseCovered(studentId, c.id, data)) { out[c.id] = 'covered'; return; }
        if (!currentFound) { out[c.id] = 'current'; currentFound = true; return; }
        out[c.id] = 'future';
    });
    return out;
}

function migrateLocks(obj) {
    const locks = { ...((obj && obj.locks) || {}) };
    arr(obj && obj.unlocked).forEach(id => { if (!locks[id]) locks[id] = 'unlocked'; });
    return locks;
}

function effectiveGate(db, studentId) {
    const gate = settingValue(db, 'contentGate');
    if (!gate || typeof gate !== 'object') return { gated: false, locks: {}, exempt: false };
    const student = arr(db.students).find(s => String(s.id) === String(studentId)) || null;
    const sid = String(studentId);
    const sOv = gate.students ? (gate.students[sid] || gate.students[studentId] || null) : null;
    if (sOv && sOv.exempt) return { gated: false, locks: {}, exempt: true };

    let eff = { enabled: !!gate.enabled, locks: migrateLocks(gate) };
    const centerId = student && student.studyCenterId ? String(student.studyCenterId) : '';
    if (centerId && gate.mode === 'per-center' && gate.centers && gate.centers[centerId]) {
        const rc = gate.centers[centerId];
        eff = rc.enabled ? { enabled: true, locks: migrateLocks(rc) } : { enabled: false, locks: {} };
    } else if (centerId && gate.mode === 'per-region' && gate.regions) {
        const center = arr(db.studyCenters).find(c => String(c.id) === centerId);
        const rid = center && center.regionId ? String(center.regionId) : '';
        const rr = rid && gate.regions[rid];
        if (rr) eff = rr.enabled ? { enabled: true, locks: migrateLocks(rr) } : { enabled: false, locks: {} };
    }
    const studentLocks = migrateLocks(sOv);
    Object.keys(studentLocks).forEach(cid => { eff.locks[cid] = studentLocks[cid]; });
    return {
        gated: !!eff.enabled,
        locks: eff.locks,
        exempt: false,
        mode: gate.mode || 'global',
        centerId
    };
}

function buildContext(db, studentId) {
    const sid = String(studentId);
    const gate = effectiveGate(db, sid);
    if (!gate.gated) {
        return { gated: false, gate, statuses: null, allowed: null, enrolled: new Set() };
    }
    const courses = arr(db.courses);
    const enrollments = arr(db.enrollments).filter(e => String(e.studentId) === sid);
    const enrolled = new Set(enrollments.map(e => String(e.courseId)));
    const lessonIdx = buildLessonCoverIndex(db.lessons, db.lessonCompletions);
    const data = {
        courses,
        enrollments,
        grades: arr(db.grades),
        submissions: arr(db.submissions),
        quizzes: arr(db.quizzes),
        exams: arr(db.exams),
        lessons: arr(db.lessons),
        lessonCompletions: arr(db.lessonCompletions),
        courseCompletions: arr(db.courseCompletions),
        _lessonCoverIdx: lessonIdx,
        _transcriptOrder: transcriptOrder(db)
    };
    const statuses = studentCourseStatuses(sid, courses, data);
    const allowed = new Set();
    courses.forEach(c => {
        const cid = String(c.id);
        const st = statuses[cid] || statuses[c.id] || 'current';
        const lockState = gate.locks[cid] || gate.locks[c.id] || 'auto';
        if (!enrolled.has(cid)) { allowed.add(cid); return; } // catalog visibility only
        if (st === 'covered' || lockState === 'unlocked') { allowed.add(cid); return; }
        if (lockState === 'locked') return;
        if (st === 'current') allowed.add(cid);
    });
    return { gated: true, gate, statuses, allowed, enrolled };
}

function contextFor(db, studentId) {
    const sid = String(studentId || '');
    if (!sid) return { gated: false, gate: { gated: false, locks: {} }, statuses: null, allowed: null, enrolled: new Set() };
    const now = Date.now();
    const hit = _cache.get(sid);
    if (hit && (now - hit.at) < CACHE_TTL_MS) return hit.value;
    const value = buildContext(db, sid);
    if (_cache.size >= CACHE_MAX_ENTRIES) _cache.clear();
    _cache.set(sid, { at: now, value });
    return value;
}

function invalidate() { _cache.clear(); }

function courseAccess(db, studentId, courseId) {
    if (!studentId || !courseId) return { ok: true, gated: false };
    const ctx = contextFor(db, studentId);
    if (!ctx.gated) return { ok: true, gated: false };
    const cid = String(courseId);
    if (!ctx.enrolled.has(cid)) return { ok: true, gated: true, reason: 'not-enrolled' };
    const lockState = ctx.gate.locks[cid] || 'auto';
    const status = (ctx.statuses && (ctx.statuses[cid] || ctx.statuses[courseId])) || 'current';
    if (lockState === 'unlocked') return { ok: true, gated: true, status, override: true };
    if (status === 'covered') return { ok: true, gated: true, status };
    if (lockState === 'locked') return { ok: false, gated: true, status, reason: 'manual' };
    if (status === 'current') return { ok: true, gated: true, status };
    return { ok: false, gated: true, status, reason: 'sequence' };
}

function lockedMessage(access) {
    if (access && access.reason === 'manual') {
        return 'This course has been locked by an administrator. Contact the administrator if you need access.';
    }
    return 'This course is locked. Complete the earlier courses in the sequence first, or ask an administrator for an override.';
}

function createLookup(db) {
    const exams = new Map();
    const quizzes = mapById(db.quizzes, 'courseId');
    arr(db.exams).forEach(e => {
        if (e && e.id != null) exams.set(String(e.id), String(e.courseId || ''));
    });
    const lessons = mapById(db.lessons, 'courseId');
    // A submission may reference an exam only through its linked quiz.
    const examByQuiz = new Map();
    arr(db.exams).forEach(e => {
        if (e && e.linkedQuizId != null) examByQuiz.set(String(e.linkedQuizId), String(e.courseId || ''));
    });
    return {
        exams, quizzes, lessons, examByQuiz,
        assessmentCourseId: (store, rec) => {
            const target = assessmentForRecord(db, store, rec);
            return target ? String(target.courseId || '') : '';
        }
    };
}

function mapById(rows, field) {
    const out = new Map();
    arr(rows).forEach(r => {
        if (r && r.id != null) out.set(String(r.id), String(r[field] || ''));
    });
    return out;
}

// Best-effort course id for a record. Returns '' when the record is not tied to
// one course (general notices, settings, etc.) and must not be gated.
//
// For assessment-linked stores the assessment's own courseId wins over a
// caller-supplied rec.courseId: otherwise a student could submit against a
// locked exam while claiming an accessible course id on the payload.
function assessmentForRecord(db, store, rec) {
    if (!rec) return null;
    if (store === 'submissions' || store === 'retakeRequests') {
        // Match the server's marking path: quizId wins over examId, and the
        // quiz is looked up before an exam with the same id. Otherwise a
        // student could name an open exam in examId while the server scores a
        // locked quiz named in quizId.
        const id = rec.quizId || rec.examId;
        if (!id) return null;
        return arr(db.quizzes).find(x => x && String(x.id) === String(id))
            || arr(db.exams).find(x => x && String(x.id) === String(id))
            || null;
    }
    if (store === 'examRegistrations') {
        return rec.examId ? (arr(db.exams).find(x => x && String(x.id) === String(rec.examId)) || null) : null;
    }
    if (store === 'quizRegistrations') {
        return rec.quizId ? (arr(db.quizzes).find(x => x && String(x.id) === String(rec.quizId)) || null) : null;
    }
    return null;
}

function isUngatedAssessment(db, store, rec) {
    const target = assessmentForRecord(db, store, rec);
    if (!target) return false;
    if (target.ungated === true) return true;
    // Open-ended exams are published to every student and can be sat any time.
    if (target.openWindow === true) return true;
    // An exam whose window is currently open is accessible to everyone.
    if (target.date && target.time) {
        try {
            const now = Date.now();
            const start = new Date(String(target.date).slice(0,10) + 'T' + String(target.time).split('-')[0].trim() + ':00');
            if (!isNaN(start.getTime())) {
                const durMins = (target.durationDays||0)*1440 + (target.durationHours||0)*60 + (target.durationMinutes||0) + (target.timeLimitDays||0)*1440 + (target.timeLimitHours||0)*60 + (target.timeLimitMinutes||0) || parseInt(target.duration||target.timeLimit||0)||0;
                const close = durMins > 0 ? start.getTime() + durMins*60000 : start.getTime() + 4*86400000;
                if (target.closesAt) { const cd = new Date(String(target.closesAt).slice(0,10)+'T23:59:59'); if (!isNaN(cd.getTime())) { /* use closesAt if later */ } }
                if (now >= start.getTime() && now <= close) return true;
            }
        } catch (e) {}
    }
    if (target.openWindow === true) return true;
    return false;
}

function resolveCourseId(store, rec, lookup) {
    if (!rec) return '';
    if (store === 'submissions' || store === 'examRegistrations' ||
        store === 'quizRegistrations' || store === 'retakeRequests') {
        const target = lookup && lookup.assessmentCourseId
            ? lookup.assessmentCourseId(store, rec)
            : '';
        if (target) return String(target);
        return rec.courseId ? String(rec.courseId) : '';
    }
    if (rec.courseId) return String(rec.courseId);
    if (!lookup) return '';
    if (store === 'lessons' || store === 'notes') {
        const lid = rec.lessonId || (store === 'lessons' ? rec.id : '');
        return lid ? (lookup.lessons.get(String(lid)) || '') : '';
    }
    return '';
}

function gateDiff(oldGate, newGate) {
    const norm = g => {
        if (!g || typeof g !== 'object') return {};
        const v = g.value !== undefined ? g.value : g;
        return (v && typeof v === 'object') ? v : {};
    };
    const a = norm(oldGate);
    const b = norm(newGate);
    const changes = [];
    const add = (scope, kind, from, to, courseId) => {
        const entry = { scope, kind, from, to };
        if (courseId) entry.courseId = courseId;
        changes.push(entry);
    };
    const compareScope = (label, x, y) => {
        const al = migrateLocks(x);
        const bl = migrateLocks(y);
        const ids = new Set([...Object.keys(al), ...Object.keys(bl)]);
        ids.forEach(id => {
            const from = al[id] || 'auto';
            const to = bl[id] || 'auto';
            if (from !== to) add(label, 'lock', from, to, id);
        });
        if (!!(x && x.enabled) !== !!(y && y.enabled)) {
            add(label, 'enabled', !!(x && x.enabled), !!(y && y.enabled));
        }
        if (!!(x && x.exempt) !== !!(y && y.exempt)) {
            add(label, 'exempt', !!(x && x.exempt), !!(y && y.exempt));
        }
    };
    compareScope('global', a, b);
    ['regions', 'centers', 'students'].forEach(group => {
        const ag = (a[group] && typeof a[group] === 'object') ? a[group] : {};
        const bg = (b[group] && typeof b[group] === 'object') ? b[group] : {};
        const ids = new Set([...Object.keys(ag), ...Object.keys(bg)]);
        ids.forEach(id => {
            const label = (group === 'students' ? 'student:' : group === 'regions' ? 'region:' : 'center:') + id;
            compareScope(label, ag[id], bg[id]);
        });
    });
    const modeChanged = (a.mode || 'global') !== (b.mode || 'global');
    if (modeChanged) add('global', 'mode', a.mode || 'global', b.mode || 'global');
    return {
        fromMode: a.mode || 'global',
        toMode: b.mode || 'global',
        changed: changes.length,
        changes: changes.slice(0, 200),
        truncated: changes.length > 200,
        enabled: !!b.enabled
    };
}

module.exports = {
    arr,
    transcriptOrder,
    courseSeq,
    sortCoursesBySequence,
    buildLessonCoverIndex,
    courseLessonRollup,
    coursePassMark,
    isCourseCovered,
    studentCourseStatuses,
    effectiveGate,
    contextFor,
    courseAccess,
    lockedMessage,
    createLookup,
    assessmentForRecord,
    isUngatedAssessment,
    resolveCourseId,
    gateDiff,
    invalidate
};
