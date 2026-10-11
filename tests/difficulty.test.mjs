import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeHand, DIFFICULTY_VERSION, RULES_VERSION } from '../shared/engine.js';

const examples = [
  [['5','7','10','10'], 'Medium', '10 ÷ 5 = 2'],
  [['6','6','6','6'], 'Easy', null],
  [['4','4','10','10'], 'Hard', null],
  [['3','3','8','8'], 'Expert', null],
  [['5','7','10','A'], 'Medium', null],
  [['9','9','9','9'], 'Unsolvable', null],
];
for (const [hand, difficulty, firstStep] of examples) {
  test(`difficulty v2: ${hand.join('-')} → ${difficulty}`, () => {
    const report = analyzeHand(hand);
    assert.equal(report.difficulty, difficulty);
    assert.equal(report.difficultyVersion, 2);
    if (firstStep) assert.ok(report.solutionSteps.includes(firstStep));
    if (report.solvable) assert.match(report.solutionSteps[2], /= 24$/);
  });
}

test('harder labels never come just from an arbitrary count of pruned DFS leaves', () => {
  const report = analyzeHand(['5','7','10','10']);
  assert.equal(report.usesAdvanced, false);
  assert.equal(report.score, 5);
  assert.equal(report.helpfulOpenings, 5);
  assert.equal(analyzeHand(['10','5','7','K']).key, '5-7-10-10');
});

test('shared browser engine exactly matches Supabase Edge engine', () => {
  assert.equal(readFileSync(new URL('../shared/engine.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../supabase/functions/_shared/engine.js', import.meta.url), 'utf8'));
  assert.equal(RULES_VERSION, 1); // Records and existing rules remain compatible.
  assert.equal(DIFFICULTY_VERSION, 2);
});

test('all canonical four-value combinations get stable, well-spread labels and exact traces', () => {
  const distribution = {};
  let combos = 0;
  for (let a = 1; a <= 10; a++) for (let b = a; b <= 10; b++)
    for (let c = b; c <= 10; c++) for (let d = c; d <= 10; d++) {
      const hand = [a,b,c,d].map(n => n === 1 ? 'A' : String(n));
      const report = analyzeHand(hand);
      assert.equal(report.key, [a,b,c,d].join('-'));
      assert.ok(Number.isInteger(report.helpfulOpenings) && report.helpfulOpenings >= 0);
      if (report.solvable) {
        assert.equal(report.solutionSteps.length, 3);
        assert.match(report.solutionSteps[2], /= 24$/);
        assert.ok(Number.isInteger(report.score) && report.score >= 3);
      }
      distribution[report.difficulty] = (distribution[report.difficulty] || 0) + 1;
      combos++;
    }
  assert.equal(combos, 715);
  assert.equal(Object.values(distribution).reduce((n, v) => n+v, 0), combos);
  for (const group of ['Easy','Medium','Hard','Expert']) assert.ok(distribution[group] >= 20, `${group} should have useful variety`);
  assert.ok(distribution.Unsolvable >= 1);
});
