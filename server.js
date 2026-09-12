const express = require('express');
const session = require('express-session');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
// Prefer the modern Supabase server-side Secret key. Keep the legacy
// service_role variable supported for existing Render deployments.
const SUPABASE_KEY = String(
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''
).trim();

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('\nSecureTest cannot start: missing SUPABASE_URL and/or SUPABASE_SECRET_KEY.');
  console.error('For existing deployments, SUPABASE_SERVICE_ROLE_KEY is also supported.\n');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

app.disable('x-powered-by');
// Render terminates HTTPS at its proxy. Trusting the proxy is required so
// express-session can correctly set Secure cookies on the public HTTPS URL.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
const sessionOptions = {
  name: 'securetest.sid',
  secret: process.env.SESSION_SECRET || 'CHANGE-ME-IN-PRODUCTION',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
};

// On Render, use PostgreSQL-backed sessions when DATABASE_URL is configured.
// This removes the production MemoryStore warning and survives restarts.
if (process.env.DATABASE_URL) {
  const sessionPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5
  });
  sessionOptions.store = new PgSession({
    pool: sessionPool,
    tableName: 'securetest_sessions',
    createTableIfMissing: true
  });
} else if (process.env.NODE_ENV === 'production') {
  console.warn('WARNING: DATABASE_URL is not set; admin sessions use in-memory storage. Configure DATABASE_URL for persistent production sessions.');
}

app.use(session(sessionOptions));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (req.session?.admin === true) return next();
  return res.status(401).json({ error: 'Admin authentication required' });
}

function normalizeRollNumber(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function normalizeOutput(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .replace(/[ \t]+/g, ' ');
}

function isAnswered(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function cleanQuestion(question, index) {
  const type = question?.type === 'code_output' ? 'code_output' : 'mcq';
  const questionText = String(question?.question || '').trim();
  if (!questionText) throw new Error(`Question ${index + 1} cannot be empty`);

  if (type === 'code_output') {
    const codeSnippet = String(question?.codeSnippet || '').trim();
    const expectedOutput = String(question?.expectedOutput || '').trim();
    if (!codeSnippet || !expectedOutput) {
      throw new Error(`Code and expected output are required for question ${index + 1}`);
    }
    return { type, question: questionText, codeSnippet, expectedOutput };
  }

  const options = Array.isArray(question?.options)
    ? question.options.map((x) => String(x).trim())
    : [];
  const answer = Number(question?.answer);
  if (options.length < 2 || options.some((x) => !x)) {
    throw new Error(`Invalid options for question ${index + 1}`);
  }
  if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) {
    throw new Error(`Invalid answer for question ${index + 1}`);
  }
  return { type: 'mcq', question: questionText, options, answer };
}

function publicTest(row) {
  const questions = Array.isArray(row.questions) ? row.questions : [];
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    durationMinutes: row.duration_minutes,
    questions: questions.map((q) => {
      const result = {
        type: q.type || 'mcq',
        question: q.question
      };
      if ((q.type || 'mcq') === 'code_output') {
        result.options = [];
        result.codeSnippet = String(q.codeSnippet || '');
      } else {
        result.options = Array.isArray(q.options) ? q.options.map(String) : [];
      }
      return result;
    })
  };
}

function adminTest(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    durationMinutes: row.duration_minutes,
    questions: row.questions || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getTest(id) {
  const { data, error } = await supabase
    .from('tests')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getAllTests() {
  const { data, error } = await supabase
    .from('tests')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ------------------------- Admin auth -------------------------
app.post('/api/admin/login', (req, res) => {
  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const expectedPassword = process.env.ADMIN_PASSWORD || 'Admin@12345';

  if (username !== expectedUser || password !== expectedPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.admin = true;
  req.session.loginAt = new Date().toISOString();
  req.session.save((error) => {
    if (error) {
      console.error('Session save failed:', error);
      return res.status(500).json({ error: 'Could not create admin session' });
    }
    return res.json({ ok: true });
  });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: req.session?.admin === true });
});

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
    const tests = await getAllTests();
    return res.json(tests.map(adminTest));
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
    if (!Array.isArray(body.questions) || body.questions.length === 0) {
      return res.status(400).json({ error: 'At least one question is required' });
    }

    const questions = body.questions.map(cleanQuestion);
    const id = String(body.id || `TEST-${Date.now()}`).trim();
    const now = new Date().toISOString();

    const payload = {
      id,
      title,
      description: String(body.description || '').trim(),
      duration_minutes: Math.max(1, Number(body.durationMinutes) || 10),
      questions,
      updated_at: now
    };

    const existing = await getTest(id);
    if (!existing) payload.created_at = now;

    const { data, error } = await supabase
      .from('tests')
      .upsert(payload, { onConflict: 'id' })
      .select('*')
      .single();
    if (error) throw error;

    return res.json(adminTest(data));
  } catch (error) {
    console.error(error);
    return res.status(400).json({ error: error.message || 'Could not save assessment' });
  }
});

app.delete('/api/admin/tests/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('tests').delete().eq('id', req.params.id);
    if (error) {
      if (error.code === '23503') {
        return res.status(409).json({ error: 'This assessment has results and cannot be deleted.' });
      }
      throw error;
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not delete assessment' });
  }
});

