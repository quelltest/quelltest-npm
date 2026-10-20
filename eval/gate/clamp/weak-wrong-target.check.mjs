import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp, other } from './unit.mjs';

test('asserts on the wrong function', () => {
  clamp(1, 5);
  assert.equal(other(2), 4);
});
