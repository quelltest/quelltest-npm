import test from 'node:test';
import assert from 'node:assert/strict';
import { pageSize } from './unit.mjs';

test('pageSize with a value only', () => {
  assert.equal(pageSize({ size: 5 }), 5);
});
