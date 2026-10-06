import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGenerated } from '../src/index.js';

test('exposes the correct-code and injected-bug verifier contract', () => {
  assert.equal(typeof verifyGenerated, 'function');
});
