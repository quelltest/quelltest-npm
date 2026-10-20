import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './unit.mjs';

test('clamp pins the boundary and the error', () => {
  assert.equal(clamp(1, 5), 2);
  assert.equal(clamp(5, 5), 6);
  assert.throws(() => clamp(6, 5), { name: 'RangeError', message: 'too big' });
});
