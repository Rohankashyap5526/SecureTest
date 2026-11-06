// Turns an exam session into a stored attempt (+ answers).
// Used by BOTH the candidate's submit request and the background sweeper, so a
// candidate whose browser dies or whose timer ends still gets graded from the
// last autosave. Safe to call twice: the unique (test_id, student_id) index
// makes the second call a no-op that returns the existing submission id.
const { buildLayout, scoreAnswers } = require('./exam-layout');

async function finalizeSession({ supabase, session, bundle, answers, shuffle }) {
  const layout = buildLayout(bundle.questions, session.id, shuffle);
  const scored = scoreAnswers(bundle.questions, layout, answers);
  const submittedAt = new Date().toISOString();
  const submissionId = `SUB-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const { data: attempt, error: attemptError } = await supabase.from('attempts').insert({
    submission_id: submissionId,
    student_id: session.student_id,
    test_id: session.test_id,
    total_questions: bundle.questions.length,
    attempted: scored.attempted,
    correct: scored.correctCount,
    wrong: scored.wrong,
    marks: scored.marks,
    total_marks: scored.totalMarks,
    percentage: scored.percentage,
    violations: Math.max(0, Number(session.violation_count) || 0),
    started_at: session.started_at,
    submitted_at: submittedAt
  }).select('id,submission_id').single();

  if (attemptError) {
    if (attemptError.code === '23505') {
      const { data: existing, error: lookupError } = await supabase.from('attempts')
        .select('submission_id').eq('test_id', session.test_id).eq('student_id', session.student_id).maybeSingle();
      if (lookupError) throw lookupError;
      await supabase.from('exam_sessions').update({ status: 'submitted', submitted_at: submittedAt }).eq('id', session.id);
      return { submissionId: existing?.submission_id || null, duplicate: true };
    }
    throw attemptError;
  }

  const { error: answerError } = await supabase.from('answers')
    .insert(scored.rows.map((row) => ({ attempt_id: attempt.id, ...row })));
  if (answerError) {
    await supabase.from('attempts').delete().eq('id', attempt.id);
    throw answerError;
  }

  const { error: sessionError } = await supabase.from('exam_sessions')
    .update({ status: 'submitted', submitted_at: submittedAt }).eq('id', session.id);
  if (sessionError) console.error('Attempt stored but session status update failed:', sessionError.message);
  return { submissionId: attempt.submission_id, duplicate: false };
}

module.exports = { finalizeSession };
