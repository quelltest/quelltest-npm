import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('CI workflow covers supported Node versions and package quality checks', () => {
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /node: \[20, 22\]/);
  assert.match(workflow, /npm run test:ci/);
  assert.match(workflow, /npm ci --ignore-scripts/);
});

test('Python quality checks are explicit and conditional', () => {
  const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /detect-python/);
  assert.match(workflow, /find \. -name '\*\.py'/);
  assert.match(workflow, /ruff check \./);
  assert.match(workflow, /flake8 \./);
});
