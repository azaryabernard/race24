import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rational, formatR, R, power, integerLog, integerRoot, canonicalKey,
  drawHand, analyzeHand, leaf, combine, verifySolution,
} from '../shared/engine.js';

test('canonicalization ignores suits and order and maps 10/J/Q/K to 10', () => {
  assert.equal(canonicalKey(['Q','3','J','7']), '3-7-10-10');
  assert.equal(canonicalKey(['7','K','10','3']), '3-7-10-10');
  assert.equal(canonicalKey([{rank:'A',suit:'♥'}, {rank:'2',suit:'♣'}, {rank:'Q',suit:'♣'}, {rank:'3',suit:'♠'}]), '1-2-3-10');
});
test('rational and arithmetic exactness', () => {
  assert.equal(formatR(R.div(rational(1), rational(3))), '1/3');
  assert.equal(formatR(power(rational(2), rational(-2))), '1/4');
  assert.throws(() => power(rational(2), rational(1, 2)));
  assert.throws(() => R.div(rational(2), rational(0)));
});
test('integer-only logarithms and roots', () => {
  assert.equal(formatR(integerLog(rational(8), rational(2))), '3');
  assert.equal(formatR(integerLog(rational(1,8), rational(2))), '-3');
  assert.equal(formatR(integerLog(rational(9,4), rational(3,2))), '2');
  assert.equal(formatR(integerRoot(rational(-8), rational(3))), '-2');
  assert.equal(formatR(integerRoot(rational(1,8), rational(-3))), '2');
  assert.throws(() => integerLog(rational(5), rational(2)));
  assert.throws(() => integerRoot(rational(2), rational(2)));
});
test('hands always 4 distinct physical cards, max 2 tens', () => {
  for (let i = 0; i < 400; i++) {
    const hand = drawHand();
    assert.equal(new Set(hand.map(c => `${c.rank}-${c.suit}`)).size, 4);
    assert.ok(hand.filter(c => ['10','J','Q','K'].includes(c.rank)).length <= 2);
  }
});
test('search + expression verification + Ace 11', () => {
  const hand = ['A','A','A','3'].map(rank => ({rank,suit:'♣'}));
  const result = analyzeHand(hand);
  assert.equal(result.solvable, true);
  assert.ok(['Easy','Medium','Hard','Expert'].includes(result.difficulty));
  const a = combine(leaf(hand[0],0,1), '+', leaf(hand[1],1,11));
  const b = combine(leaf(hand[3],3), '-', leaf(hand[2],2,1));
  const answer = combine(a, '*', b);
  assert.equal(answer.value.n,24n);
  assert.equal(verifySolution(hand, answer.expr).valid,true);
  assert.equal(verifySolution(hand, {op:'+',left:answer.expr,right:{card:0}}).valid,false);
  assert.equal(analyzeHand(['A','3','8','2']).solvable,true);
});
