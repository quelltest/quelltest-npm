import fs from 'node:fs';

export const COMMANDS = ['find', 'score', 'generate', 'verify'];

const FLAGS = new Set(['json', 'sarif', 'all', 'write', 'help', 'version', 'include-tests', 'verify', 'include-covered', 'in-place', 'findings']);
const VALUES = new Set(['threshold', 'top', 'coverage', 'diff', 'source', 'runner', 'destination', 'llm', 'min-score', 'handoff']);
const REPEATABLE = new Set(['include', 'exclude', 'function']);
const ALIASES = { ignore: 'exclude', h: 'help', v: 'version' };

export class UsageError extends Error {}

function integer(name, value, { min = 0 } = {}) {
  const number = Number(value);
  if (value === undefined || value === '' || !Number.isInteger(number) || number < min) throw new UsageError(`--${name} expects an integer >= ${min}, got ${JSON.stringify(value)}`);
  return number;
}

/** Parse argv (without node and script). Accepts `--opt value` and `--opt=value`; throws UsageError. */
export function parseArgs(argv) {
  const options = { include: [], exclude: [], function: [] };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { positionals.push(arg); continue; }
    const [rawName, inline] = arg.replace(/^--?/, '').split(/=(.*)/s);
    const name = ALIASES[rawName] ?? rawName;
    if (FLAGS.has(name)) {
      if (inline !== undefined) throw new UsageError(`--${rawName} does not take a value`);
      options[name] = true;
    } else if (VALUES.has(name) || REPEATABLE.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new UsageError(`--${rawName} requires a value`);
      if (REPEATABLE.has(name)) options[name].push(value);
      else options[name] = value;
    } else throw new UsageError(`unknown option ${arg}`);
  }
  if (options.threshold !== undefined) options.threshold = integer('threshold', options.threshold);
  if (options.top !== undefined) options.top = integer('top', options.top, { min: 1 });
  if (options['min-score'] !== undefined) {
    options['min-score'] = integer('min-score', options['min-score']);
    if (options['min-score'] > 100) throw new UsageError('--min-score expects 0-100');
  }
  const first = positionals[0];
  const command = COMMANDS.includes(first) ? first : 'find';
  const rest = command === first ? positionals.slice(1) : positionals;
  const looksLikePath = (value) => /[\\/]/.test(value) || value.startsWith('.') || /\.[a-z]+$/i.test(value) || fs.existsSync(value);
  if (!COMMANDS.includes(first) && first !== undefined && !looksLikePath(first)) {
    throw new UsageError(`unknown command ${JSON.stringify(first)} (expected ${COMMANDS.join(', ')})`);
  }
  if (rest.length > 1) throw new UsageError(`expected at most one PATH, got ${rest.length}`);
  return { command, root: rest[0] ?? '.', hasPath: rest.length > 0, options };
}
