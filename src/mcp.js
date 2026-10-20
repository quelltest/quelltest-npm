import fs from 'node:fs';
import readline from 'node:readline';
import { report, verifyGenerated } from './index.js';
import { gate } from './gate.js';
import { renderHandoff } from './handoff.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const TOOLS = [
  {
    name: 'find',
    description: 'List risk-ranked edge-case candidates in a file or directory (offline, nothing is executed). Use diff to limit to changed lines and coverage to hide candidates your tests already run.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to scan (default ".")' },
        diff: { type: 'string', description: 'Git ref: only candidates on lines changed since its merge-base' },
        coverage: { type: 'string', description: 'coverage-final.json or lcov.info path' },
        top: { type: 'integer', minimum: 1, description: 'How many candidates to return (default 10)' },
      },
    },
  },
  {
    name: 'verify',
    description: 'Prove a test would fail if the code were wrong: run it on the original source, then on mutants of the source file (in an isolated copy); it must fail on at least one. Returns surviving mutants as a handoff you can act on by strengthening the test.',
    inputSchema: {
      type: 'object',
      required: ['test', 'source'],
      properties: {
        test: { type: 'string', description: 'Path of the test file' },
        source: { type: 'string', description: 'Path of the source file the test protects' },
        functions: { type: 'array', items: { type: 'string' }, description: 'Only mutate these functions' },
        runner: { type: 'string', enum: ['node', 'jest', 'vitest', 'mocha'], description: 'Test runner (default: detected from the nearest package.json, else node:test)' },
        min_score: { type: 'integer', minimum: 0, maximum: 100 },
      },
    },
  },
  {
    name: 'gate',
    description: 'Fail when a change weakens the test suite: deleted or skipped tests, removed or loosened assertions, `.only`, changed expected values. Run before declaring work done.',
    inputSchema: {
      type: 'object',
      required: ['diff'],
      properties: {
        diff: { type: 'string', description: 'Git ref to compare against (for example origin/main or HEAD)' },
        strict: { type: 'boolean', description: 'Also fail on changed expected values' },
      },
    },
  },
];

const text = (value, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });

const HANDLERS = {
  find(args) {
    const result = report(args.path ?? '.', { coverage: args.coverage, diff: args.diff });
    const pending = result.summary.coverageEvidence === 'none' ? result.findings : result.findings.filter((item) => !item.covered);
    return text({
      summary: result.summary,
      candidates: pending.slice(0, args.top ?? 10).map(({ file, line, function: fn, category, rule, suggestion, risk }) => ({ file, line, function: fn, category, rule, suggestion, risk })),
      more: Math.max(0, pending.length - (args.top ?? 10)),
    });
  },
  verify(args) {
    const result = verifyGenerated(null, { sourceFile: args.source, testPath: args.test, functions: args.functions, runner: args.runner, minScore: args.min_score });
    const handoff = renderHandoff(result, { sourceText: fs.existsSync(args.source) ? fs.readFileSync(args.source, 'utf8') : '' });
    return text(`${JSON.stringify({ verified: result.verified, reason: result.reason, killed: result.killed, total: result.total, mutationScore: result.mutationScore, isolation: result.isolation, runner: result.runner, runnerSource: result.runnerSource }, null, 2)}\n\n${handoff}`);
  },
  gate(args) {
    return text(gate(args.diff, { strict: Boolean(args.strict) }));
  },
};

/** Handle one JSON-RPC message. Returns the response object, or null for notifications. */
export function handleMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: expected a single JSON-RPC object (batches are not supported)' } };
  }
  const { id, method, params } = message;
  if (typeof method !== 'string') {
    // A response to a request we never sent, or a malformed message: answer only when it has an id to answer to.
    return 'result' in message || 'error' in message || id === undefined ? null : { jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request: missing method' } };
  }
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, messageText) => ({ jsonrpc: '2.0', id, error: { code, message: messageText } });
  if (id === undefined) return null; // notification (for example notifications/initialized)
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'quelltest', version: VERSION } });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const handler = HANDLERS[params?.name];
      if (!handler) return fail(-32602, `unknown tool: ${params?.name}`);
      try {
        return reply(handler(params.arguments ?? {}));
      } catch (error) {
        return reply(text(`quell: ${error.message}`, true));
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

/** Serve MCP over stdio (newline-delimited JSON-RPC). Resolves when stdin closes. */
export function serve(input = process.stdin, output = process.stdout) {
  return new Promise((resolve) => {
    const lines = readline.createInterface({ input });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
        return;
      }
      let response;
      try {
        response = handleMessage(message);
      } catch (error) {
        response = { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: `internal error: ${error.message}` } };
      }
      if (response) output.write(`${JSON.stringify(response)}\n`);
    });
    lines.on('close', resolve);
  });
}
