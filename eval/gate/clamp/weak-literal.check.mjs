import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './unit.mjs';

test('clamp is a function', () => {
  assert.equal(typeof clamp, 'function');
  assert.equal(1 + 1, 2);
});
