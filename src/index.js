import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generate } from './generator.js';
import { verifyGenerated } from './verification.js';

const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

function candidateId(file, line, category, evidence) {
  return crypto.createHash('sha1').update(`${file}:${line}:${category}:${evidence}`).digest('hex').slice(0, 12);
}

function filesIn(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.quelltest') continue;
      if (entry.isDirectory() && !SKIP.has(entry.name)) visit(path.join(dir, entry.name));
      if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) out.push(path.join(dir, entry.name));
    }
  };
  visit(root);
  return out.sort();
}

function finding(file, line, category, evidence, suggestion) {
  return { id: candidateId(file, line, category, evidence), file, line, column: 1, category, evidence, suggestion };
}

export function scan(root = '.') {
  const absolute = path.resolve(root);
  const findings = [];
  for (const file of filesIn(absolute)) {
    const relative = path.relative(process.cwd(), file).replaceAll('\\', '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, index) => {
      const line = index + 1;
      if (/\bthrow\s+new\s+(?:Error|[A-Z][\w$]*Error)\b/.test(text)) findings.push(finding(relative, line, 'throws', text.trim(), 'assert the error type and message'));
      if (/\bif\s*\([^)]*(?:<=|>=|===|!==|==|!=|<|>)[^)]*\)/.test(text)) findings.push(finding(relative, line, 'boundary', text.trim(), 'test the boundary and its adjacent values'));
      if (/[?][.?]|\b(?:null|undefined)\b/.test(text) && /\?|null|undefined/.test(text)) findings.push(finding(relative, line, 'nullish', text.trim(), 'test null, undefined, and the populated path'));
      if (/\b(?:@throws|@param|@example)\b/.test(text)) findings.push(finding(relative, line, 'jsdoc', text.trim(), 'turn the documented contract into an executable test'));
      if (/\b(?:safeParse|parse|object|array|string|number|boolean)\s*\(/.test(text) && /(?:zod|z\.|v\.|arktype)/i.test(lines.slice(Math.max(0, index - 3), index + 1).join(' '))) findings.push(finding(relative, line, 'schema', text.trim(), 'test accepted, rejected, and boundary-shaped input'));
      if (/\b(?:async\s+function|await\s+|Promise\.)/.test(text)) findings.push(finding(relative, line, 'async', text.trim(), 'test resolve and reject behavior'));
    });
  }
  return { version: 1, root: absolute, findings: [...new Map(findings.map((item) => [item.id, item])).values()] };
}

export function score(report) {
  const total = report.findings.length;
  const covered = report.findings.filter((item) => item.status === 'WRITTEN').length;
  const verified = report.findings.filter((item) => item.verified).length;
  const value = total === 0 ? 100 : Math.round(((covered + verified * 0.5) / total) * 100);
  return { score: Math.min(100, value), tier: value >= 80 ? 'production-ready' : value >= 60 ? 'review-needed' : 'edge-cases-uncovered', total, covered, verified };
}

export function report(root = '.') {
  const result = scan(root);
  result.summary = score(result);
  return result;
}

export { generate };
export { verifyGenerated };
