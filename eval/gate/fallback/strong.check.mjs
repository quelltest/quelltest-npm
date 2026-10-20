import test from 'node:test';
import assert from 'node:assert/strict';
import { pageSize, offsetFor } from './unit.mjs';

test('pageSize keeps 0 and defaults only when missing', () => {
  assert.equal(pageSize({}), 10);
  assert.equal(pageSize({ size: 0 }), 0);
  assert.equal(pageSize({ size: 5 }), 5);
});

test('offsetFor rejects page 0 and computes offsets', () => {
  assert.throws(() => offsetFor(0, 10), RangeError);
  assert.equal(offsetFor(1, 10), 0);
  assert.equal(offsetFor(3, 10), 20);
});
