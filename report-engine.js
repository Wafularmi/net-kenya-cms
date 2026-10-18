// report-engine.js — institutional reporting for NET Foundation.
//
// Computes a full statistical report for a scope (Country / Region / Study
// Center) over a period (Monthly / Quarterly / Half-Yearly / Annual) and a
// custom date window, then renders it as narrated prose plus a local
// recommendation engine ("AI") that turns those figures into practical,
// time-bound actions and a gap analysis against a stated vision.
//
// Everything is derived from live records — no hardcoded numbers.
const path = require('path');

const PERIOD_MONTHS = { monthly: 1, quarterly: 3, biannual: 6, annual: 12 };
const PERIOD_LABEL = { monthly: 'Monthly', quarterly: 'Quarterly', biannual: 'Half-Yearly (Bi-Annual)', annual: 'Annual' };

function pad2(n) { return String(n).padStart(2, '0'); }
function ym(d) { return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1); }
function day(d) { return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }

function shiftMonths(d, n) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    x.setUTCMonth(x.getUTCMonth() + n);
    return x;
}
function monthLen(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }

function toDateOnly(v) {
    if (v == null || v === '') return '';
    const t = String(v);
    return t.length >= 10 ? t.slice(0, 10) : t;
}
function inWindow(v, start, end) {
    const d = toDateOnly(v);
    return !!d && d >= start && d <= end;
}
function pct(a, b) { return b > 0 ? Math.round(a / b * 1000) / 10 : 0; }
function money(n, sym) {
    const s = sym || 'KES';
    const v = Math.round(Number(n) || 0);
    return s + ' ' + v.toLocaleString('en-KE');
}
function num(n) { return Number(n) || 0; }

function scopeLabel(db, scope, id) {
    if (scope === 'center') {
        const c = (db.studyCenters || []).find(x => String(x.id) === String(id));
        return c ? c.name : String(id || '');
    }
    if (scope === 'region') {
        const r = (db.regions || []).find(x => String(x.id) === String(id));
        return r ? r.name : String(id || '');
    }
    const cs = (db.settings || []).find(x => x.key === 'countries');
    const list = (cs && cs.value) || [];
    const c = list.find(x => x && (x.code === id || x.name === id));
    return c ? (c.brandName || c.name) : String(id || '');
}

function resolveScope(db, scope, id) {
    const students = (db.students || []).filter(s => {
        if (scope === 'center') return String(s.studyCenterId) === String(id);
        if (scope === 'region') return String(s.regionId) === String(id);
        return String(s.country) === String(id);
    });
    const centers = (db.studyCenters || []).filter(c => {
        if (scope === 'center') return String(c.id) === String(id);
        if (scope === 'region') return String(c.regionId) === String(id);
        return String(c.country) === String(id);
    });
    return { students, centers };
}

