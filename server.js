const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const XLSX = require('xlsx');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('\nSecureTest cannot start: missing SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).\n');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

app.disable('x-powered-by');
app.set('trust proxy', 1);
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

// Use PostgreSQL-backed sessions on Render when DATABASE_URL is supplied.
if (process.env.DATABASE_URL) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  sessionOptions.store = new pgSession({ pool, createTableIfMissing: true });
} else {
  console.warn('Warning: DATABASE_URL not set; using MemoryStore for sessions. Add DATABASE_URL for production.');
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
  return String(value ?? '').replace(/\r\n/g, '\n').trim().replace(/[ \t]+/g, ' ');
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
    if (!codeSnippet || !expectedOutput) throw new Error(`Code and expected output are required for question ${index + 1}`);
    return { type, question: questionText, codeSnippet, expectedOutput, marks: Number(question?.marks) || 1 };
  }

  const options = Array.isArray(question?.options) ? question.options.map((x) => String(x).trim()) : [];
  const answer = Number(question?.answer);
  if (options.length < 2 || options.some((x) => !x)) throw new Error(`Invalid options for question ${index + 1}`);
  if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) throw new Error(`Invalid answer for question ${index + 1}`);
  return { type: 'mcq', question: questionText, options, answer, marks: Number(question?.marks) || 1 };
}

async function getQuestionsForTest(testId) {
  const { data, error } = await supabase.from('questions').select('*').eq('test_id', testId).order('question_order', { ascending: true });
  if (error) throw error;
  return (data || []).map((q) => q.question_type === 'code_output'
    ? { id: q.id, type: 'code_output', question: q.question_text, codeSnippet: q.code_snippet || '', expectedOutput: q.expected_output || '', marks: Number(q.marks) || 1 }
    : { id: q.id, type: 'mcq', question: q.question_text, options: Array.isArray(q.options) ? q.options : [], answer: Number(q.correct_answer), marks: Number(q.marks) || 1 });
}

function publicTest(row, questions) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    durationMinutes: row.duration_minutes,
    questions: (questions || []).map((q) => {
      const result = { id: q.id, type: q.type || 'mcq', question: q.question, marks: q.marks || 1 };
      if (result.type === 'code_output') result.codeSnippet = q.codeSnippet || '';
      else result.options = Array.isArray(q.options) ? q.options.map(String) : [];
      return result;
    })
  };
}

function adminTest(row, questions) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    durationMinutes: row.duration_minutes,
    questions: questions || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getTest(id) {
  const { data, error } = await supabase.from('tests').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function getAllTests() {
  const { data, error } = await supabase.from('tests').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  const tests = data || [];
  if (!tests.length) return [];
  const { data: qs, error: qError } = await supabase.from('questions').select('*').in('test_id', tests.map(t => t.id)).order('question_order', { ascending: true });
  if (qError) throw qError;
  const grouped = new Map(tests.map(t => [t.id, []]));
  (qs || []).forEach(q => grouped.get(q.test_id)?.push(q));
  return tests.map(t => ({ row: t, questions: (grouped.get(t.id) || []).map(q => q.question_type === 'code_output'
    ? { id: q.id, type: 'code_output', question: q.question_text, codeSnippet: q.code_snippet || '', expectedOutput: q.expected_output || '', marks: Number(q.marks) || 1 }
    : { id: q.id, type: 'mcq', question: q.question_text, options: Array.isArray(q.options) ? q.options : [], answer: Number(q.correct_answer), marks: Number(q.marks) || 1 }) }));
}

// ------------------------- Admin auth -------------------------
app.post('/api/admin/login', (req, res) => {
  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const expectedPassword = process.env.ADMIN_PASSWORD || 'Admin@12345';
  if (username !== expectedUser || password !== expectedPassword) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.admin = true;
  req.session.loginAt = new Date().toISOString();
  req.session.save(error => {
    if (error) return res.status(500).json({ error: 'Could not create admin session' });
    return res.json({ ok: true });
  });
});

app.get('/api/admin/session', (req, res) => res.json({ authenticated: req.session?.admin === true }));

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(error => {
    if (error) return res.status(500).json({ error: 'Could not log out' });
    res.clearCookie('securetest.sid');
    return res.json({ ok: true });
  });
});

// ------------------------- Admin tests -------------------------
app.get('/api/admin/tests', requireAdmin, async (req, res) => {
  try {
    const records = await getAllTests();
    return res.json(records.map(x => adminTest(x.row, x.questions)));
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
    const now = new Date().toISOString();
    const payload = { id, title, description: String(body.description || '').trim(), duration_minutes: Math.max(1, Number(body.durationMinutes) || 10), updated_at: now };
    const existing = await getTest(id);
    if (!existing) payload.created_at = now;

    const { data, error } = await supabase.from('tests').upsert(payload, { onConflict: 'id' }).select('*').single();
    if (error) throw error;

    // Replace the question set for this assessment.
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

    const savedQuestions = await getQuestionsForTest(id);
    return res.json(adminTest(data, savedQuestions));
  } catch (error) {
    console.error(error);
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
    // Use a single database transaction through a SECURITY DEFINER RPC.
    // This guarantees the delete order is correct (answers -> attempts -> students)
    // and prevents a partial cleanup if any foreign-key operation fails.
    const { data, error } = await supabase.rpc('admin_delete_all_student_data');
    if (error) {
      console.error('Student data delete RPC failed:', error);
      return res.status(500).json({ error: error.message || 'Could not delete student data' });
    }
    const result = Array.isArray(data) ? (data[0] || {}) : (data || {});
    return res.json({
      ok: true,
      deletedStudents: Number(result.deleted_students || 0),
      deletedAttempts: Number(result.deleted_attempts || 0),
      deletedAnswers: Number(result.deleted_answers || 0)
    });
  } catch (error) {
    console.error('Student data delete failed:', error);
    return res.status(500).json({ error: error.message || 'Could not delete student data' });
  }
});

