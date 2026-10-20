import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../scripts/pr-report.mjs';

test('renders a markdown report with counts and top candidates', () => {
  const md = renderMarkdown({ summary: { score: null }, findings: [{ file: 'a.js', line: 3, category: 'throws', suggestion: 'assert it' }] });
  assert.match(md, /not scored/);
  assert.match(md, /\| throws \| 1 \|/);
  assert.match(md, /a\.js:3/);
});
