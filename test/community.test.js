import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (file) => fs.readFileSync(file, 'utf8');
const pkg = JSON.parse(read('package.json'));
const COMMUNITY = ['README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'SUPPORT.md', 'GOVERNANCE.md', 'docs/architecture.md', 'docs/automation.md', 'docs/agents.md'];

test('the open-source project files exist', () => {
  for (const file of [...COMMUNITY, 'LICENSE', 'NOTICE', 'CHANGELOG.md', '.editorconfig', '.gitattributes', '.github/CODEOWNERS', '.github/pull_request_template.md']) assert.ok(fs.existsSync(file), file);
});

test('the Code of Conduct is Contributor Covenant 2.1 with a working contact', () => {
  const text = read('CODE_OF_CONDUCT.md');
  assert.match(text, /Contributor Covenant Code of Conduct/);
  assert.match(text, /version\/2\/1\/code_of_conduct/);
  assert.match(text, /conduct@quelltest\.com/);
  assert.doesNotMatch(text, /\[INSERT CONTACT METHOD\]/);
});

test('the security policy gives a private channel, a scope and a disclosure timeline', () => {
  const text = read('SECURITY.md');
  assert.match(text, /security\/advisories\/new/);
  assert.match(text, /security@quelltest\.com/);
  assert.match(text, /Do not open a public issue/i);
  assert.match(text, /90 days/);
  assert.match(text, /What is not a vulnerability/);
});

test('every relative link in the community docs points at a file that exists', () => {
  for (const file of COMMUNITY) {
    for (const match of read(file).matchAll(/\]\((?!https?:|mailto:|#)([^)#\s]+)(?:#[^)]*)?\)/g)) {
      assert.ok(fs.existsSync(path.join(path.dirname(file), match[1])), `${file} links to missing ${match[1]}`);
    }
  }
});

test('CONTRIBUTING only mentions npm scripts that exist and the licence the package declares', () => {
  const text = read('CONTRIBUTING.md');
  for (const match of text.matchAll(/npm run (\w[\w:-]*)/g)) assert.ok(pkg.scripts[match[1]], `npm run ${match[1]} does not exist`);
  assert.match(text, /Apache License 2\.0/);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.match(text, /Node\.js 20/);
  assert.equal(pkg.engines.node, '>=20');
});

test('the architecture doc describes modules that exist', () => {
  const text = read('docs/architecture.md');
  const modules = [...text.matchAll(/`([a-z-]+)\.js`/g)].map((match) => match[1]);
  assert.ok(modules.length >= 15);
  for (const name of new Set(modules)) {
    if (name === 'index') continue;
    assert.ok(fs.existsSync(`src/${name}.js`), `docs/architecture.md names src/${name}.js, which does not exist`);
  }
});

test('the README points at the community files', () => {
  const text = read('README.md');
  for (const file of ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'SUPPORT.md', 'GOVERNANCE.md']) assert.ok(text.includes(`(${file})`), `README does not link ${file}`);
});

test('line endings and editor settings are normalised', () => {
  assert.match(read('.gitattributes'), /\* text=auto eol=lf/);
  assert.match(read('.editorconfig'), /end_of_line = lf/);
});