// ---------- core statistics ----------
function computeStats(db, scope, id, start, end) {
    const { students, centers } = resolveScope(db, scope, id);
    const sids = new Set(students.map(s => String(s.id)));
    const centerCourses = new Set();
    (db.courses || []).forEach(c => {
        if (!c || c.studyCenterId == null) return;
        if (centers.some(x => String(x.id) === String(c.studyCenterId))) centerCourses.add(String(c.id));
    });

    const inScope = r => sids.has(String(r.studentId));
    const inCenterCourse = c => centerCourses.size === 0 || centerCourses.has(String(c.courseId));

    // Enrollment
    const enrolled = students.filter(s => s.status === 'active');
    const newThis = students.filter(s => inWindow(s.enrollDate, start, end));

    // Coverage (current snapshot across the scope's courses)
    const scopeCourses = (db.courses || []).filter(c => centerCourses.size === 0 || centerCourses.has(String(c.id)));
    const courseIds = new Set(scopeCourses.map(c => String(c.id)));
    const lessons = (db.lessons || []).filter(l => l && l.published !== false && courseIds.has(String(l.courseId)));
    const lessonIds = new Set(lessons.map(l => String(l.id)));
    const comps = (db.lessonCompletions || []).filter(r => r && r.completedAt && sids.has(String(r.studentId)));
    const doneSet = new Set(comps.filter(r => lessonIds.has(String(r.lessonId))).map(r => String(r.studentId) + '|' + String(r.lessonId)));

    const perCourse = scopeCourses.map(c => {
        const cl = lessons.filter(l => String(l.courseId) === String(c.id));
        const compRows = comps.filter(r => cl.some(l => String(l.id) === String(r.lessonId)));
        const distinctStudents = new Set(compRows.map(r => String(r.studentId)));
        const coveredStudents = cl.length === 0 ? 0 : students.filter(s =>
            cl.every(l => doneSet.has(String(s.id) + '|' + String(l.id)))).length;
        return {
            courseId: c.id, name: c.name || c.code, code: c.code || '',
            credits: num(c.credits) || 3,
            lessonsTotal: cl.length, lessonsDone: distinctStudents.size,
            coveragePct: cl.length ? pct(distinctStudents.size, cl.length) : 0,
            studentsCovered: coveredStudents,
            studentsPct: students.length ? pct(coveredStudents, students.length) : 0
        };
    }).sort((a, b) => a.coveragePct - b.coveragePct);

    const lessonsTotal = lessons.length;
    const lessonsDone = doneSet.size;
    const coursesFullyCovered = perCourse.filter(c => c.lessonsTotal > 0 && c.studentsCovered > 0 &&
        c.coveragePct >= 100).length;
    const coursesCoveredByAll = perCourse.filter(c => c.lessonsTotal > 0 && c.studentsPct >= 100).length;

    // Attendance
    const att = (db.attendance || []).filter(r => inScope(r) && inCenterCourse(r) && inWindow(r.date, start, end));
    const present = att.filter(r => r.status === 'present').length;

    // Performance (submissions within window)
    const subs = (db.submissions || []).filter(r => inScope(r) && inWindow(r.createdAt, start, end));
    const scored = subs.filter(r => r.score != null);
    const avgScore = scored.length ? Math.round(scored.reduce((a, r) => a + num(r.score), 0) / scored.length) : 0;
    const pass = subs.filter(r => r.status === 'pass').length;
    const retakes = (db.retakeRequests || []).filter(r => inScope(r) && inWindow(r.createdAt || r.date, start, end)).length;

    // Financial
    const pays = (db.payments || []).filter(r => inScope(r) && inWindow(r.date, start, end));
    const collected = pays.reduce((a, r) => a + num(r.amount), 0);
    const tuitionCollected = pays.filter(r => !r.account || r.account === 'tuition').reduce((a, r) => a + num(r.amount), 0);
    const gradCollected = pays.filter(r => r.account === 'graduation').reduce((a, r) => a + num(r.amount), 0);
    const billed = enrolled.reduce((a, s) => a + num(s.feeAmount), 0);
    const paidAll = (db.payments || []).filter(r => inScope(r) && (!r.account || r.account === 'tuition')).reduce((a, r) => a + num(r.amount), 0);
    const outstanding = Math.max(0, billed - paidAll);

    // Engagement
    const tickets = (db.tickets || []).filter(r => inScope(r)).filter(r => r.status === 'open' || r.status === 'pending');

    // Exams in window
    const exams = (db.exams || []).filter(e => e && inWindow(e.date, start, end) && e.published !== false);

    // Grade distribution (current)
    const gRows = (db.grades || []).filter(r => inScope(r) && courseIds.has(String(r.courseId)));
    const gDist = {};
    gRows.forEach(g => { const k = g.grade || '—'; gDist[k] = (gDist[k] || 0) + 1; });

    return {
        studentsTotal: students.length,
        studentsActive: enrolled.length,
        newEnrollments: newThis.length,
        centers: centers.length,
        lessonsTotal, lessonsDone, coveragePct: pct(lessonsDone, lessonsTotal),
        perCourse, coursesTotal: perCourse.length,
        coursesFullyCovered, coursesCoveredByAll,
        attendanceTotal: att.length, attendancePresent: present, attendanceRate: pct(present, att.length),
        subsTotal: subs.length, avgScore, passRate: pct(pass, subs.length), passCount: pass, retakes,
        collected, tuitionCollected, gradCollected, billed, outstanding,
        collectionRate: pct(tuitionCollected, billed),
        ticketsOpen: tickets.length,
        exams: exams.map(e => ({ title: e.title || e.courseId, date: toDateOnly(e.date), time: e.time || '', venue: e.venue || '' })),
        gradeDist: gDist,
        students: students
    };
}

