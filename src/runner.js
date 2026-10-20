import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RUNNERS = ['node', 'jest', 'vitest', 'mocha'];

// A package search never climbs into a filesystem root or the home directory (a stray package.json there is not the project's).
// Compared with path.relative so that Windows case differences (c:\ and C:\) cannot defeat the bound.
const isBroad = (dir) => [path.parse(dir).root, os.homedir()].some((broad) => broad && path.relative(broad, dir) === '');

// A word in a script: not part of a longer name (jest-circus, mocha-free, ts-jest, @jest/globals) but fine after a path (.bin/jest).
const word = (names) => new RegExp(String.raw`(?<![\w@-])(?:${names})(?![\w-])`);
const SCRIPT = { vitest: word('vitest'), jest: word('jest|react-scripts'), mocha: word('mocha'), node: new RegExp(String.raw`(?<![\w@-])node\s.*--test(?![\w-])`) };

/**
 * Read the runner one package.json names: vitest, then jest/react-scripts, then mocha (dependencies, devDependencies, the `jest`
 * key or the `test` script), or `node` for a `node --test` script. `{ runner, error }`: `runner` is null when it names none,
 * `error` says why the file could not be read (a missing file is not an error).
 */
function inspectPackage(dir) {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) return { runner: null, error: null };
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const script = String(pkg.scripts?.test ?? '');
    if (deps.vitest || SCRIPT.vitest.test(script)) return { runner: 'vitest', error: null };
    if (deps.jest || deps['react-scripts'] || pkg.jest || SCRIPT.jest.test(script)) return { runner: 'jest', error: null };
    if (deps.mocha || SCRIPT.mocha.test(script)) return { runner: 'mocha', error: null };
    if (SCRIPT.node.test(script)) return { runner: 'node', error: null };
    return { runner: null, error: null };
  } catch (error) {
    return { runner: null, error: `could not read package.json (${String(error.message).split(/\r?\n/)[0]})` };
  }
}

/** The runner one package.json names (see inspectPackage), or null. */
export function packageRunner(dir) {
  return inspectPackage(dir).runner;
}

/**
 * Find the runner for code under `startDir`: the nearest package.json that names a runner wins, so a marker package.json
 * (`{"type":"commonjs"}`) or a workspace package without test tooling defers to the package above it. The walk never goes
 * above `stopAt` (inclusive), nor into a filesystem root or home directory. Result: `{ runner, dir, error }`; `runner` is null
 * when none names one, `error` is the first package.json that could not be read (set even when a runner is found above it).
 */
export function findRunner(startDir, { stopAt } = {}) {
  let error = null;
  const start = path.resolve(startDir);
  const atStop = (dir) => stopAt !== undefined && path.relative(path.resolve(stopAt), dir) === '';
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (dir !== start && !atStop(dir) && isBroad(dir)) break;
    const found = inspectPackage(dir);
    error ??= found.error;
    if (found.runner) return { runner: found.runner, dir, error };
    if (atStop(dir) || path.dirname(dir) === dir) break;
  }
  return { runner: null, dir: null, error };
}

/** Pick the test runner like findRunner does (see there), else node:test. */
export function detectRunner(cwd = process.cwd()) {
  return findRunner(cwd).runner ?? 'node';
}

const quote = (text) => JSON.stringify(text);

function importLines({ runner, style, importPath, exportInfo }) {
  const { kind, name } = exportInfo;
  const target = quote(importPath);
  if (style === 'cjs' && runner !== 'vitest') return kind === 'default' ? `const ${name} = require(${target});` : `const { ${name} } = require(${target});`;
  if (style === 'cjs') return kind === 'default' ? `import ${name} from ${target};` : `import unit from ${target};\nconst { ${name} } = unit;`;
  return kind === 'default' ? `import ${name} from ${target};` : `import { ${name} } from ${target};`;
}

