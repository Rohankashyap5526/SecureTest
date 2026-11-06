// Simulated candidate used by the local 150-student test and by scripts/load-test.js.
// It talks to the real HTTP API exactly like the browser does.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(baseUrl) {
  let token = '';
  return async function call(method, path, body) {
    const started = Date.now();
    const res = await fetch(baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: 'securetest.exam=' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of setCookie) {
      const m = /^securetest\.exam=([^;]*)/.exec(c);
      if (m) token = decodeURIComponent(m[1]);
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, ok: res.ok, data, ms: Date.now() - started };
  };
}

// pick(question, position) -> answer in displayed form (option index or text) or null
async function runStudent({ baseUrl, testId, id, pick, jitterMs = 0, misbehave = null }) {
  const call = makeClient(baseUrl);
  const timings = {};
  const fail = (step, r) => ({ ok: false, step, status: r.status, error: r.data?.error });
  const run = async (step, fn) => { const r = await fn(); timings[step] = r.ms; return r; };
  if (jitterMs) await sleep(Math.random() * jitterMs);

  const student = {
    fullName: `Load Student ${id}`, collegeName: 'Sim College', rollNumber: `SIM-${id}`,
    mobileNumber: String(9000000000 + Number(id)), semester: '6', branch: 'CSE', course: 'BTech'
  };

  let r = await run('list', () => call('GET', '/api/tests'));
  if (!r.ok) return fail('list', r);
  r = await run('eligibility', () => call('POST', `/api/tests/${testId}/check-eligibility`, student));
  if (!r.ok) return fail('eligibility', r);
  r = await run('start', () => call('POST', `/api/tests/${testId}/start`, { student, cameraReady: true, cameraConsent: true, snapshotConsent: false }));
  if (!r.ok) return fail('start', r);

  const questions = r.data.questions;
  const answers = new Array(questions.length).fill(null);
  let expectedCorrect = 0;
  for (let i = 0; i < questions.length; i += 1) {
    const choice = pick(questions[i], i);
    if (choice !== null && choice !== undefined) answers[i] = choice.value;
    if (choice && choice.correct) expectedCorrect += 1;
    if (i % 4 === 3) {
      r = await run('autosave', () => call('POST', `/api/tests/${testId}/answers`, { answers }));
      if (!r.ok && r.status !== 429) return fail('autosave', r);
      await sleep(320); // server enforces >=300 ms between saves per candidate
    }
  }
  r = await run('heartbeat', () => call('POST', '/api/proctoring/heartbeat', { state: { camera: true, models: true, fullscreen: true, visible: true, monitors: false, faults: 0 } }));
  if (!r.ok) return fail('heartbeat', r);

  let eventResult = null;
  if (misbehave) {
    eventResult = await run('event', () => call('POST', '/api/proctoring/events', misbehave));
    if (!eventResult.ok) return fail('event', eventResult);
  }

  // The browser retries submit on transient errors; do the same.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    r = await run('submit', () => call('POST', `/api/tests/${testId}/submit`, { answers }));
    if (r.ok) break;
    if (r.status && r.status < 500 && r.status !== 429) return fail('submit', r);
    await sleep(300 * 2 ** attempt);
  }
  if (!r.ok) return fail('submit', r);
  return { ok: true, submissionId: r.data.submissionId, expectedCorrect, event: eventResult?.data, timings, totalMs: Object.values(timings).reduce((a, b) => a + b, 0) };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

module.exports = { runStudent, percentile, sleep };