// ---------- previous period for growth ----------
function growthStats(db, scope, id, start, end, months) {
    const ps = shiftMonths(new Date(start + 'T00:00:00Z'), -months);
    const pe = shiftMonths(new Date(start + 'T00:00:00Z'), 0);
    const prevEnd = day(new Date(pe.getTime() - 86400000));
    const prev = computeStats(db, scope, id, day(ps), prevEnd);
    const cur = computeStats(db, scope, id, start, end);
    const growth = (a, b) => b > 0 ? Math.round((a - b) / b * 1000) / 10 : (a > 0 ? 100 : 0);
    return {
        prev: { newEnrollments: prev.newEnrollments, lessonsDone: prev.lessonsDone, attendanceRate: prev.attendanceRate, avgScore: prev.avgScore, collected: prev.collected, studentsActive: prev.studentsActive },
        enrollmentGrowth: growth(cur.newEnrollments, prev.newEnrollments),
        coverageGrowth: cur.lessonsDone - prev.lessonsDone,
        attendanceGrowth: Math.round((cur.attendanceRate - prev.attendanceRate) * 10) / 10,
        scoreGrowth: Math.round((cur.avgScore - prev.avgScore) * 10) / 10,
        collectionGrowth: growth(cur.collected, prev.collected)
    };
}

// ---------- narrative + recommendation engine (local "AI") ----------
function buildNarrative(st, scopeLabel, period, start, end) {
    const scopeKind = scopeLabel || 'the institution';
    const range = start + ' to ' + end;
    const summary =
        `This ${PERIOD_LABEL[period]} report covers ${scopeKind} for the period ${range}. ` +
        `The scope comprises ${st.studentsActive} active student(s) across ${st.centers} study center(s), with ${st.newEnrollments} new enrolment(s) recorded during the period. ` +
        `Learning coverage stands at ${st.coveragePct}% (${st.lessonsDone} of ${st.lessonsTotal} lessons completed), with ${st.coursesFullyCovered} of ${st.coursesTotal} course(s) fully covered. ` +
        `Attendance averaged ${st.attendanceRate}%, and ${st.passCount} assessment submission(s) were recorded with an average score of ${st.avgScore}% (pass rate ${st.passRate}%). ` +
        `Financially, ${money(st.collected)} was collected against ${money(st.billed)} billed, a collection rate of ${st.collectionRate}%, leaving ${money(st.outstanding)} outstanding. ` +
        (st.ticketsOpen ? `${st.ticketsOpen} support ticket(s) remain open and require attention.` : 'No open support tickets remain.');

    const strengths = [];
    const concerns = [];

    if (st.newEnrollments > 0) strengths.push(`Grew enrolment by ${st.newEnrollments} student(s) this period.`);
    if (st.coveragePct >= 70) strengths.push(`Strong lesson coverage of ${st.coveragePct}% — learners are progressing through the curriculum.`);
    else if (st.coveragePct >= 40) concerns.push(`Lesson coverage is moderate at ${st.coveragePct}%; ${st.lessonsTotal - st.lessonsDone} lesson(s) remain incomplete.`);
    else concerns.push(`Lesson coverage is low at ${st.coveragePct}%; ${st.lessonsTotal - st.lessonsDone} lesson(s) remain incomplete — a material risk to exam readiness.`);

    if (st.attendanceRate >= 80) strengths.push(`High attendance of ${st.attendanceRate}%.`);
    else if (st.attendanceRate >= 60) concerns.push(`Attendance is fair at ${st.attendanceRate}%; room to improve toward 80%.`);
    else if (st.attendanceTotal > 0) concerns.push(`Attendance is weak at ${st.attendanceRate}%; engagement interventions are needed.`);

    if (st.passRate >= 70) strengths.push(`Healthy pass rate of ${st.passRate}% (avg score ${st.avgScore}%).`);
    else if (st.passRate >= 50) concerns.push(`Pass rate is ${st.passRate}% (avg ${st.avgScore}%); some learners need academic support.`);
    else if (st.subsTotal > 0) concerns.push(`Pass rate is low at ${st.passRate}% (avg ${st.avgScore}%); academic support is required.`);

    if (st.collectionRate >= 80) strengths.push(`Strong fee collection at ${st.collectionRate}%.`);
    else if (st.collectionRate >= 60) concerns.push(`Fee collection is ${st.collectionRate}%; ${money(st.outstanding)} remains outstanding.`);
    else if (st.billed > 0) concerns.push(`Fee collection is weak at ${st.collectionRate}%; ${money(st.outstanding)} is outstanding.`);

    if (st.retakes > 0) concerns.push(`${st.retakes} retake request(s) were raised this period.`);
    if (st.ticketsOpen > 0) concerns.push(`${st.ticketsOpen} open support ticket(s) need resolution.`);

    if (!strengths.length) strengths.push('The institution is operational and reporting consistently.');
    if (!concerns.length) concerns.push('No critical concerns identified this period.');

    return { summary, strengths: strengths.slice(0, 5), concerns: concerns.slice(0, 5) };
}

