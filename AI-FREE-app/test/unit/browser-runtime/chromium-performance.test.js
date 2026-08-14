'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createChromiumPerformanceSpan } = require('../../../src/app/main/browser-runtime/chromium-performance');

test('Chromium performance span reports phase and total durations without profile data', () => {
  const messages = [];
  const ticks = [0n, 2_000_000n, 5_000_000n, 9_000_000n];
  const span = createChromiumPerformanceSpan(
    { info: (message) => messages.push(message) },
    'launch',
    { now: () => ticks.shift() },
  );

  span.mark('prepare');
  span.mark('spawn');
  span.finish();

  assert.equal(messages.length, 1);
  assert.match(messages[0], /operation=launch outcome=ok totalMs=9\.0/);
  assert.match(messages[0], /prepareMs=2\.0 spawnMs=3\.0/);
});

test('Chromium performance span records only a bounded error code on failure', () => {
  const messages = [];
  const ticks = [0n, 1_000_000n];
  const span = createChromiumPerformanceSpan(
    { info: (message) => messages.push(message) },
    'stop',
    { now: () => ticks.shift() },
  );

  span.fail({ code: 'CHROMIUM_EXIT_TIMEOUT', message: 'sensitive profile detail' });

  assert.match(messages[0], /outcome=failed totalMs=1\.0/);
  assert.match(messages[0], /error=CHROMIUM_EXIT_TIMEOUT/);
  assert.doesNotMatch(messages[0], /sensitive profile detail/);
});
