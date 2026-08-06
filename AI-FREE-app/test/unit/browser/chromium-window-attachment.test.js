'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  attachChildWindowWithRetry,
} = require('../../../src/app/main/browser-runtime/chromium-window-attachment');

test('HWND attach retries a transient native race and confirms the parent relationship', async () => {
  let attempts = 0;
  const sleeps = [];
  const attached = await attachChildWindowWithRetry({
    attachChildWindow() {
      attempts += 1;
      if (attempts === 1) throw new Error('Chromium HWND was not attached');
      return true;
    },
    isChildWindowAttached: () => attempts >= 2,
  }, { hostHwnd: 'host', childHwnd: 'child' }, {
    attempts: 3,
    delayMs: 25,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.equal(attached, true);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [25]);
});

test('HWND attach returns false after bounded retries', async () => {
  let attempts = 0;
  const warnings = [];
  const attached = await attachChildWindowWithRetry({
    attachChildWindow() { attempts += 1; return false; },
    isChildWindowAttached: () => false,
  }, { hostHwnd: 'host', childHwnd: 'child' }, {
    attempts: 2,
    delayMs: 0,
    sleep: async () => {},
    logger: { warn: (...args) => warnings.push(args) },
  });

  assert.equal(attached, false);
  assert.equal(attempts, 2);
  assert.equal(warnings.length, 1);
});
