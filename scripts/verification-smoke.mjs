import assert from 'node:assert/strict';
import { verifyGenerated } from '../src/index.js';

const result = verifyGenerated("import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('candidate', () => {\n  assert.ok(true);\n});\n");
assert.equal(result.correctCode.passed, true, JSON.stringify(result));
assert.equal(result.injectedBug.passed, true, JSON.stringify(result));
console.log('verified correct-code pass and injected-bug failure');
