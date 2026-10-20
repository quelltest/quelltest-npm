import test from 'node:test';
import assert from 'node:assert/strict';
import { slug, load } from './unit.mjs';

test('slug coerces, lowercases and replaces separators', () => {
  assert.equal(slug(12), '12');
  assert.equal(slug('A b'), 'a-b');
  assert.equal(slug('x/../y'), 'x-y');
});

test('load awaits the lookup and falls back to null', async () => {
  assert.equal(await load({ get: async (k) => ({ k }) }, 'A b').then((row) => row.k), 'a-b');
  assert.equal(await load({ get: async () => undefined }, 'a'), null);
  assert.equal(await load({ get: async () => 0 }, 'a'), 0);
});
