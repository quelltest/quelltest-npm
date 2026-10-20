import path from 'node:path';
import { spawnSync } from 'node:child_process';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout;
}

/** Parse `git diff -U0` output into `Map<absolutePath, Array<[start, end]>>` of added/changed lines. */
export function parseDiff(diff, cwd = process.cwd()) {
  const ranges = new Map();
  let file = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? path.resolve(cwd, line.slice(6)) : null;
    } else if (file && line.startsWith('@@')) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(line);
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      if (count > 0) ranges.set(file, [...(ranges.get(file) ?? []), [start, start + count - 1]]);
    }
  }
  return ranges;
}

/** Changed line ranges between the merge-base of `ref` and the working tree. */
export function changedLines(ref, cwd = process.cwd()) {
  if (!ref || ref.startsWith('-')) throw new Error(`invalid git ref: ${ref}`);
  const root = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const base = git(['merge-base', ref, 'HEAD'], cwd).trim();
  return parseDiff(git(['diff', '--unified=0', '--no-color', '--no-ext-diff', base], cwd), root);
}

/** Keep findings whose line span overlaps a changed range. */
export function filterToDiff(findings, ranges, cwd = process.cwd()) {
  return findings.filter((finding) => {
    const spans = ranges.get(path.resolve(cwd, finding.file));
    return spans?.some(([start, end]) => finding.line <= end && finding.endLine >= start);
  });
}