// ------------------------- Student APIs -------------------------
app.get('/api/tests', async (req, res) => {
  try {
    const records = await getAllTests();
    return res.json(records.map(x => publicTest(x.row, x.questions)));
  } catch (error) { console.error(error); return res.status(500).json({ error: 'Could not load assessments' }); }
});

app.get('/api/tests/:id', async (req, res) => {
  try {
    const test = await getTest(req.params.id);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    return res.json(publicTest(test, await getQuestionsForTest(test.id)));
  } catch (error) { console.error(error); return res.status(500).json({ error: 'Could not load assessment' }); }
});

app.post('/api/tests/:id/check-eligibility', async (req, res) => {
  try {
    const test = await getTest(req.params.id);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    const rollNumber = normalizeRollNumber(req.body?.rollNumber);
    if (!rollNumber) return res.status(400).json({ error: 'University / College Roll No. is required' });

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

app.post('/api/tests/:id/submit', async (req, res) => {
  try {
    const test = await getTest(req.params.id);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    const questions = await getQuestionsForTest(test.id);
    const student = req.body?.student || {};
    const requiredFields = ['fullName','collegeName','rollNumber','mobileNumber','semester','branch','course'];
    if (requiredFields.some(field => !String(student[field] || '').trim())) return res.status(400).json({ error: 'All candidate fields are required' });

    const rollNumber = normalizeRollNumber(student.rollNumber);
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    let correct = 0;
    let totalMarks = 0;
    const answerRows = [];

    questions.forEach((question, index) => {
      const candidateAnswer = answers[index];
      const answered = isAnswered(candidateAnswer);
      const marks = Number(question.marks) || 1;
      totalMarks += marks;
      let isCorrect = false;
      if (answered) {
        if (question.type === 'code_output') isCorrect = normalizeOutput(candidateAnswer) === normalizeOutput(question.expectedOutput);
        else {
          const candidateChoice = Number(candidateAnswer);
          isCorrect = Number.isInteger(candidateChoice) && candidateChoice === Number(question.answer);
        }
      }
      if (isCorrect) correct += marks;
      answerRows.push({ question_id: question.id, answer_value: answered ? String(candidateAnswer) : null, is_answered: answered, is_correct: isCorrect, marks_awarded: isCorrect ? marks : 0 });
    });

    const attempted = answerRows.filter(x => x.is_answered).length;
    const correctCount = answerRows.filter(x => x.is_correct).length;
    const wrong = Math.max(0, attempted - correctCount);
    const percentage = totalMarks ? Number(((correct / totalMarks) * 100).toFixed(2)) : 0;

    const { data: studentRow, error: studentError } = await supabase.from('students').upsert({
      full_name: String(student.fullName).trim(),
      college_name: String(student.collegeName).trim(),
      roll_number: rollNumber,
      mobile_number: String(student.mobileNumber).trim(),
      semester: String(student.semester).trim(),
      branch: String(student.branch).trim(),
      course: String(student.course).trim(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'roll_number' }).select('*').single();
    if (studentError) throw studentError;

    const submissionId = `SUB-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
    const { data: attempt, error: attemptError } = await supabase.from('attempts').insert({
      submission_id: submissionId,
      student_id: studentRow.id,
      test_id: test.id,
      total_questions: questions.length,
      attempted,
      correct: correctCount,
      wrong,
      marks: correct,
      total_marks: totalMarks,
      percentage,
      violations: Math.max(0, Number(req.body?.violations) || 0),
      submitted_at: new Date().toISOString()
    }).select('*').single();

    if (attemptError) {
      if (attemptError.code === '23505') return res.status(409).json({ error: 'This roll number has already attempted this assessment. Re-attempt is not allowed.' });
      throw attemptError;
    }

    const rows = answerRows.map(x => ({ attempt_id: attempt.id, ...x }));
    const { error: answerError } = await supabase.from('answers').insert(rows);
    if (answerError) {
      await supabase.from('attempts').delete().eq('id', attempt.id);
      throw answerError;
    }

    return res.json({ ok: true, submissionId, message: 'Test submitted successfully.' });
  } catch (error) { console.error(error); return res.status(500).json({ error: 'Could not submit assessment' }); }
});

app.get('/api/health', async (req, res) => {
  try { const { error } = await supabase.from('tests').select('id').limit(1); if (error) throw error; return res.json({ ok:true, database:'supabase' }); }
  catch { return res.status(503).json({ ok:false, database:'unavailable' }); }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`SecureTest: http://localhost:${PORT}`));
