import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, UsageError } from '../src/cli-args.js';

const cli = path.resolve('src/cli.js');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-cli-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const SOURCE = 'export function pay(a) {\n  if (a <= 0) throw new Error("positive");\n  return a;\n}\n';

test('CLI exposes help and version without loading a project', () => {
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /find\|score\|generate/);
  const version = run('--version');
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
});

test('parseArgs handles values, equals form, repeatables and aliases', () => {
  const { command, root, options } = parseArgs(['score', 'src', '--threshold=60', '--exclude', 'a', '--ignore', 'b', '--json']);
  assert.deepEqual([command, root, options.threshold, options.exclude, options.json], ['score', 'src', 60, ['a', 'b'], true]);
  assert.equal(parseArgs(['--threshold', '60']).root, '.');
  assert.equal(parseArgs(['src/a.js']).root, 'src/a.js');
});

test('parseArgs rejects bad input with UsageError', () => {
  for (const argv of [['--threshold'], ['--threshold', 'abc'], ['--nope'], ['bogus'], ['find', 'a', 'b'], ['--json=1'], ['--top', '0']]) {
    assert.throws(() => parseArgs(argv), UsageError, argv.join(' '));
  }
});

test('find accepts a single file and `find --threshold N` does not eat the number as a path', () => {
  const dir = project({ 'a.js': SOURCE });
  const file = run('find', path.join(dir, 'a.js'));
  assert.equal(file.status, 0, file.stderr);
  assert.match(file.stdout, /\[throws\]/);
  const threshold = spawnSync(process.execPath, [cli, 'find', '--threshold', '60'], { encoding: 'utf8', cwd: dir });
  assert.equal(threshold.status, 3, threshold.stderr);
  assert.doesNotMatch(threshold.stderr, /ENOTDIR|\n\s+at /);
});

test('errors are one clean line with exit code 2', () => {
  const result = run('find', path.join(os.tmpdir(), 'definitely-missing-quell-dir'));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^quell: no such file or directory/);
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.equal(run('--bogus').status, 2);
});

test('score is "not scored" without coverage evidence and exit codes are defined', () => {
  const dir = project({ 'a.js': SOURCE });
  const json = run('score', dir, '--json');
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.summary.score, null);
  assert.equal(parsed.summary.coverageEvidence, 'none');
  assert.match(run('score', dir).stdout, /not scored/);
  assert.equal(run('score', dir, '--threshold', '60').status, 3);
});

test('score uses coverage evidence and --threshold gates on it', () => {
  const dir = project({ 'a.js': SOURCE });
  const file = path.join(dir, 'a.js');
  const coverage = (hits) => JSON.stringify({
    [file]: {
      statementMap: {
        0: { start: { line: 2, column: 2 }, end: { line: 2, column: 40 } },
        1: { start: { line: 2, column: 14 }, end: { line: 2, column: 40 } },
      },
      s: { 0: hits, 1: hits },
      branchMap: { 0: { type: 'if', loc: { start: { line: 2, column: 2 }, end: { line: 2, column: 40 } } } },
      b: { 0: [hits, hits] },
    },
  });
  fs.writeFileSync(path.join(dir, 'full.json'), coverage(3));
  fs.writeFileSync(path.join(dir, 'none.json'), coverage(0));
  const good = run('score', dir, '--coverage', path.join(dir, 'full.json'), '--threshold', '90');
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /100\/100/);
  assert.equal(run('score', dir, '--coverage', path.join(dir, 'none.json'), '--threshold', '10').status, 1);
  assert.match(run('find', dir, '--coverage', path.join(dir, 'full.json')).stdout, /0 edge-case candidates not executed/);
  assert.match(run('find', dir, '--coverage', path.join(dir, 'full.json'), '--all').stdout, /\[throws\]/);
  assert.equal(run('score', dir, '--coverage', path.join(dir, 'missing.json')).status, 2);
});

test('find truncates to the top N ranked candidates; --sarif emits valid SARIF', () => {
  const body = Array.from({ length: 15 }, (_, i) => `export function f${i}(a) { if (a < ${i}) throw new Error("e${i}"); }`).join('\n');
  const dir = project({ 'a.js': body });
  assert.equal(run('find', dir).stdout.split('\n').filter((line) => line.startsWith('•')).length, 10);
  assert.match(run('find', dir, '--top', '2').stdout, /… \d+ more/);
  const sarif = JSON.parse(run('find', dir, '--sarif').stdout);
  assert.equal(sarif.version, '2.1.0');
  assert.ok(sarif.runs[0].results.length >= 15);
  assert.ok(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine > 0);
});

test('--diff limits candidates to changed lines', () => {
  const dir = project({ 'a.js': SOURCE });
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  fs.appendFileSync(path.join(dir, 'a.js'), 'export function other(b) {\n  if (b > 9) throw new RangeError("big");\n}\n');
  const result = spawnSync(process.execPath, [cli, 'find', '.', '--diff', 'HEAD', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const { findings } = JSON.parse(result.stdout);
  assert.ok(findings.length > 0 && findings.every((item) => item.function === 'other'));
  assert.equal(spawnSync(process.execPath, [cli, 'find', '.', '--diff', 'no-such-ref'], { cwd: dir, encoding: 'utf8' }).status, 2);
});

test('CLI generate remains dry-run unless --write is explicit', () => {
  const dir = project({ 'a.js': SOURCE });
  const result = run('generate', dir, '--json');
  assert.equal(result.status, 0);
  assert.ok(JSON.parse(result.stdout).findings.every((item) => item.output === null));
});
