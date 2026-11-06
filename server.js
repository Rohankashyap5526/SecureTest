const express = require('express');
const session = require('express-session');
const compression = require('compression');
const crypto = require('crypto');
const XLSX = require('xlsx');
const path = require('path');
const mountProctoring = require('./proctoring-server');
const { TtlCache } = require('./lib/ttl-cache');

function normalizeRollNumber(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function cleanQuestion(question, index) {
  const type = question?.type === 'code_output' ? 'code_output' : 'mcq';
  const questionText = String(question?.question || '').trim();
  if (!questionText) throw new Error(`Question ${index + 1} cannot be empty`);

  if (type === 'code_output') {
    const codeSnippet = String(question?.codeSnippet || '').trim();
    const expectedOutput = String(question?.expectedOutput || '').trim();
    if (!codeSnippet || !expectedOutput) throw new Error(`Code and expected output are required for question ${index + 1}`);
    return { type, question: questionText, codeSnippet, expectedOutput, marks: Number(question?.marks) || 1 };
  }

  const options = Array.isArray(question?.options) ? question.options.map((x) => String(x).trim()) : [];
  const answer = Number(question?.answer);
  if (options.length < 2 || options.some((x) => !x)) throw new Error(`Invalid options for question ${index + 1}`);
  if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) throw new Error(`Invalid answer for question ${index + 1}`);
  return { type: 'mcq', question: questionText, options, answer, marks: Number(question?.marks) || 1 };
}

function mapQuestionRow(q) {
  return q.question_type === 'code_output'
    ? { id: q.id, type: 'code_output', question: q.question_text, codeSnippet: q.code_snippet || '', expectedOutput: q.expected_output || '', marks: Number(q.marks) || 1 }
    : { id: q.id, type: 'mcq', question: q.question_text, options: Array.isArray(q.options) ? q.options : [], answer: Number(q.correct_answer), marks: Number(q.marks) || 1 };
}

// Student-facing list: metadata only. Questions are delivered per exam session.
function publicSummary(bundle) {
  const { row, questions } = bundle;
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    durationMinutes: row.duration_minutes,
    questionCount: questions.length,
    format: questions.some((q) => q.type === 'code_output') ? 'MCQ + Code' : 'MCQ'
  };
}

