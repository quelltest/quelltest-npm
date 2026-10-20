import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generate, report } from '../src/index.js';
import { runTest } from '../src/verification.js';

// Fixture projects are copied under the repository (not os.tmpdir) so jest, mocha and vitest resolve from its node_modules.
const repo = process.cwd();
const scratch = path.join(repo, '.tmp-matrix');

const MATRIX = [
  { runner: 'jest', fixture: 'cjs', ext: '.test.js', expect: [/describe\("clampAge"/, /const \{ clampAge \} = require\(/, /expect\(\(\) => clampAge\(-1\)\)\.toThrow\("age must not be negative"\)/] },
  { runner: 'mocha', fixture: 'cjs', ext: '.test.js', expect: [/describe\("clampAge"/, /const assert = require\('node:assert\/strict'\)/, /assert\.throws\(\(\) => clampAge\(-1\)/] },
  { runner: 'vitest', fixture: 'esm', ext: '.test.js', expect: [/from 'vitest'/, /import \{ clampAge \} from/, /expect\(\(\) => clampAge\(-1\)\)\.toThrow/] },
  { runner: 'node', fixture: 'cjs', ext: '.test.cjs', expect: [/const test = require\('node:test'\)/, /require\(".*guards\.js"\)/] },
  { runner: 'node', fixture: 'esm', ext: '.test.mjs', expect: [/import test from 'node:test'/, /import \{ clampAge \} from/] },
];

for (const { runner, fixture, ext, expect } of MATRIX) {
  test(`generated ${fixture.toUpperCase()} tests run and verify under ${runner}`, { timeout: 240_000 }, () => {
    const dir = path.join(scratch, `${runner}-${fixture}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(path.join(repo, 'eval', 'matrix', fixture), dir, { recursive: true });
    try {
      process.chdir(dir);
      const results = generate(report('src', { coverage: false }), { runner, destination: path.join(dir, 'tests', 'quelltest'), write: true, verify: true });
      const verified = results.filter((item) => item.status === 'VERIFIED');
      assert.ok(verified.length >= 1, JSON.stringify(results.map((r) => [r.status, r.reason])));
      assert.match(verified[0].output, new RegExp(`${ext.replaceAll('.', '\\.')}$`));
      const source = fs.readFileSync(verified[0].output, 'utf8');
      for (const pattern of expect) assert.match(source, pattern);
      const run = runTest(verified[0].output, { runner, cwd: dir });
      assert.equal(run.passed, true, run.error);
    } finally {
      process.chdir(repo);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