// ------------------------- Admin results -------------------------
app.get('/api/admin/results', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('results')
      .select('*')
      .order('submitted_at', { ascending: false });
    if (error) throw error;

    const results = (data || []).map((r) => ({
      Submission_ID: r.submission_id,
      Submitted_At: r.submitted_at,
      Test_ID: r.test_id,
      Test_Name: r.test_name,
      Full_Name: r.full_name,
      College_Name: r.college_name,
      Roll_Number: r.roll_number,
      Mobile_Number: r.mobile_number,
      Semester: r.semester,
      Branch: r.branch,
      Course: r.course,
      Total_Questions: r.total_questions,
      Attempted: r.attempted,
      Correct: r.correct,
      Wrong: r.wrong,
      Marks: Number(r.marks),
      Total_Marks: Number(r.total_marks),
      Percentage: Number(r.percentage),
      Violations: r.violations
    }));
    return res.json(results);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not load results' });
  }
});

app.get('/api/admin/results.xlsx', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('results').select('*').order('submitted_at', { ascending: false });
    if (error) throw error;

    const rows = (data || []).map((r) => ({
      Submission_ID: r.submission_id,
      Submitted_At: r.submitted_at,
      Test_Name: r.test_name,
      Full_Name: r.full_name,
      College_Name: r.college_name,
      Roll_Number: r.roll_number,
      Mobile_Number: r.mobile_number,
      Semester: r.semester,
      Branch: r.branch,
      Course: r.course,
      Total_Questions: r.total_questions,
      Attempted: r.attempted,
      Correct: r.correct,
      Wrong: r.wrong,
      Marks: Number(r.marks),
      Total_Marks: Number(r.total_marks),
      Percentage: Number(r.percentage),
      Violations: r.violations
    }));

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Student Results');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="student-results.xlsx"');
    return res.send(buffer);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not generate Excel report' });
  }
});

// ------------------------- Student APIs -------------------------
app.get('/api/tests', async (req, res) => {
  try {
    const tests = await getAllTests();
    return res.json(tests.map(publicTest));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not load assessments' });
  }
});

app.get('/api/tests/:id', async (req, res) => {
  try {
    const test = await getTest(req.params.id);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    return res.json(publicTest(test));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not load assessment' });
  }
});

app.post('/api/tests/:id/check-eligibility', async (req, res) => {
  try {
    const test = await getTest(req.params.id);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    const rollNumber = normalizeRollNumber(req.body?.rollNumber);
    if (!rollNumber) return res.status(400).json({ error: 'University / College Roll No. is required' });

    const { data, error } = await supabase
      .from('results')
      .select('submission_id')
      .eq('test_id', test.id)
      .eq('roll_number', rollNumber)
      .limit(1);
    if (error) throw error;

    if (data?.length) {
      return res.status(409).json({ error: 'This roll number has already attempted this assessment.' });
    }
    return res.json({ eligible: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not verify eligibility' });
  }
});

app.post('/api/tests/:id/submit', async (req, res) => {
  try {
    const test = await getTest(req.params.id);
    if (!test) return res.status(404).json({ error: 'Test not found' });

    const student = req.body?.student || {};
    const requiredFields = ['fullName', 'collegeName', 'rollNumber', 'mobileNumber', 'semester', 'branch', 'course'];
    if (requiredFields.some((field) => !String(student[field] || '').trim())) {
      return res.status(400).json({ error: 'All candidate fields are required' });
    }

    const rollNumber = normalizeRollNumber(student.rollNumber);
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    let correct = 0;
    const questions = Array.isArray(test.questions) ? test.questions : [];

    questions.forEach((question, index) => {
      const candidateAnswer = answers[index];
      if (!isAnswered(candidateAnswer)) return;

      if ((question.type || 'mcq') === 'code_output') {
        if (normalizeOutput(candidateAnswer) === normalizeOutput(question.expectedOutput)) correct += 1;
        return;
      }

      const candidateChoice = Number(candidateAnswer);
      if (Number.isInteger(candidateChoice) && candidateChoice === Number(question.answer)) correct += 1;
    });

    const attempted = answers.slice(0, questions.length).filter(isAnswered).length;
    const total = questions.length;
    const wrong = Math.max(0, attempted - correct);
    const percentage = total ? Number(((correct / total) * 100).toFixed(2)) : 0;
    const submissionId = `SUB-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    const result = {
      submission_id: submissionId,
      submitted_at: new Date().toISOString(),
      test_id: test.id,
      test_name: test.title,
      full_name: String(student.fullName).trim(),
      college_name: String(student.collegeName).trim(),
      roll_number: rollNumber,
      mobile_number: String(student.mobileNumber).trim(),
      semester: String(student.semester).trim(),
      branch: String(student.branch).trim(),
      course: String(student.course).trim(),
      total_questions: total,
      attempted,
      correct,
      wrong,
      marks: correct,
      total_marks: total,
      percentage,
      violations: Math.max(0, Number(req.body?.violations) || 0)
    };

    const { error } = await supabase.from('results').insert(result);
    if (error) {
      // PostgreSQL unique violation from (test_id, roll_number) is the final,
      // race-safe reattempt protection even if two requests arrive together.
      if (error.code === '23505') {
        return res.status(409).json({ error: 'This roll number has already attempted this assessment. Re-attempt is not allowed.' });
      }
      throw error;
    }

    // Never return marks/correct answers to the student.
    return res.json({ ok: true, submissionId, message: 'Test submitted successfully.' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Could not submit assessment' });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const { error } = await supabase.from('tests').select('id').limit(1);
    if (error) throw error;
    return res.json({ ok: true, database: 'supabase' });
  } catch (error) {
    return res.status(503).json({ ok: false, database: 'unavailable', error: error.message || 'Supabase connection failed' });
  }
});

// Client-side routes are served by the same SPA. API routes above always win.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SecureTest: http://localhost:${PORT}`);
});
