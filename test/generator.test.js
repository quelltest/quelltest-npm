import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/index.js';

test('generates safe dry-run scaffolds with explicit pending verification gates', () => {
  const result = generate({ findings: [{ id: 'abc123', file: 'src/a.ts', line: 4, category: 'throws', evidence: 'throw new Error()', suggestion: 'assert the error' }] });
  assert.equal(result[0].status, 'SCAFFOLDED');
  assert.equal(result[0].gates.correctCode, 'PENDING');
  assert.equal(result[0].gates.injectedBug, 'PENDING');
});
