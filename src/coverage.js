import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LOCATIONS = ['coverage/coverage-final.json', 'coverage/lcov.info'];
const BRANCH_TYPES = new Set(['if', 'cond-expr', 'binary-expr']);

function normalize(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const position = (line, column) => line * 1e6 + column;

/** Parse an Istanbul/nyc/Jest `coverage-final.json` into the per-file model used here. */
export function parseIstanbul(text) {
  const files = new Map();
  for (const [file, data] of Object.entries(JSON.parse(text))) {
    const statements = Object.entries(data.statementMap ?? {}).map(([id, loc]) => ({
      start: position(loc.start.line, loc.start.column), end: position(loc.end.line, loc.end.column ?? 0), hits: data.s?.[id] ?? 0,
    }));
    const branches = Object.entries(data.branchMap ?? {}).filter(([, branch]) => BRANCH_TYPES.has(branch.type)).map(([id, branch]) => ({
      start: position(branch.loc.start.line, branch.loc.start.column), end: position(branch.loc.end.line, branch.loc.end.column ?? 0), counts: data.b?.[id] ?? [],
    }));
    files.set(normalize(file), { statements, branches });
  }
  return { kind: 'istanbul', files };
}

/** Parse `lcov.info`. Line-granular: columns are unknown, so statements span whole lines. */
export function parseLcov(text) {
  const files = new Map();
  let current = null;
  const branchesByLine = new Map();
  const flush = () => {
    if (!current) return;
    for (const [line, counts] of branchesByLine) current.branches.push({ start: position(line, 0), end: position(line, 999999), counts });
    branchesByLine.clear();
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      flush();
      current = { statements: [], branches: [] };
      files.set(normalize(line.slice(3)), current);
    } else if (current && line.startsWith('DA:')) {
      const [number, hits] = line.slice(3).split(',').map(Number);
      current.statements.push({ start: position(number, 0), end: position(number, 999999), hits });
    } else if (current && line.startsWith('BRDA:')) {
      const [number, , , taken] = line.slice(5).split(',');
      const counts = branchesByLine.get(Number(number)) ?? [];
      counts.push(taken === '-' ? 0 : Number(taken));
      branchesByLine.set(Number(number), counts);
    }
  }
  flush();
  return { kind: 'lcov', files };
}

/** Load a coverage file, picking the parser from its name. Throws a readable error on bad input. */
export function loadCoverage(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = /\.json$/i.test(file) ? parseIstanbul(text) : parseLcov(text);
    return { ...parsed, source: file };
  } catch (error) {
    throw new Error(`cannot read coverage file ${file}: ${error.message}`);
  }
}

/** Find a coverage file in the conventional locations below `cwd`, or return null. */
export function detectCoverage(cwd = process.cwd()) {
  const found = DEFAULT_LOCATIONS.map((name) => path.join(cwd, name)).find((candidate) => fs.existsSync(candidate));
  return found ?? null;
}

function isCovered(finding, fileCoverage) {
  const start = position(finding.line, finding.column - 1);
  const end = position(finding.endLine, finding.endColumn ?? 999999);
  if (finding.branch) {
    const enclosing = fileCoverage.branches.filter((b) => b.start <= start && b.end >= start).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    if (enclosing) return enclosing.counts.length > 0 && enclosing.counts.every((count) => count > 0);
  }
  return fileCoverage.statements.some((statement) => statement.hits > 0 && statement.start >= start && statement.start <= end);
}

/**
 * Mark each finding `covered` from real execution data. A branch finding counts as covered only
 * when every side of its branch ran. Files absent from the data count as uncovered (uncertain => uncovered).
 */
export function attachCoverage(findings, coverage, cwd = process.cwd()) {
  return findings.map((finding) => {
    const fileCoverage = coverage.files.get(normalize(path.resolve(cwd, finding.file)));
    return { ...finding, covered: fileCoverage ? isCovered(finding, fileCoverage) : false };
  });
}
