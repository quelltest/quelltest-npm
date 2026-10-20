import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = '.github/agents';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const TOOLS = new Set(['execute', 'read', 'edit', 'search', 'agent', 'web', 'todo']);
const SPECIALISTS = ['researcher', 'issue-planner', 'implementer', 'code-reviewer', 'release-manager', 'dependency-triage'];

const agents = fs.readdirSync(dir).filter((name) => name.endsWith('.agent.md')).map((file) => {
  const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, `${file} must start with YAML frontmatter`);
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2];
  }
  return { file, id: file.replace(/\.agent\.md$/, ''), text, fields, body: match[2] };
});
const byId = (id) => agents.find((agent) => agent.id === id);
const toolsOf = (agent) => JSON.parse(agent.fields.tools);

test('the coordinator and every specialist agent exist', () => {
  for (const id of ['maintainer', ...SPECIALISTS]) assert.ok(byId(id), `${id}.agent.md is missing`);
});

test('each agent has a name matching its file, a description, valid tools and a prompt under the 30,000 character limit', () => {
  for (const agent of agents) {
    assert.equal(agent.fields.name, agent.id, `${agent.file}: name must equal the file name`);
    assert.ok((agent.fields.description || '').length >= 60, `${agent.file}: description is required and must say when to use the agent`);
    const tools = toolsOf(agent);
    assert.ok(Array.isArray(tools) && tools.length > 0, `${agent.file}: list the tools explicitly instead of inheriting all of them`);
    for (const tool of tools) assert.ok(TOOLS.has(tool), `${agent.file}: unknown tool ${tool}`);
    assert.ok(agent.body.length < 30000, `${agent.file}: prompt exceeds 30,000 characters`);
  }
});

test('least privilege: reviewers and planners cannot edit, and only the coordinator can call other agents', () => {
  for (const id of ['code-reviewer', 'issue-planner', 'release-manager', 'dependency-triage']) assert.ok(!toolsOf(byId(id)).includes('edit'), `${id} must be read-only`);
  for (const agent of agents) assert.equal(toolsOf(agent).includes('agent'), agent.id === 'maintainer', `${agent.id}: only maintainer may use the agent tool`);
});

test('the coordinator knows every specialist', () => {
  for (const id of SPECIALISTS) assert.match(byId('maintainer').body, new RegExp(`\`${id}\``), `maintainer does not mention ${id}`);
});

test('every agent carries the house rules, so they hold when an agent is used on its own', () => {
  for (const agent of agents) {
    assert.match(agent.body, /Apache-2\.0/, `${agent.id}: licence rule`);
    assert.match(agent.body, /Never add `Co-Authored-By` lines/, `${agent.id}: attribution rule`);
    assert.match(agent.body, /Never merge a pull request, publish to npm, push a tag/, `${agent.id}: no-merge/publish rule`);
    assert.match(agent.body, /open-core/, `${agent.id}: open-core rule`);
    assert.match(agent.body, /shashankbindal/, `${agent.id}: assignee rule`);
  }
});

test('the house rules block is identical in every agent', () => {
  const rules = (agent) => agent.body.slice(agent.body.indexOf('## House rules'));
  const reference = rules(byId('maintainer'));
  assert.ok(reference.length > 200);
  for (const agent of agents) assert.equal(rules(agent), reference, `${agent.id}: house rules drifted from the maintainer's copy`);
});

test('agents only reference npm scripts that exist and do not hard-code the Node range', () => {
  for (const agent of agents) {
    for (const match of agent.body.matchAll(/npm run (\w[\w:-]*)/g)) assert.ok(pkg.scripts[match[1]], `${agent.id}: npm run ${match[1]} does not exist`);
    assert.doesNotMatch(agent.body, /\d+\.\d+\.0 \|\| >=|>=2\d\b/, `${agent.id}: refer to engines.node instead of copying the range, it will go stale`);
  }
});
