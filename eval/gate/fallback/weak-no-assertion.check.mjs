import test from 'node:test';
import { pageSize, offsetFor } from './unit.mjs';

test('runs the code without asserting anything', () => {
  pageSize({});
  offsetFor(2, 10);
});
