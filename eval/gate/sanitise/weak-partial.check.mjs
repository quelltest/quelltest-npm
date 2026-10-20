import test from 'node:test';
import assert from 'node:assert/strict';
import { slug } from './unit.mjs';

test('slug of an already-clean string', () => {
  assert.equal(slug('abc'), 'abc');
});