function buildRecommendations(st) {
    const recs = [];
    if (st.coveragePct < 70) {
        recs.push({
            title: 'Close the lesson coverage gap',
            detail: `${st.coveragePct}% of lessons are complete. Focus on the lowest-coverage courses first to get learners exam-ready.`,
            timeline: '0–3 months', priority: 'High',
            steps: [
                'List the bottom five courses by coverage and assign a mentor to each.',
                'Set a weekly lesson-completion target per student and review progress every Friday.',
                'Flag any student with two or more incomplete lessons for a one-on-one follow-up.'
            ]
        });
    }
    if (st.attendanceRate < 80) {
        recs.push({
            title: 'Raise attendance toward 80%',
            detail: `Current attendance is ${st.attendanceRate}%. Consistent attendance is the single strongest predictor of coverage and pass rates.`,
            timeline: '0–3 months', priority: 'High',
            steps: [
                'Contact every student below 60% attendance with a personal call or message.',
                'Introduce an attendance register review at each centre, signed by the coordinator.',
                'Recognise the best-attending centre publicly at the next staff meeting.'
            ]
        });
    }
    if (st.passRate < 70) {
        recs.push({
            title: 'Improve assessment outcomes',
            detail: `Pass rate is ${st.passRate}% with an average score of ${st.avgScore}%.`,
            timeline: '3–6 months', priority: 'Medium',
            steps: [
                'Identify the three weakest topics across recent submissions and schedule revision sessions.',
                'Introduce a short practice quiz before each formal assessment.',
                'Pair each struggling learner with a peer who passed the same course.'
            ]
        });
    }
    if (st.collectionRate < 80) {
        recs.push({
            title: 'Strengthen fee collection',
            detail: `${money(st.outstanding)} is outstanding against ${money(st.billed)} billed (${st.collectionRate}% collected).`,
            timeline: '0–6 months', priority: 'Medium',
            steps: [
                'Send a personal reminder to every student with an outstanding balance.',
                'Offer a documented instalment plan for balances above a set threshold.',
                'Review collection performance per centre monthly and escalate chronic defaulters.'
            ]
        });
    }
    if (st.coursesTotal > 0 && st.coursesCoveredByAll < st.coursesTotal) {
        recs.push({
            title: 'Push remaining courses to full coverage',
            detail: `Only ${st.coursesCoveredByAll} of ${st.coursesTotal} course(s) are fully covered by every enrolled student.`,
            timeline: '6–12 months', priority: 'Medium',
            steps: [
                'Target one additional course per quarter until all are fully covered.',
                'Record the reason each remaining course lags (content, fees, attendance) and address it directly.'
            ]
        });
    }
    if (!recs.length) recs.push({
        title: 'Sustain current performance',
        detail: 'All key indicators are healthy. Maintain current practice and monitor quarterly.',
        timeline: 'Ongoing', priority: 'Low',
        steps: ['Continue current routines', 'Re-run this report quarterly to confirm trends hold']
    });
    return recs;
}

