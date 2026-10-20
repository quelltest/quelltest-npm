import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './unit.mjs';

test('clamp happy path only', () => {
  assert.equal(clamp(1, 5), 2);
});
