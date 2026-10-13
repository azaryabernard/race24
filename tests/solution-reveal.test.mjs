import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHand, canonicalKey } from '../shared/engine.js';

test('solver gives three exact, ordered steps for a four-card hand', () => {
  const report = analyzeHand(['5', '10', '7', 'A']);
  assert.equal(report.solvable, true);
  assert.equal(report.solutionSteps.length, 3);
  assert.match(report.solutionSteps[2], /= 24$/);
  assert.ok(report.solutionAceValues.every(v => v === 1 || v === 11));
});

test('trace remains correct when cached ranks and card order differ', () => {
  const withFaces = analyzeHand(['Q', '3', 'J', '7']);
  const shuffled = analyzeHand(['7', 'J', 'Q', '3']);
  assert.equal(withFaces.key, canonicalKey(['10', '10', '7', '3']));
  assert.deepEqual(withFaces.solutionSteps, shuffled.solutionSteps);
  assert.match(shuffled.solutionSteps[2], /= 24$/);
});

test('multiple aces and unsolvable hands are handled correctly', () => {
  const aces = analyzeHand(['A', 'A', 'A', '3']);
  assert.equal(aces.solutionSteps.length, 3);
  assert.equal(aces.solutionAceValues.length, 3);
  assert.ok(aces.solutionAceValues.includes(11));
  assert.equal(analyzeHand(['9','9','9','9']).solutionSteps, null);
});
