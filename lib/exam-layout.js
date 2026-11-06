// Per-candidate question layout + server-side scoring.
//
// Every candidate gets their own deterministic question order and (where it is
// safe) option order, derived from their exam-session id. Candidates sitting
// next to each other therefore see different screens, while the server can
// always rebuild the same layout later to score the answers.
//
// Answers travel in DISPLAYED order:
//   answers[position] = option index as displayed (MCQ) or text (code output).
// The server maps them back to the canonical question/option before scoring.
const crypto = require('crypto');

// Options such as "All of the above" only make sense in their original order.
const ORDER_DEPENDENT = /\b(all|none|both)\s+of\s+(the\s+)?(above|these|them)\b|\ball\s+the\s+above\b|\bboth\s+[a-d]\s+and\s+[a-d]\b|\b(a|b|c|d)\s+and\s+(a|b|c|d)\b$/i;

function seededRandom(seed) {
  const digest = crypto.createHash('sha256').update(String(seed)).digest();
  let a = digest.readUInt32LE(0);
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildLayout(questions, seed, enabled = true) {
  const random = seededRandom(seed);
  const identity = questions.map((_, index) => index);
  const order = enabled ? shuffled(identity, random) : identity;
  return order.map((questionIndex) => {
    const question = questions[questionIndex];
    if (question.type === 'code_output') return { questionIndex, optionOrder: null };
    const optionIdentity = question.options.map((_, index) => index);
    const keepOrder = !enabled || question.options.some((option) => ORDER_DEPENDENT.test(String(option)));
    return { questionIndex, optionOrder: keepOrder ? optionIdentity : shuffled(optionIdentity, random) };
  });
}

// What the candidate's browser receives. Never contains answers.
function displayedQuestions(questions, layout) {
  return layout.map(({ questionIndex, optionOrder }) => {
    const q = questions[questionIndex];
    const out = { id: q.id, type: q.type, question: q.question, marks: q.marks || 1 };
    if (q.type === 'code_output') out.codeSnippet = q.codeSnippet || '';
    else out.options = optionOrder.map((i) => String(q.options[i]));
    return out;
  });
}

function normalizeOutput(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().replace(/[ \t]+/g, ' ');
}

function isAnswered(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function scoreAnswers(questions, layout, answers) {
  const list = Array.isArray(answers) ? answers : [];
  const rows = [];
  let totalMarks = 0;
  let marksEarned = 0;
  layout.forEach(({ questionIndex, optionOrder }, position) => {
    const q = questions[questionIndex];
    const marks = Number(q.marks) || 1;
    totalMarks += marks;
    const given = list[position];
    let answered = isAnswered(given);
    let isCorrect = false;
    let stored = null;
    if (answered) {
      if (q.type === 'code_output') {
        stored = String(given).slice(0, 4000);
        isCorrect = normalizeOutput(given) === normalizeOutput(q.expectedOutput);
      } else {
        const shown = Number(given);
        if (Number.isInteger(shown) && shown >= 0 && shown < optionOrder.length) {
          const canonical = optionOrder[shown];
          stored = String(canonical);
          isCorrect = canonical === Number(q.answer);
        } else {
          answered = false; // out-of-range value: treat as unanswered
        }
      }
    }
    if (isCorrect) marksEarned += marks;
    rows.push({
      question_id: q.id,
      answer_value: answered ? stored : null,
      is_answered: answered,
      is_correct: isCorrect,
      marks_awarded: isCorrect ? marks : 0
    });
  });
  const attempted = rows.filter((r) => r.is_answered).length;
  const correctCount = rows.filter((r) => r.is_correct).length;
  return {
    rows,
    attempted,
    correctCount,
    wrong: Math.max(0, attempted - correctCount),
    marks: marksEarned,
    totalMarks,
    percentage: totalMarks ? Number(((marksEarned / totalMarks) * 100).toFixed(2)) : 0
  };
}

module.exports = { buildLayout, displayedQuestions, scoreAnswers, normalizeOutput, isAnswered };
