const test = require('node:test');
const assert = require('node:assert');
const { buildLayout, displayedQuestions, scoreAnswers } = require('../lib/exam-layout');

const questions = [
  { id: 'q1', type: 'mcq', question: 'a', options: ['w', 'x', 'y', 'z'], answer: 2, marks: 1 },
  { id: 'q2', type: 'mcq', question: 'b', options: ['Foo', 'Bar', 'All of the above'], answer: 2, marks: 2 },
  { id: 'q3', type: 'code_output', question: 'c', codeSnippet: 'print(1)', expectedOutput: '1', marks: 3 },
  { id: 'q4', type: 'mcq', question: 'd', options: ['p', 'q'], answer: 0, marks: 1 }
];

test('layout is deterministic per seed and differs across seeds', () => {
  assert.deepStrictEqual(buildLayout(questions, 'S1'), buildLayout(questions, 'S1'));
  const orders = new Set(Array.from({ length: 30 }, (_, i) => buildLayout(questions, 'seed' + i).map((l) => l.questionIndex).join()));
  assert.ok(orders.size > 5, 'different candidates should get different orders');
});

test('"All of the above" keeps its original option order', () => {
  for (let i = 0; i < 20; i += 1) {
    const l = buildLayout(questions, 'k' + i).find((x) => x.questionIndex === 1);
    assert.deepStrictEqual(l.optionOrder, [0, 1, 2]);
  }
});

test('displayed questions never leak answers', () => {
  const shown = JSON.stringify(displayedQuestions(questions, buildLayout(questions, 'x')));
  assert.ok(!shown.includes('expectedOutput') && !/"answer"/.test(shown));
});

test('scoring maps displayed answers back to canonical ones', () => {
  for (let i = 0; i < 25; i += 1) {
    const layout = buildLayout(questions, 'score' + i);
    // Answer everything correctly the way a candidate would: by reading displayed text.
    const answers = layout.map(({ questionIndex, optionOrder }) => {
      const q = questions[questionIndex];
      if (q.type === 'code_output') return ' 1 ';
      return optionOrder.indexOf(q.answer);
    });
    const s = scoreAnswers(questions, layout, answers);
    assert.strictEqual(s.marks, 7);
    assert.strictEqual(s.correctCount, 4);
    assert.strictEqual(s.totalMarks, 7);
  }
});

test('unanswered, out-of-range and wrong answers are handled', () => {
  const layout = buildLayout(questions, 'z', false);
  const s = scoreAnswers(questions, layout, [0, 99, null, 1]);
  assert.strictEqual(s.attempted, 2);
  assert.strictEqual(s.correctCount, 0);
  assert.strictEqual(s.wrong, 2);
});
