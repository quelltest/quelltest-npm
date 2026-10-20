import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Neutralise markdown/HTML from analysed source (thrown messages, file names) before it lands in a PR comment. */
export function escapeMarkdown(text) {
  return String(text).replace(/[\r\n]+/g, ' ').replace(/[&<>`|\\*_[\]]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Render a quelltest JSON report as a Markdown PR comment. */
export function renderMarkdown(report, limit = 10) {
  const findings = report.findings ?? [];
  const summary = report.summary ?? {};
  const counts = new Map();
  for (const item of findings) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  const lines = ['## Quelltest report', ''];
  lines.push(`**${findings.length}** edge-case candidates · score: ${summary.score == null ? 'not scored' : `${summary.score}/100`} · coverage evidence: ${summary.coverageEvidence ?? 'none'}`, '');
  if (counts.size) {
    lines.push('| Category | Candidates |', '| --- | --- |');
    for (const [category, count] of [...counts].sort((a, b) => b[1] - a[1])) lines.push(`| ${category} | ${count} |`);
    lines.push('');
    lines.push(`<details><summary>Top ${Math.min(limit, findings.length)} candidates</summary>`, '');
    for (const item of findings.slice(0, limit)) lines.push(`- <code>${escapeMarkdown(`${item.file}:${item.line}`)}</code> <b>${escapeMarkdown(item.category)}</b> — ${escapeMarkdown(item.suggestion)}`);
    lines.push('', '</details>', '');
  }
  lines.push('_Candidates are review hints, not proof of defects._');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/pr-report.mjs <report.json>'); process.exit(2); }
  console.log(renderMarkdown(JSON.parse(fs.readFileSync(file, 'utf8'))));
}
