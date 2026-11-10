const E = require('./drip-engine');

function makeDb(over = {}) {
  return Object.assign({
    settings: [{ key: 'lessonPacing', value: { default: { value: 0, unit: 'days' } } }],
    students: [{ id: 'S1', name: 'Learner', status: 'active' }],
    alumni: [], courses: [], enrollments: [], lessons: [], notes: [],
    lessonCompletions: [], lessonUnlocks: [], submissions: [], grades: [],
    quizzes: [], exams: [], questionBank: [], payments: [], waivers: [], feeAgreements: []
  }, over);
}
// A course with an instant pace so the chain is not held back by pacing.
function fastCourse(id = 'C1') {
  return { id, name: 'Course', dripDaysBetween: 0 };
}
function lesson(id, order, extra = {}) {
  return Object.assign({ id, courseId: 'C1', order, title: 'Lesson ' + order, releaseMode: 'drip', published: true }, extra);
}
function comp(sid, lid, extra = {}) {
  return Object.assign({ id: 'LC-' + sid + '-' + lid, studentId: sid, lessonId: lid, courseId: 'C1', readSecs: 0, requiredSecs: 0 }, extra);
}
function unlock(sid, lid) {
  return { id: 'LU-' + sid + '-' + lid, studentId: sid, lessonId: lid, courseId: 'C1', unlockedAt: new Date().toISOString(), by: 'drip' };
}

