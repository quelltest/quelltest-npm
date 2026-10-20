import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSource } from '../src/scan.js';

const find = (code, rule) => scanSource(code, 'a.js').findings.filter((f) => f.rule === rule);

test('an unguarded network call is flagged and the message asks for a timeout when none is set', () => {
  const [finding] = find('export async function remoteTotal(url) {\n  const r = await fetch(url);\n  return r.ok;\n}', 'unguarded-network-call');
  assert.ok(finding);
  assert.match(finding.suggestion, /set a timeout or signal/);
  assert.equal(finding.confidence, 'medium');
  for (const call of ['axios.get(url)', 'axios.post(url, body)', 'got(url)', 'ky.get(url)', 'http.get(url, cb)', 'axios(url)']) {
    assert.equal(find(`async function f(url, body, cb) { await ${call}; }`, 'unguarded-network-call').length, 1, call);
  }
});

test('timeouts and signals are recognised in the message', () => {
  const [finding] = find('async function f(url) { await fetch(url, { signal: AbortSignal.timeout(2000) }); }', 'unguarded-network-call');
  assert.doesNotMatch(finding.suggestion, /set a timeout/);
  assert.equal(find('async function f(url) { await axios.get(url, { timeout: 1000 }); }', 'unguarded-network-call')[0].suggestion.includes('set a timeout'), false);
});

test('handled network calls stay quiet: try/catch, .catch chains and async wrappers', () => {
  assert.equal(find('async function f(url) { try { return await fetch(url); } catch { return null; } }', 'unguarded-network-call').length, 0);
  assert.equal(find('function f(url) { return fetch(url).then((r) => r.json()).catch(() => null); }', 'unguarded-network-call').length, 0);
  assert.equal(find('router.get("/x", asyncHandler(async (req, res) => { const r = await fetch(req.query.u); res.json(await r.json()); }));', 'unguarded-network-call').length, 0);
  assert.equal(find('async function f(url) { return await fetch(url); }', 'unguarded-network-call').length, 1);
});

test('deep or indexed reads on a response are flagged; optional chains and shallow reads are not', () => {
  const [finding] = find('function f(res) {\n  return res.data.items[0].plan;\n}', 'deep-response-chain');
  assert.ok(finding);
  assert.equal(finding.line, 2);
  assert.equal(find('function f(res) { return res.data.items[0].plan; }', 'deep-response-chain').length, 1, 'only the outermost read is reported');
  assert.equal(find('function f(res) { return res.data?.items?.[0]?.plan; }', 'deep-response-chain').length, 0);
  assert.equal(find('function f(res) { return res.data.items; }', 'deep-response-chain').length, 0);
  assert.equal(find('function f(res) { res.data.items[0] = 1; }', 'deep-response-chain').length, 0);
  assert.equal(find('function f(res) { return response.a.b.c.d; }', 'deep-response-chain').length, 1);
  assert.equal(find('function f(config) { return config.a.b.c.d; }', 'deep-response-chain').length, 0, 'only response-like roots');
});
