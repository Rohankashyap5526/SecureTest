// Starts the real app on a fake in-memory database (for browser tests / manual demos).
//   PORT=3100 node test/serve-fake.js
const { createApp } = require('../server');
const { createFakeSupabase } = require('./fake-supabase');
const rows = Array.from({ length: 3 }, (_, i) => ({
  id: 'Q' + (i + 1), test_id: 'T1', question_order: i + 1, question_type: 'mcq', question_text: 'Question ' + (i + 1),
  options: ['A', 'B', 'C', 'D'], correct_answer: i, marks: 1
}));
const supabase = createFakeSupabase({
  tests: [{ id: 'T1', title: 'Browser Test', description: 'demo', duration_minutes: 20, created_at: new Date().toISOString() }],
  questions: rows
});
const app = createApp({ supabase, env: { ADMIN_USER: 'a', ADMIN_PASSWORD: 'b', SESSION_SECRET: 's' } });
const outer = require('express')();
outer.get('/__debug/state', (req, res) => res.json({
  sessions: supabase.tables.exam_sessions, events: supabase.tables.proctoring_events, attempts: supabase.tables.attempts
}));
outer.use(app);
outer.listen(Number(process.env.PORT) || 3100, () => console.log('fake server ready'));
