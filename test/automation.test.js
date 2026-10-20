import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = '.github/workflows';
const workflows = fs.readdirSync(dir).filter((name) => name.endsWith('.yml')).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
const agents = workflows.filter(([name]) => name.startsWith('agent-'));

test('the automation agents exist', () => {
  for (const name of ['agent-claude', 'agent-pr-review', 'agent-triage', 'agent-pr-guard', 'agent-release', 'agent-stale']) assert.ok(agents.some(([file]) => file === `${name}.yml`), name);
  for (const file of ['.github/dependabot.yml', '.github/CODEOWNERS', '.github/pull_request_template.md', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', 'docs/automation.md']) assert.ok(fs.existsSync(file), file);
});

test('every workflow declares least-privilege permissions and pins its actions', () => {
  for (const [name, text] of workflows) {
    assert.match(text, /^permissions:/m, `${name} must declare permissions`);
    for (const match of text.matchAll(/uses:\s*([^\s#]+)/g)) assert.match(match[1], /@(?:v\d+|[0-9a-f]{40})$/, `${name}: ${match[1]} is not pinned`);
  }
});

test('no workflow runs untrusted pull-request code with a privileged token', () => {
  for (const [name, text] of workflows) assert.doesNotMatch(text, /pull_request_target/, `${name} must not use pull_request_target`);
});

test('the Claude agents are opt-in, skip forks, restrict tools and forbid publishing and attribution', () => {
  for (const name of ['agent-claude.yml', 'agent-pr-review.yml']) {
    const text = agents.find(([file]) => file === name)[1];
    assert.match(text, /vars\.CLAUDE_AGENTS_ENABLED == 'true'/, `${name} must stay off until enabled`);
    assert.match(text, /--allowedTools/, `${name} must restrict tools`);
    assert.match(text, /anthropics\/claude-code-action@v1/);
    assert.match(text, /timeout-minutes:/);
  }
  assert.match(agents.find(([file]) => file === 'agent-pr-review.yml')[1], /head\.repo\.full_name == github\.repository/);
  const claude = agents.find(([file]) => file === 'agent-claude.yml')[1];
  assert.match(claude, /never add Co-Authored-By/);
  assert.match(claude, /do not publish to npm or merge/);
});

test('the PR guard fails a pull request that does not target the default branch', () => {
  const text = agents.find(([file]) => file === 'agent-pr-guard.yml')[1];
  assert.match(text, /github\.base_ref/);
  assert.match(text, /default_branch/);
  assert.match(text, /exit 1/);
});

test('the release agent checks the tag, runs CI, and publishes only with a token', () => {
  const text = agents.find(([file]) => file === 'agent-release.yml')[1];
  assert.match(text, /tags:\s*\["v\*"\]/);
  assert.match(text, /does not match package\.json version/);
  assert.match(text, /npm run test:ci/);
  assert.match(text, /secrets\.NPM_TOKEN/);
  assert.match(text, /npm view "quelltest@\$VERSION"/, 'must not republish an existing version');
  assert.match(text, /--provenance/);
});

test('the release notes extraction finds the changelog section of the current version', (t) => {
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const run = spawnSync('awk', ['-v', `v=${version}`, '$0 == "## " v {found=1; next} /^## / {found=0} found', 'CHANGELOG.md'], { encoding: 'utf8' });
  if (run.error) return t.skip('awk is not available');
  assert.ok(run.stdout.trim().length > 20, `no CHANGELOG section for ${version}`);
  assert.doesNotMatch(run.stdout, /^## /m, 'must stop at the next version heading');
});

test('the recommended branch protection is valid, blocks force pushes and deletion, and requires existing CI checks', () => {
  const rules = JSON.parse(fs.readFileSync('.github/branch-protection.json', 'utf8'));
  assert.equal(rules.allow_force_pushes, false);
  assert.equal(rules.allow_deletions, false);
  assert.equal(rules.enforce_admins, false);
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  for (const context of rules.required_status_checks.contexts) {
    if (context === 'python-quality') {
      assert.match(ci, /python-quality:/);
      continue;
    }
    const [, node, os] = /^test \(node (\d+), (.+)\)$/.exec(context);
    assert.match(ci, new RegExp(`node: \\[[^\\]]*\\b${node}\\b`), `${context}: node ${node} is not in the matrix`);
    assert.ok(ci.includes(os), `${context}: ${os} is not in the matrix`);
  }
  assert.ok(!rules.required_status_checks.contexts.some((context) => /macos/.test(context)), 'macOS is not required while its runners are unreliable');
});

test('the triage agent only labels from conventional-commit titles and skips fork PRs', () => {
  const text = agents.find(([file]) => file === 'agent-triage.yml')[1];
  assert.match(text, /\(feat\|fix\|docs\|test\|chore\|design\|refactor\|perf\)/);
  assert.match(text, /head\.repo\.full_name == github\.repository/);
});
