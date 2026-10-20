import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Resolve symlinks and 8.3 short names so paths from git and from the scanner compare equal (case-insensitive on Windows). */
export function canonicalPath(file) {
  let resolved = path.resolve(file);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // deleted or not yet created: fall back to the lexical path
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function git(args, cwd) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout;
}

/** Parse `git diff -U0` output into `Map<absolutePath, Array<[start, end]>>` of added/changed lines. */
export function parseDiff(diff, cwd = process.cwd()) {
  const ranges = new Map();
  let file = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? canonicalPath(path.resolve(cwd, line.slice(6).replace(/	.*$/, ''))) : null;
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
  const ranges = parseDiff(git(['diff', '--unified=0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', base], cwd), root);
  // `git diff` ignores untracked files; a brand-new file is entirely "changed".
  for (const name of git(['ls-files', '--others', '--exclude-standard'], root).split(/\r?\n/).filter(Boolean)) {
    ranges.set(canonicalPath(path.resolve(root, name)), [[1, Number.MAX_SAFE_INTEGER]]);
  }
  return ranges;
}

/** Keep findings whose line span overlaps a changed range. */
export function filterToDiff(findings, ranges, cwd = process.cwd()) {
  return findings.filter((finding) => {
    const spans = ranges.get(canonicalPath(path.resolve(cwd, finding.file)));
    return spans?.some(([start, end]) => finding.line <= end && finding.endLine >= start);
  });
}
