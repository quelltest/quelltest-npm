import fs from 'node:fs';
import path from 'node:path';

export const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', 'scripts']);
const TEST_DIRS = new Set(['test', 'tests', '__tests__', '__mocks__', 'e2e', 'cypress']);
const SKIP_FILE = /(?:\.d\.ts|\.min\.js|\.config\.[cm]?[jt]s|\.stories\.[jt]sx?)$/;
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|^setupTests\.[jt]sx?|^testUtils\.[jt]sx?)$/;

/** Convert a gitignore-style glob (`**`, `*`, `?`) to a RegExp over forward-slash relative paths. */
export function globToRegExp(glob) {
  let pattern = glob.replaceAll('\\', '/').replace(/^\.\//, '');
  if (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
  const anywhere = !pattern.includes('/');
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i += 1;
      if (pattern[i + 1] === '/') {
        i += 1;
        source += '(?:.*/)?';
      } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${source}(?:/.*)?$`);
}

/** True for files under a test directory or named like a test/setup helper. */
export function isTestFile(relative) {
  const parts = relative.split('/');
  return parts.slice(0, -1).some((part) => TEST_DIRS.has(part)) || TEST_FILE.test(parts.at(-1));
}

function readIgnoreFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * List source files below `root` (or `root` itself when it is a file).
 * Tests, config, generated output and `.quellignore` matches are skipped unless asked for.
 */
export function discoverFiles(root, options = {}) {
  const absolute = path.resolve(root);
  if (fs.statSync(absolute).isFile()) return EXTENSIONS.has(path.extname(absolute)) ? [absolute] : [];
  const patterns = [
    ...(options.exclude ?? []),
    ...readIgnoreFile(path.join(absolute, '.quellignore')),
    ...(path.resolve(process.cwd()) === absolute ? [] : readIgnoreFile(path.join(process.cwd(), '.quellignore'))),
  ];
  const excludes = patterns.map(globToRegExp);
  const includes = (options.include ?? []).map(globToRegExp);
  const excluded = (relative) => excludes.some((re) => re.test(relative));
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(absolute, full).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || (!options.includeTests && TEST_DIRS.has(entry.name)) || excluded(relative)) continue;
        visit(full);
      } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
        if (SKIP_FILE.test(entry.name) || (!options.includeTests && TEST_FILE.test(entry.name)) || excluded(relative)) continue;
        if (includes.length && !includes.some((re) => re.test(relative))) continue;
        out.push(full);
      }
    }
  };
  visit(absolute);
  return out.sort();
}
