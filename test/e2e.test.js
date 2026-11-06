const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server');
const { createFakeSupabase } = require('./fake-supabase');
const { runStudent, percentile, sleep } = require('../scripts/student-sim');

const QUESTION_ROWS = Array.from({ length: 12 }, (_, i) => i === 11
  ? { id: 'Q12', test_id: 'T1', question_order: 12, question_type: 'code_output', question_text: 'Output?', code_snippet: 'print(2+2)', expected_output: '4', marks: 2, options: [], correct_answer: null }
  : { id: 'Q' + (i + 1), test_id: 'T1', question_order: i + 1, question_type: 'mcq', question_text: 'Question ' + (i + 1),
      options: [`A${i}`, `B${i}`, `C${i}`, i === 5 ? 'All of the above' : `D${i}`], correct_answer: i % 4, marks: 1 });
const CORRECT_TEXT = new Map(QUESTION_ROWS.filter((q) => q.question_type === 'mcq').map((q) => [q.question_text, q.options[q.correct_answer]]));
const TOTAL_MARKS = 11 + 2;

async function boot() {
  const supabase = createFakeSupabase({
    tests: [{ id: 'T1', title: 'Sim Test', description: '', duration_minutes: 30, created_at: new Date().toISOString() }],
    questions: QUESTION_ROWS
  });
  const app = createApp({ supabase, env: { ADMIN_USER: 'a', ADMIN_PASSWORD: 'b', SESSION_SECRET: 's' } });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { supabase, app, server, baseUrl, close: () => new Promise((r) => server.close(r)) };
}

// A candidate answers question text -> correct option, but only 2 of every 3 questions.
const pickFor = (id) => (q, position) => {
  if ((position + id) % 3 === 0) return null;
  if (q.type === 'code_output') return { value: '4', correct: true, marks: 2 };
  const idx = q.options.indexOf(CORRECT_TEXT.get(q.question));
  return { value: idx, correct: true };
};

test('150 candidates start, answer and submit at the same time', async () => {
  const env = await boot();
  try {
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: 150 }, (_, i) => runStudent({
      baseUrl: env.baseUrl, testId: 'T1', id: i + 1, pick: pickFor(i + 1), jitterMs: 300
    })));
    const failed = results.filter((r) => !r.ok);
    assert.deepStrictEqual(failed, [], 'no candidate may fail');

    const attempts = env.supabase.tables.attempts;
    assert.strictEqual(attempts.length, 150);
    assert.strictEqual(new Set(attempts.map((a) => a.submission_id)).size, 150);
    assert.strictEqual(env.supabase.tables.exam_sessions.filter((s) => s.status === 'submitted').length, 150);
    assert.strictEqual(env.supabase.tables.answers.length, 150 * 12);

    // Shuffled screens must still be graded exactly as answered.
    results.forEach((r, i) => {
      const attempt = attempts.find((a) => a.submission_id === r.submissionId);
      assert.ok(attempt, 'attempt stored for ' + r.submissionId);
      assert.strictEqual(attempt.total_marks, TOTAL_MARKS);
      assert.strictEqual(attempt.correct, r.expectedCorrect, `candidate ${i + 1} correct count`);
      assert.strictEqual(attempt.wrong, 0);
    });
    const orders = new Set(env.supabase.tables.exam_sessions.map((s) => s.id));
    assert.strictEqual(orders.size, 150);

    const subs = results.map((r) => r.timings.submit);
    console.log(`  150 candidates done in ${Date.now() - t0} ms, DB queries: ${env.supabase.stats.queries}, submit p95 ${percentile(subs, 95)} ms`);
  } finally { await env.close(); }
});