let fails = 0;
function ok(label, cond, extra) {
  if (cond) console.log('  PASS  ' + label);
  else { fails++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

// ---------- 1. chain advances one step at a time ----------
console.log('\n1) chain advances one step at a time');
{
  const db = makeDb({
    courses: [fastCourse()],
    lessons: [lesson('L1', 1), lesson('L2', 2), lesson('L3', 3)],
    notes: [{ id: 'N1', lessonId: 'L1', content: 'Some notes for lesson one' }],
  });
  E.dripSweep(db, 'S1', 'C1');
  ok('first lesson unlocked', db.lessonUnlocks.length === 1 && db.lessonUnlocks[0].lessonId === 'L1', db.lessonUnlocks);

  // Learner reads L1 -> L1 completes, L2 opens
  db.lessonCompletions.push(comp('S1', 'L1', { readSecs: 999, requiredSecs: 15, readDoneAt: new Date().toISOString(), completedAt: new Date().toISOString() }));
  E.dripSweep(db, 'S1', 'C1');
  ok('L2 opens only after L1 is finished', db.lessonUnlocks.some(u => u.lessonId === 'L2') && !db.lessonUnlocks.some(u => u.lessonId === 'L3'), db.lessonUnlocks.map(u => u.lessonId));
}

// ---------- 2. no skipping: a stale unlock must not open a later lesson ----------
console.log('\n2) stale unlock / gap does not let the chain skip ahead');
{
  const db = makeDb({
    courses: [fastCourse()],
    lessons: [lesson('L1', 1), lesson('L2', 2), lesson('L3', 3)],
    notes: [{ id: 'N1', lessonId: 'L1', content: 'notes' }],
    // L2 was unlocked before but never finished (the residue case)
    lessonUnlocks: [unlock('S1', 'L1'), unlock('S1', 'L2')],
    lessonCompletions: [comp('S1', 'L1', { readSecs: 999, requiredSecs: 15, readDoneAt: new Date().toISOString(), completedAt: new Date().toISOString() })],
  });
  E.dripSweep(db, 'S1', 'C1');
  ok('L3 stays locked while L2 is unfinished', !db.lessonUnlocks.some(u => u.lessonId === 'L3'), db.lessonUnlocks.map(u => u.lessonId));

  // now L2 finishes -> L3 opens
  db.lessonCompletions.push(comp('S1', 'L2', { readSecs: 999, requiredSecs: 15, readDoneAt: new Date().toISOString(), completedAt: new Date().toISOString() }));
  E.dripSweep(db, 'S1', 'C1');
  ok('L3 opens once L2 is finished', db.lessonUnlocks.some(u => u.lessonId === 'L3'), db.lessonUnlocks.map(u => u.lessonId));
}

// ---------- 3. lesson media gate (notes -> video -> quiz) ----------
console.log('\n3) lesson quiz waits for notes + video');
{
  const db = makeDb({
    courses: [fastCourse()],
    lessons: [lesson('L1', 1, { videos: [{ id: 'V1', title: 'Video 1', url: 'https://example.com/a.mp4', required: true }] })],
    notes: [{ id: 'N1', lessonId: 'L1', content: 'notes content here' }],
  });
  ok('no completion -> media not done', E.dripLessonMediaDone(db, 'S1', db.lessons[0]) === false);
  db.lessonCompletions.push(comp('S1', 'L1', { readSecs: 999, requiredSecs: 15, readDoneAt: new Date().toISOString() }));
  ok('notes read but video not watched -> still not done', E.dripLessonMediaDone(db, 'S1', db.lessons[0]) === false);
  db.lessonCompletions[0].videoProgress = { V1: { secs: 100, durationSecs: 100, doneAt: new Date().toISOString() } };
  ok('notes + video watched -> done', E.dripLessonMediaDone(db, 'S1', db.lessons[0]) === true);
}

// ---------- 4. a lesson with no content never blocks its quiz ----------
console.log('\n4) empty lesson never blocks');
{
  const db = makeDb({ courses: [{ id: 'C1' }], lessons: [lesson('L1', 1)], notes: [] });
  ok('empty lesson -> media considered done', E.dripLessonMediaDone(db, 'S1', db.lessons[0]) === true);
}

// ---------- 5. course step: only the first unfinished lesson is current ----------
console.log('\n5) course step states');
{
  const db = makeDb({
    courses: [fastCourse()],
    lessons: [lesson('L1', 1), lesson('L2', 2), lesson('L3', 3)],
    lessonUnlocks: [unlock('S1', 'L1'), unlock('S1', 'L2'), unlock('S1', 'L3')],
    lessonCompletions: [
      comp('S1', 'L1', { completedAt: new Date().toISOString() }),
      comp('S1', 'L3', { completedAt: new Date().toISOString() })
    ],
  });
  const st = E.dripCourseStep(db, 'S1', 'C1');
  ok('L1 done', st.states.L1 === 'done', st.states);
  ok('L2 is the current step', st.states.L2 === 'current', st.states);
  ok('current id points at L2', st.currentId === 'L2', st.currentId);
  ok('L3 marked done (completed work is never hidden)', st.states.L3 === 'done', st.states);
}

// ---------- 6. non-drip lessons are never gated ----------
console.log('\n6) immediate lessons are not drip-gated');
{
  const db = makeDb({
    courses: [fastCourse()],
    lessons: [lesson('L1', 1, { releaseMode: 'immediate' }), lesson('L2', 2)],
    notes: [{ id: 'N1', lessonId: 'L1', content: 'notes' }],
  });
  ok('immediate lesson -> media done', E.dripLessonMediaDone(db, 'S1', db.lessons[0]) === true);
}

// ---------- 7. deleted lessons never satisfy the chain ----------
console.log('\n7) orphan completion rows do not open a later lesson');
{
  const db = makeDb({
    courses: [fastCourse()],
    lessons: [lesson('L1', 1), lesson('L2', 2)],
    notes: [{ id: 'N1', lessonId: 'L1', content: 'notes' }],
    lessonUnlocks: [unlock('S1', 'L1'), unlock('S1', 'DELETED')],
    lessonCompletions: [comp('S1', 'DELETED', { completedAt: new Date().toISOString() })],
  });
  E.dripSweep(db, 'S1', 'C1');
  ok('L2 stays locked (the completed lesson no longer exists)', !db.lessonUnlocks.some(u => u.lessonId === 'L2'), db.lessonUnlocks.map(u => u.lessonId));
}

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL TESTS PASSED'));
process.exit(fails ? 1 : 0);
