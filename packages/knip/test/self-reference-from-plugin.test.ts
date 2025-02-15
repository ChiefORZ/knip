import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { main } from '../src/index.js';
import { resolve } from '../src/util/path.js';
import baseArguments from './helpers/baseArguments.js';
import baseCounters from './helpers/baseCounters.js';

const skipIf = typeof Bun !== 'undefined' ? test.skip : test;

const cwd = resolve('fixtures/self-reference-from-plugin');

skipIf('Allows self-references from plugin', async () => {
  const { counters } = await main({
    ...baseArguments,
    cwd,
  });

  assert.deepEqual(counters, {
    ...baseCounters,
    devDependencies: 1,
    processed: 1,
    total: 1,
  });
});

test('Allows self-references from plugin (production)', async () => {
  const { counters } = await main({
    ...baseArguments,
    cwd,
    isProduction: true,
  });

  assert.deepEqual(counters, {
    ...baseCounters,
    processed: 1,
    total: 1,
  });
});

test('Allows self-references from plugin (strict)', async () => {
  const { counters } = await main({
    ...baseArguments,
    cwd,
    isProduction: true,
    isStrict: true,
  });

  assert.deepEqual(counters, {
    ...baseCounters,
    processed: 1,
    total: 1,
  });
});