function buildSpecialNeeds(st) {
    const needs = [];
    if (st.attendanceRate < 60) needs.push({ need: 'Engagement support', adjustment: 'Flexible catch-up sessions and personal outreach for low-attendance learners.', timeline: '0–3 months' });
    if (st.passRate < 60) needs.push({ need: 'Academic support', adjustment: 'Targeted tutoring for weak topics before the next assessment cycle.', timeline: '3–6 months' });
    if (st.collectionRate < 60) needs.push({ need: 'Financial accessibility', adjustment: 'Bursaries, waivers or instalment plans for students who cannot pay.', timeline: '0–6 months' });
    if (st.ticketsOpen > 0) needs.push({ need: 'Support capacity', adjustment: `${st.ticketsOpen} open ticket(s) — assign an owner and resolution target to each.`, timeline: '0–1 month' });
    if (st.retakes > 0) needs.push({ need: 'Retake pathway', adjustment: 'Clear retake criteria and scheduled windows so learners can recover lost credits.', timeline: '1–2 months' });
    if (!needs.length) needs.push({ need: 'No special interventions required', adjustment: 'Maintain current support levels.', timeline: 'Ongoing' });
    return needs;
}

function analyzeVision(st, vision) {
    if (!vision || !String(vision).trim()) return null;
    const v = String(vision).toLowerCase();
    const detected = [];
    if (/expand|growth|new (centre|center|campus)|more (students|learners|enrol)/.test(v)) detected.push('expansion');
    if (/coverage|complete|finish|drip|lesson/.test(v)) detected.push('coverage');
    if (/quality|pass|grade|excellence|standard/.test(v)) detected.push('quality');
    if (/online|digital|portal|remote|hybrid/.test(v)) detected.push('digital delivery');
    if (/scholarship|bursar|free|aid|access|afford|waiver/.test(v)) detected.push('access & affordability');
    if (/sustain|fund|donor|self-sustain|income/.test(v)) detected.push('financial sustainability');
    if (/staff|train|capacity|teacher|mentor/.test(v)) detected.push('staff capacity');
    if (/certificate|diploma|graduat|completion rate/.test(v)) detected.push('completion & graduation');
    if (!detected.length) detected.push('overall improvement');

    const gaps = [];
    if (detected.includes('expansion') && st.studentsActive > 0) gaps.push({ goal: 'Expand reach', current: `${st.studentsActive} active students, ${st.centers} centre(s)`, gap: 'Growth requires additional centres, coordinators and enrolment drives.' });
    if (detected.includes('coverage')) gaps.push({ goal: 'Raise coverage', current: `${st.coveragePct}% lessons complete`, gap: `${st.lessonsTotal - st.lessonsDone} lessons incomplete across the scope.` });
    if (detected.includes('quality')) gaps.push({ goal: 'Improve quality', current: `${st.passRate}% pass rate, ${st.avgScore}% average`, gap: 'Academic support and revision are needed to lift outcomes.' });
    if (detected.includes('access & affordability')) gaps.push({ goal: 'Improve access', current: `${st.collectionRate}% collected, ${money(st.outstanding)} outstanding`, gap: 'Affordability barriers exist for a portion of learners.' });
    if (detected.includes('financial sustainability')) gaps.push({ goal: 'Build sustainability', current: `${money(st.collected)} collected / ${money(st.billed)} billed`, gap: 'Collections do not yet cover the full cost base.' });
    if (detected.includes('digital delivery')) gaps.push({ goal: 'Digitise delivery', current: `${st.subsTotal} submission(s) this period`, gap: 'Portal and online engagement are not yet the primary delivery channel.' });
    if (detected.includes('staff capacity')) gaps.push({ goal: 'Build staff capacity', current: `${st.centres || st.centers} centre(s) served`, gap: 'Trainer/mentor capacity constrains expansion and quality.' });
    if (detected.includes('completion & graduation')) gaps.push({ goal: 'Lift completion', current: `${st.coursesFullyCovered} of ${st.coursesTotal} courses fully covered`, gap: 'Learners are not yet finishing the full curriculum.' });

    const steps = [];
    if (detected.includes('coverage') || detected.includes('completion & graduation')) steps.push('Set a per-quarter coverage target and track it on the Coverage screen weekly.');
    if (detected.includes('quality')) steps.push('Introduce pre-assessment practice quizzes and revision sessions for weak topics.');
    if (detected.includes('access & affordability')) steps.push('Establish a documented bursary/waiver policy and instalment plans.');
    if (detected.includes('financial sustainability')) steps.push('Diversify income and improve collection to at least 80% to fund the vision.');
    if (detected.includes('expansion')) steps.push('Run a coordinated enrolment drive and assess new centre viability before opening.');
    if (detected.includes('digital delivery')) steps.push('Move enrolment, attendance and assessment workflows fully onto the portal.');
    if (detected.includes('staff capacity')) steps.push('Recruit and train one additional coordinator per centre.');
    if (!steps.length) steps.push('Re-run this report each quarter to measure progress against the vision.');

    return {
        vision: String(vision).trim(),
        directions: detected,
        gaps: gaps.slice(0, 6),
        steps: steps.slice(0, 6),
        timeline: '12–24 months'
    };
}