function header({ runner, style }) {
  const esm = style !== 'cjs' || runner === 'vitest';
  if (runner === 'vitest') return "import { describe, it, expect } from 'vitest';";
  if (runner === 'jest') return '';
  const assert = esm ? "import assert from 'node:assert/strict';" : "const assert = require('node:assert/strict');";
  if (runner === 'mocha') return assert;
  return esm ? `import test from 'node:test';\n${assert}` : `const test = require('node:test');\n${assert}`;
}

function assertion(runner, item, call) {
  const usesExpect = runner === 'jest' || runner === 'vitest';
  if (item.kind === 'throws') {
    if (usesExpect) {
      const matcher = item.message ? quote(item.message) : (item.errorName && /^(?:Type|Range|Syntax|Reference|Eval|URI)?Error$/.test(item.errorName) ? item.errorName : '');
      return item.async ? `await expect(${call}).rejects.toThrow(${matcher});` : `expect(() => ${call}).toThrow(${matcher});`;
    }
    const expected = [];
    if (item.errorName && /^(?:Type|Range|Syntax|Reference|Eval|URI)?Error$/.test(item.errorName)) expected.push(`name: ${quote(item.errorName)}`);
    if (item.message) expected.push(`message: ${quote(item.message)}`);
    const matcher = expected.length ? `, { ${expected.join(', ')} }` : '';
    return item.async ? `await assert.rejects(() => ${call}${matcher});` : `assert.throws(() => ${call}${matcher});`;
  }
  if (item.kind === 'ok') {
    if (usesExpect) return item.async ? `await expect(${call}).resolves.not.toThrow();` : `expect(() => ${call}).not.toThrow();`;
    return item.async ? `await assert.doesNotReject(() => ${call});` : `assert.doesNotThrow(() => ${call});`;
  }
  const value = item.async ? `await ${call}` : call;
  return usesExpect ? `expect(${value}).toEqual(${item.expected});` : `assert.deepStrictEqual(${value}, ${item.expected});`;
}

/** File extension for a generated test so the runner and module system load it correctly. */
export function testExtension({ runner, style, sourceExt }) {
  if (/^\.[cm]?tsx?$/.test(sourceExt)) return '.test.ts';
  if (runner === 'node') return style === 'cjs' ? '.test.cjs' : '.test.mjs';
  return '.test.js';
}

/** Render a runnable test file for the runner and module style. Calls the unit and asserts on the result. */
export function renderTest({ runner, style, importPath, exportInfo, functionName, isAsync, cases }) {
  const callee = exportInfo.name;
  const blocks = cases.map((item) => {
    const call = `${callee}(${item.args.join(', ')})`;
    const flagged = { ...item, async: isAsync };
    const checked = assertion(runner, flagged, call);
    // A stubbed global fetch is always restored, even when the assertion throws.
    const body = item.globalFetch
      ? `const originalFetch = globalThis.fetch;
  globalThis.fetch = ${item.globalFetch};
  try {
    ${checked}
  } finally {
    globalThis.fetch = originalFetch;
  }`
      : checked;
    const asyncKeyword = isAsync ? 'async ' : '';
    if (runner === 'node') return `test(${quote(`${functionName}: ${item.title}`)}, ${asyncKeyword}() => {\n  ${body}\n});`;
    return `  it(${quote(item.title)}, ${asyncKeyword}() => {\n    ${body}\n  });`;
  });
  const stubNote = cases.some((item) => item.stubbed)
    ? '// Stubs below are derived from the guards in the source, not from the real service. Compare them with recorded examples: quell mocks.'
    : '';
  const parts = [header({ runner, style }), importLines({ runner, style, importPath, exportInfo }), stubNote].filter(Boolean);
  const tests = runner === 'node' ? blocks.join('\n\n') : `describe(${quote(functionName)}, () => {\n${blocks.join('\n\n')}\n});`;
  return `${parts.join('\n')}\n\n${tests}\n`;
}