function adminTest(row, questions) {
  return {
    id: row.id, title: row.title, description: row.description || '',
    durationMinutes: row.duration_minutes, questions: questions || [],
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function createApp({ supabase, env = process.env, sessionStore = null, startSweeper = false }) {
  const app = express();
  const isProd = env.NODE_ENV === 'production';

  if (isProd && (!env.SESSION_SECRET || !env.ADMIN_PASSWORD)) {
    throw new Error('SESSION_SECRET and ADMIN_PASSWORD must be set when NODE_ENV=production.');
  }

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(compression());
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  const sessionOptions = {
    name: 'securetest.sid',
    secret: env.SESSION_SECRET || 'CHANGE-ME-IN-PRODUCTION',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 8 * 60 * 60 * 1000 }
  };
  if (sessionStore) sessionOptions.store = sessionStore;
  app.use(session(sessionOptions));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '10m' }));

  function requireAdmin(req, res, next) {
    if (req.session?.admin === true) return next();
    return res.status(401).json({ error: 'Admin authentication required' });
  }

  // ---- test / question cache (single-flight, 60 s, cleared on every admin write) ----
  const cache = new TtlCache(60000);
  const loadBundles = async () => {
    const { data: tests, error } = await supabase.from('tests').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    if (!tests || !tests.length) return [];
    const { data: qs, error: qError } = await supabase.from('questions').select('*').in('test_id', tests.map((t) => t.id)).order('question_order', { ascending: true });
    if (qError) throw qError;
    const grouped = new Map(tests.map((t) => [t.id, []]));
    (qs || []).forEach((q) => grouped.get(q.test_id)?.push(mapQuestionRow(q)));
    return tests.map((row) => ({ row, questions: grouped.get(row.id) || [] }));
  };
  const getAllBundles = () => cache.get('all', loadBundles);
  const getBundle = async (id) => (await getAllBundles()).find((b) => b.row.id === String(id)) || null;
  const getTest = async (id) => (await getBundle(id))?.row || null;

  const proctoring = mountProctoring(app, {
    supabase, getBundle, normalizeRollNumber, requireAdmin,
    shuffle: env.SHUFFLE_QUESTIONS !== 'false',
    maxViolations: Number(env.MAX_VIOLATIONS) || 3
  });
  if (startSweeper) proctoring.startSweeper(30000);

  // ------------------------- Admin auth -------------------------
  const loginAttempts = new Map();
  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  app.post('/api/admin/login', (req, res) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = loginAttempts.get(key);
    if (entry && entry.resetAt > now && entry.count >= 8) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    const username = String(req.body?.username || '');
    const password = String(req.body?.password || '');
    const expectedUser = env.ADMIN_USER || 'admin';
    const expectedPassword = env.ADMIN_PASSWORD || 'Admin@12345';
    const ok = crypto.timingSafeEqual(digest(username), digest(expectedUser)) && crypto.timingSafeEqual(digest(password), digest(expectedPassword));
    if (!ok) {
      const fresh = entry && entry.resetAt > now ? entry : { count: 0, resetAt: now + 15 * 60 * 1000 };
      fresh.count += 1;
      loginAttempts.set(key, fresh);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    loginAttempts.delete(key);
    req.session.admin = true;
    req.session.loginAt = new Date().toISOString();
    req.session.save((error) => {
      if (error) return res.status(500).json({ error: 'Could not create admin session' });
      return res.json({ ok: true });
    });
  });

  app.get('/api/admin/session', (req, res) => res.json({ authenticated: req.session?.admin === true }));

  app.post('/api/admin/logout', requireAdmin, (req, res) => {
    req.session.destroy((error) => {
      if (error) return res.status(500).json({ error: 'Could not log out' });
      res.clearCookie('securetest.sid');
      return res.json({ ok: true });
    });
  });

  // ------------------------- Admin tests -------------------------
  app.get('/api/admin/tests', requireAdmin, async (req, res) => {
    try {
      cache.invalidateAll(); // admin always sees fresh data
      return res.json((await getAllBundles()).map((x) => adminTest(x.row, x.questions)));
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Could not load assessments' });
    }
  });

  app.post('/api/admin/tests', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const title = String(body.title || '').trim();
      if (!title) return res.status(400).json({ error: 'Test title is required' });
      if (!Array.isArray(body.questions) || body.questions.length === 0) return res.status(400).json({ error: 'At least one question is required' });

      const questions = body.questions.map(cleanQuestion);
      const id = String(body.id || `TEST-${Date.now()}`).trim();

      // Question ids change on every save; saving mid-exam would corrupt live candidates' answers.
      const { data: live, error: liveError } = await supabase.from('exam_sessions').select('id').eq('test_id', id).eq('status', 'active').limit(1);
      if (liveError) throw liveError;
      if (live && live.length) return res.status(409).json({ error: 'Candidates are currently sitting this assessment. Edit it after they finish.' });

      const now = new Date().toISOString();
      const payload = { id, title, description: String(body.description || '').trim(), duration_minutes: Math.max(1, Number(body.durationMinutes) || 10), updated_at: now };
      const { data: existing, error: existingError } = await supabase.from('tests').select('id').eq('id', id).maybeSingle();
      if (existingError) throw existingError;
      if (!existing) payload.created_at = now;

      const { data, error } = await supabase.from('tests').upsert(payload, { onConflict: 'id' }).select('*').single();
      if (error) throw error;

      const { error: deleteError } = await supabase.from('questions').delete().eq('test_id', id);
      if (deleteError) throw deleteError;
      const questionRows = questions.map((q, index) => ({
        id: `Q-${id}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        test_id: id,
        question_order: index + 1,
        question_type: q.type,
        question_text: q.question,
        options: q.type === 'mcq' ? q.options : [],
        correct_answer: q.type === 'mcq' ? q.answer : null,
        code_snippet: q.type === 'code_output' ? q.codeSnippet : null,
        expected_output: q.type === 'code_output' ? q.expectedOutput : null,
        marks: q.marks || 1
      }));
      const { error: insertError } = await supabase.from('questions').insert(questionRows);
      if (insertError) throw insertError;

      cache.invalidateAll();
      const saved = await getBundle(id);
      return res.json(adminTest(data, saved?.questions || []));
    } catch (error) {
      console.error(error);
      cache.invalidateAll();
      return res.status(400).json({ error: error.message || 'Could not save assessment' });
    }
  });

  app.delete('/api/admin/tests/:id', requireAdmin, async (req, res) => {
    try {
      const { error } = await supabase.from('tests').delete().eq('id', req.params.id);
      if (error) {
        if (error.code === '23503') return res.status(409).json({ error: 'This assessment has student attempts and cannot be deleted.' });
        throw error;
      }
      cache.invalidateAll();
      return res.json({ ok: true });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Could not delete assessment' });
    }
  });

// ------------------------- Admin results -------------------------
async function getAdminResults() {
  const { data, error } = await supabase.from('attempts')
    .select('*, students(id,full_name,college_name,roll_number,mobile_number,semester,branch,course), tests(id,title)')
    .order('submitted_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(a => ({
    Submission_ID: a.submission_id,
    Submitted_At: a.submitted_at,
    Started_At: a.started_at,
    Test_ID: a.test_id,
    Test_Name: a.tests?.title || '',
    Student_ID: a.student_id,
    Full_Name: a.students?.full_name || '',
    College_Name: a.students?.college_name || '',
    Roll_Number: a.students?.roll_number || '',
    Mobile_Number: a.students?.mobile_number || '',
    Semester: a.students?.semester || '',
    Branch: a.students?.branch || '',
    Course: a.students?.course || '',
    Total_Questions: a.total_questions,
    Attempted: a.attempted,
    Correct: a.correct,
    Wrong: a.wrong,
    Marks: Number(a.marks),
    Total_Marks: Number(a.total_marks),
    Percentage: Number(a.percentage),
    Violations: a.violations
  }));
}

app.get('/api/admin/results', requireAdmin, async (req, res) => {
  try { return res.json(await getAdminResults()); }
  catch (error) { console.error(error); return res.status(500).json({ error: 'Could not load results' }); }
});

app.get('/api/admin/results.xlsx', requireAdmin, async (req, res) => {
  try {
    const rows = await getAdminResults();
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Student Results');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="student-results.xlsx"');
    return res.send(buffer);
  } catch (error) { console.error(error); return res.status(500).json({ error: 'Could not generate Excel report' }); }
});

app.delete('/api/admin/student-data', requireAdmin, async (req, res) => {
  try {
    // PostgREST intentionally rejects an unfiltered DELETE ("DELETE requires a
    // WHERE clause"). Use explicit, always-true filters so the server can
    // safely clear each table in the required child-to-parent order.
    // This route is protected by requireAdmin and uses the server-side key.
    const UUID_SENTINEL = '00000000-0000-0000-0000-000000000000';

    const { data: answerRows, error: answerError } = await supabase
      .from('answers')
      .delete()
      .neq('id', UUID_SENTINEL)
      .select('id');
    if (answerError) throw answerError;

    const { data: attemptRows, error: attemptError } = await supabase
      .from('attempts')
      .delete()
      .neq('id', UUID_SENTINEL)
      .select('id');
    if (attemptError) throw attemptError;

    const { data: studentRows, error: studentError } = await supabase
      .from('students')
      .delete()
      .neq('id', UUID_SENTINEL)
      .select('id');
    if (studentError) throw studentError;

    return res.json({
      ok: true,
      deletedStudents: studentRows?.length || 0,
      deletedAttempts: attemptRows?.length || 0,
      deletedAnswers: answerRows?.length || 0
    });
  } catch (error) {
    console.error('Student data delete failed:', error);
    return res.status(500).json({
      error: 'Could not delete student data. No assessments or questions were deleted.',
      details: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
});

// ------------------------- Student APIs -------------------------
  app.get('/api/tests', async (req, res) => {
    try { return res.json((await getAllBundles()).map(publicSummary)); }
    catch (error) { console.error(error); return res.status(500).json({ error: 'Could not load assessments' }); }
  });

  app.get('/api/tests/:id', async (req, res) => {
    try {
      const bundle = await getBundle(req.params.id);
      if (!bundle) return res.status(404).json({ error: 'Test not found' });
      return res.json(publicSummary(bundle));
    } catch (error) { console.error(error); return res.status(500).json({ error: 'Could not load assessment' }); }
  });

  app.post('/api/tests/:id/check-eligibility', async (req, res) => {
    try {
      const test = await getTest(req.params.id);
      if (!test) return res.status(404).json({ error: 'Test not found' });
      const rollNumber = normalizeRollNumber(req.body?.rollNumber);
      const mobileNumber = String(req.body?.mobileNumber || '').replace(/\D/g, '');
      if (!rollNumber) return res.status(400).json({ error: 'University / College Roll No. is required' });
      if (!/^\d{10}$/.test(mobileNumber)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
      const { data: phoneOwner, error: phoneError } = await supabase.from('students').select('id,roll_number').eq('mobile_number', mobileNumber).maybeSingle();
      if (phoneError) throw phoneError;
      if (phoneOwner && phoneOwner.roll_number !== rollNumber) {
        return res.status(409).json({ error: 'This mobile number is already registered with another roll number.' });
      }
      const { data: student, error: studentError } = await supabase.from('students').select('id').eq('roll_number', rollNumber).maybeSingle();
      if (studentError) throw studentError;
      if (student) {
        const { data: attempt, error: attemptError } = await supabase.from('attempts').select('id').eq('test_id', test.id).eq('student_id', student.id).maybeSingle();
        if (attemptError) throw attemptError;
        if (attempt) return res.status(409).json({ error: 'This roll number has already attempted this assessment.' });
      }
      return res.json({ eligible: true });
    } catch (error) { console.error(error); return res.status(500).json({ error: 'Could not verify eligibility' }); }
  });

  // start / questions / answers / heartbeat / events / submit live in proctoring-server.js

  app.get('/api/health', async (req, res) => {
    try { const { error } = await supabase.from('tests').select('id').limit(1); if (error) throw error; return res.json({ ok: true, database: 'supabase' }); }
    catch { return res.status(503).json({ ok: false, database: 'unavailable' }); }
  });

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.locals.sweepOnce = proctoring.sweepOnce;
  return app;
}

module.exports = { createApp, normalizeRollNumber };

if (require.main === module) {
  const { createClient } = require('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('\nSecureTest cannot start: missing SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).\n');
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  let sessionStore = null;
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pgSession = require('connect-pg-simple')(require('express-session'));
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 });
    sessionStore = new pgSession({ pool, createTableIfMissing: true });
  } else {
    console.warn('Warning: DATABASE_URL not set; using MemoryStore for admin sessions. Add DATABASE_URL for production.');
  }

  let app;
  try { app = createApp({ supabase, sessionStore, startSweeper: true }); }
  catch (error) { console.error('\n' + error.message + '\n'); process.exit(1); }

  const PORT = Number(process.env.PORT) || 3000;
  const server = app.listen(PORT, () => console.log(`SecureTest: http://localhost:${PORT}`));
  // Stay above typical proxy idle timeouts so reused connections are not reset mid-burst.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
}
