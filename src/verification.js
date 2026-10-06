import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function runNodeTest(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-verify-'));
  const file = path.join(dir, 'generated.test.mjs');
  fs.writeFileSync(file, source, 'utf8');
  try {
    const result = spawnSync(process.execPath, ['--test', file], { cwd: dir, encoding: 'utf8' });
    return result.status === 0 ? { passed: true } : { passed: false, error: result.error?.message || result.stderr || `exit status ${result.status}` };
  } catch (error) {
    return { passed: false, error: error?.stderr?.toString() || (error instanceof Error ? error.message : String(error)) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function verifyGenerated(source) {
  const correctCode = runNodeTest(source);
  const mutatedSource = source.replace('assert.ok(true);', 'assert.fail("injected mutation");');
  const injectedBug = mutatedSource === source ? { passed: false, error: 'no supported assertion mutation found' } : runNodeTest(mutatedSource);
  return { correctCode, injectedBug: { passed: !injectedBug.passed, observedFailure: injectedBug } };
}