// ---------- public API ----------
function generateReport(db, params) {
    const scope = ['country', 'region', 'center'].includes(params.scope) ? params.scope : 'country';
    const scopeId = params.id != null && params.id !== '' ? String(params.id) : '';
    const period = PERIOD_MONTHS[params.period] ? params.period : 'annual';
    const end = toDateOnly(params.end) || day(new Date());
    const start = toDateOnly(params.start) || day(shiftMonths(new Date(end + 'T00:00:00Z'), -PERIOD_MONTHS[period]));

    const st = computeStats(db, scope, scopeId, start, end);
    const gr = growthStats(db, scope, scopeId, start, end, PERIOD_MONTHS[period]);
    const scopeName = scopeLabel(db, scope, scopeId) || (scope === 'center' ? 'All Centres' : scope === 'region' ? 'All Regions' : 'All Countries');
    const narrative = buildNarrative(st, scopeName, period, start, end);
    const recommendations = buildRecommendations(st);
    const specialNeeds = buildSpecialNeeds(st);
    const vision = analyzeVision(st, params.vision);

    return {
        meta: {
            scope, scopeId, scopeName,
            scopeType: scope === 'center' ? 'Study Center' : scope === 'region' ? 'Region' : 'Country',
            period, periodLabel: PERIOD_LABEL[period],
            start, end, generatedAt: new Date().toISOString()
        },
        growth: gr.prev ? {
            previous: gr.prev,
            enrollmentGrowthPct: gr.enrollmentGrowth,
            coverageGrowth: gr.coverageGrowth,
            attendanceGrowthPts: gr.attendanceGrowth,
            scoreGrowthPts: gr.scoreGrowth,
            collectionGrowthPct: gr.collectionGrowth
        } : null,
        stats: st,
        narrative,
        recommendations,
        vision,
        callToAction: `Act on the ${recommendations.length} recommendation(s) in this report: owners to be assigned within two weeks, first progress check at the next monthly report.`,
        donorNote: `This report demonstrates measurable progress in enrolment, coverage and learning outcomes. Continued donor and stakeholder support directly funds ${st.studentsActive} learner(s), keeps fees affordable, and sustains the centres that serve them. We invite partners to invest in the priorities identified above.`,
        specialNeeds
    };
}

module.exports = { generateReport, PERIOD_LABEL, PERIOD_MONTHS };
