import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../scripts/eval.mjs';

test('known-defect fixtures: recall stays at or above the 0.2 target with no noise on guarded code', () => {
  const result = evaluate();
  assert.deepEqual(result.missedDetectable, [], 'every fixture marked detectable must be detected');
  assert.ok(result.recall >= 0.5, `recall ${result.recall}`);
  assert.deepEqual(result.noise, []);
  assert.ok(result.cleanFiles >= 5);
});
