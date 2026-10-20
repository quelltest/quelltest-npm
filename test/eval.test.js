import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, evaluateGate } from '../scripts/eval.mjs';

test('known-defect fixtures: regression guard for recall (>= 50% of all 18) and no risk findings on guarded code', () => {
  const result = evaluate();
  assert.deepEqual(result.missedDetectable, [], 'every fixture marked detectable must be detected');
  assert.ok(result.recall >= 0.5, `recall ${result.recall}`);
  assert.equal(result.detectableRecall, 1);
  assert.deepEqual(result.noise, []);
  assert.ok(result.cleanFiles >= 5);
});

test('verifier benchmark: strong tests are accepted, every weak variant is rejected', () => {
  const result = evaluateGate();
  assert.deepEqual(result.wrong, []);
  assert.equal(result.strongAccepted, result.strong);
  assert.equal(result.weakRejected, result.weak);
  assert.ok(result.strong >= 3 && result.weak >= 7);
});
