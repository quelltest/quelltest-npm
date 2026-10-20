import fs from 'node:fs';
import path from 'node:path';

export const RUNNERS = ['node', 'jest', 'vitest', 'mocha'];

/**
 * The runner a package.json names: vitest, then jest/react-scripts, then mocha (dependencies, devDependencies, the `jest` key
 * or the `test` script), or `node` for a `node --test` script. `null` when it names none (or cannot be read).
 */
export function packageRunner(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const script = String(pkg.scripts?.test ?? '');
    if (deps.vitest || /vitest/.test(script)) return 'vitest';
    if (deps.jest || deps['react-scripts'] || pkg.jest || /(?:jest|react-scripts)/.test(script)) return 'jest';
    if (deps.mocha || /mocha/.test(script)) return 'mocha';
    if (/node.*--test/.test(script)) return 'node';
  } catch { /* unreadable package.json: no signal */ }
  return null;
}

/** Pick the test runner from the nearest package.json (see packageRunner), else node:test. */
export function detectRunner(cwd = process.cwd()) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return packageRunner(dir) ?? 'node';
    if (path.dirname(dir) === dir) return 'node';
  }
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