test('questions are not exposed without a live session; lists carry no questions', async () => {
  const env = await boot();
  try {
    const list = await (await fetch(env.baseUrl + '/api/tests')).json();
    assert.strictEqual(list[0].questionCount, 12);
    assert.strictEqual(list[0].questions, undefined);
    const single = await (await fetch(env.baseUrl + '/api/tests/T1')).json();
    assert.strictEqual(single.questions, undefined);
    assert.strictEqual((await fetch(env.baseUrl + '/api/tests/T1/questions')).status, 403);
    assert.strictEqual((await fetch(env.baseUrl + '/api/tests/T1/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  } finally { await env.close(); }
});

async function startOne(env, id) {
  const student = { fullName: 'S' + id, collegeName: 'C', rollNumber: 'R' + id, mobileNumber: String(9100000000 + id), semester: '1', branch: 'b', course: 'c' };
  const res = await fetch(env.baseUrl + '/api/tests/T1/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ student, cameraReady: true, cameraConsent: true }) });
  const cookie = /securetest\.exam=([^;]*)/.exec(res.headers.getSetCookie().join(';'))[1];
  const data = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(env.baseUrl + path, { method, headers: { 'Content-Type': 'application/json', Cookie: 'securetest.exam=' + cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const row = () => env.supabase.tables.exam_sessions.find((s) => s.id === data.sessionId);
  return { data, call, row, student };
}

test('strikes: one physical action counts once, soft events never count, 3 strikes terminate', async () => {
  const env = await boot();
  try {
    const s = await startOne(env, 1);
    const ev = (eventType) => s.call('POST', '/api/proctoring/events', { eventType, detector: 'browser', confidence: 0.9 });

    let r = await ev('tab_hidden');
    assert.deepStrictEqual([r.data.accepted, r.data.violationCount], [true, 1]);
    r = await ev('window_blur'); // fired by the same Alt-Tab
    assert.deepStrictEqual([r.data.accepted, r.data.violationCount], [false, 1]);

    r = await ev('copy_attempt');
    assert.deepStrictEqual([r.data.accepted, r.data.counted, r.data.violationCount], [true, false, 1]);
    r = await ev('looking_away');
    assert.strictEqual(r.data.violationCount, 1);
    assert.strictEqual((await ev('nonsense')).status, 400);

    s.row().last_event_at = new Date(Date.now() - 6000).toISOString();
    r = await ev('phone_detected');
    assert.strictEqual(r.data.violationCount, 2);
    assert.strictEqual(r.data.terminated, false);

    s.row().last_event_at = new Date(Date.now() - 6000).toISOString();
    r = await ev('multiple_faces');
    assert.deepStrictEqual([r.data.violationCount, r.data.terminated], [3, true]);

    // After termination: autosave refused, but final submit is accepted and graded.
    assert.strictEqual((await s.call('POST', '/api/tests/T1/answers', { answers: [0] })).status, 403);
    r = await s.call('POST', '/api/tests/T1/submit', { answers: [0] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.terminated, true);
    assert.strictEqual(env.supabase.tables.attempts[0].violations, 3);
  } finally { await env.close(); }
});

test('submit is idempotent and survives retries', async () => {
  const env = await boot();
  try {
    const s = await startOne(env, 2);
    const a = await s.call('POST', '/api/tests/T1/submit', { answers: [] });
    const b = await s.call('POST', '/api/tests/T1/submit', { answers: [] });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    assert.strictEqual(a.data.submissionId, b.data.submissionId);
    assert.strictEqual(env.supabase.tables.attempts.length, 1);
  } finally { await env.close(); }
});

test('timer ends: late submit is graded from the last autosave, never lost', async () => {
  const env = await boot();
  try {
    const s = await startOne(env, 3);
    const q0 = s.data.questions[0];
    const goodIndex = q0.type === 'code_output' ? '4' : q0.options.indexOf(CORRECT_TEXT.get(q0.question));
    await s.call('POST', '/api/tests/T1/answers', { answers: [goodIndex] });
    // Timer ended 10 minutes ago (beyond the 90 s grace) and the student sends junk.
    s.row().expires_at = new Date(Date.now() - 600000).toISOString();
    const r = await s.call('POST', '/api/tests/T1/submit', { answers: new Array(12).fill(0) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.late, true);
    assert.strictEqual(env.supabase.tables.attempts[0].attempted, 1);
  } finally { await env.close(); }
});

test('submit within the grace window uses the candidate\'s final answers', async () => {
  const env = await boot();
  try {
    const s = await startOne(env, 4);
    s.row().expires_at = new Date(Date.now() - 5000).toISOString(); // 5 s late (network + clock skew)
    const r = await s.call('POST', '/api/tests/T1/submit', { answers: new Array(12).fill(0) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.late, false);
    assert.strictEqual(env.supabase.tables.attempts[0].attempted, 12);
  } finally { await env.close(); }
});

test('sweeper grades abandoned sessions from their autosave', async () => {
  const env = await boot();
  try {
    const abandoned = await startOne(env, 5);
    const fresh = await startOne(env, 6);
    await abandoned.call('POST', '/api/tests/T1/answers', { answers: [0, 1] });
    abandoned.row().expires_at = new Date(Date.now() - 600000).toISOString();
    const out = await env.app.locals.sweepOnce();
    assert.strictEqual(out.finalized, 1);
    assert.strictEqual(env.supabase.tables.attempts.length, 1);
    assert.strictEqual(abandoned.row().status, 'submitted');
    assert.strictEqual(fresh.row().status, 'active'); // untouched
    assert.strictEqual((await env.app.locals.sweepOnce()).finalized, 0);
  } finally { await env.close(); }
});

test('heartbeat reports termination/expiry; lost cookie needs invigilator "allow resume"', async () => {
  const env = await boot();
  try {
    const s = await startOne(env, 7);
    let r = await s.call('POST', '/api/proctoring/heartbeat', { state: { camera: true, models: true } });
    assert.strictEqual(r.data.status, 'active');
    assert.ok(r.data.serverTime && r.data.expiresAt);

    // Same student, no cookie (other browser): refused...
    const retry = await fetch(env.baseUrl + '/api/tests/T1/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ student: s.student, cameraReady: true, cameraConsent: true }) });
    assert.strictEqual(retry.status, 409);

    // ...until an admin allows it.
    const login = await fetch(env.baseUrl + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' }) });
    assert.strictEqual(login.status, 200);
    const adminCookie = login.headers.getSetCookie()[0].split(';')[0];
    const admin = (method, path) => fetch(env.baseUrl + path, { method, headers: { Cookie: adminCookie } }).then(async (x) => ({ status: x.status, data: await x.json() }));
    const live = await admin('GET', '/api/admin/proctoring/live');
    assert.strictEqual(live.data.sessions.length, 1);
    assert.strictEqual(live.data.sessions[0].clientState.camera, true);
    assert.strictEqual((await admin('POST', `/api/admin/proctoring/sessions/${s.data.sessionId}/allow-resume`)).status, 200);

    const again = await fetch(env.baseUrl + '/api/tests/T1/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ student: s.student, cameraReady: true, cameraConsent: true }) });
    assert.strictEqual(again.status, 200);
    const body = await again.json();
    assert.strictEqual(body.resumed, true);
    assert.strictEqual(body.questions.length, 12);
    assert.deepStrictEqual(body.questions.map((q) => q.id), s.data.questions.map((q) => q.id)); // same layout on resume
    assert.strictEqual(s.row().reissue_allowed, false);
    assert.strictEqual((await fetch(env.baseUrl + '/api/admin/proctoring/live')).status, 401);

    // Editing a test while candidates are sitting it is blocked.
    const edit = await fetch(env.baseUrl + '/api/admin/tests', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify({ id: 'T1', title: 'x', questions: [{ type: 'mcq', question: 'q', options: ['a', 'b'], answer: 0 }] }) });
    assert.strictEqual(edit.status, 409);
  } finally { await env.close(); }
});
