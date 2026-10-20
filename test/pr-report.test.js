import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, escapeMarkdown } from '../scripts/pr-report.mjs';

test('renders a markdown report with counts and top candidates', () => {
  const md = renderMarkdown({ summary: { score: null }, findings: [{ file: 'a.js', line: 3, category: 'throws', suggestion: 'assert it' }] });
  assert.match(md, /not scored/);
  assert.match(md, /\| throws \| 1 \|/);
  assert.match(md, /a\.js:3/);
});

test('escapes markdown and HTML coming from analysed source', () => {
  const suggestion = 'assert (<img src=x onerror=alert(1)>) `tick`\n# heading';
  const md = renderMarkdown({ findings: [{ file: 'a.js', line: 1, category: 'throws', suggestion }] });
  assert.doesNotMatch(md, /<img/);
  assert.doesNotMatch(md, /\n# heading/);
  assert.equal(escapeMarkdown('a|b'), 'a&#124;b');
});
