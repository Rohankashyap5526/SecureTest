#!/usr/bin/env node
// Load / readiness test against a RUNNING SecureTest server (use a staging copy
// of your Supabase project, not the live exam database).
//
//   BASE_URL=https://your-app.onrender.com TEST_ID=TEST-123 COUNT=150 RAMP_MS=20000 npm run loadtest
//
// Every simulated candidate gets roll number SIM-<n> and mobile 90000000nn, goes
// through eligibility -> start -> autosave -> heartbeat -> submit. All 150 start
// inside RAMP_MS and submit at the end, which is the worst case for the system.
const { runStudent, percentile } = require('./student-sim');

const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const testId = process.env.TEST_ID;
const count = Number(process.env.COUNT) || 150;
const rampMs = Number(process.env.RAMP_MS) || 20000;
const offset = Number(process.env.ID_OFFSET) || 0;
if (!testId) { console.error('Set TEST_ID to an existing assessment id.'); process.exit(1); }

(async () => {
  console.log(`Simulating ${count} candidates against ${baseUrl} (ramp ${rampMs} ms)…`);
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: count }, (_, i) => runStudent({
    baseUrl, testId, id: offset + i + 1, jitterMs: rampMs,
    pick: (q) => (q.type === 'code_output' ? { value: '0' } : { value: Math.floor(Math.random() * q.options.length) })
  })));
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  console.log(`\nFinished in ${((Date.now() - started) / 1000).toFixed(1)} s: ${ok.length} ok, ${failed.length} failed`);
  for (const step of ['list', 'eligibility', 'start', 'autosave', 'heartbeat', 'submit']) {
    const ms = ok.map((r) => r.timings[step]).filter((x) => x !== undefined);
    if (ms.length) console.log(`${step.padEnd(12)} p50 ${percentile(ms, 50)} ms   p95 ${percentile(ms, 95)} ms   max ${Math.max(...ms)} ms`);
  }
  const reasons = {};
  failed.forEach((f) => { const k = `${f.step} ${f.status} ${f.error || ''}`; reasons[k] = (reasons[k] || 0) + 1; });
  if (failed.length) console.log('\nFailures:', reasons);
  console.log("\nClean up test data afterwards (SQL editor):\n  delete from attempts where student_id in (select id from students where roll_number like 'SIM-%');\n  delete from exam_sessions where roll_number like 'SIM-%';\n  delete from students where roll_number like 'SIM-%';");
  process.exit(failed.length ? 1 : 0);
})();
