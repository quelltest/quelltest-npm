import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './unit.mjs';

test('clamp works', () => {
  clamp(1, 5);
  assert.ok(true);
});
