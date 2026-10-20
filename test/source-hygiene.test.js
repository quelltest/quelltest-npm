import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// A control character in source is almost always a mangled escape (a regex `\b` written through a shell becomes a backspace byte
// and silently stops matching). Tab, LF and CR are the only control characters allowed.
const ROOTS = ['src', 'scripts'];
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.sh', '.md']);
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (EXTENSIONS.has(path.extname(entry.name))) yield full;
  }
}

test('no file under src/ or scripts/ contains a control character other than tab, LF or CR', () => {
  const problems = [];
  let scanned = 0;
  for (const root of ROOTS) {
    for (const file of files(root)) {
      scanned += 1;
      const text = fs.readFileSync(file, 'utf8');
      const match = CONTROL.exec(text);
      if (match) problems.push(`${file}:${text.slice(0, match.index).split('\n').length} U+${match[0].charCodeAt(0).toString(16).padStart(4, '0')}`);
    }
  }
  assert.ok(scanned > 20, `expected to scan the source tree, scanned ${scanned} files`);
  assert.deepEqual(problems, []);
});

test('the guard itself recognises a mangled escape', () => {
  assert.equal(CONTROL.test('/\u0008vitest\u0008/'), true);
  assert.equal(CONTROL.test('/\\bvitest\\b/\t\r\n'), false);
});
