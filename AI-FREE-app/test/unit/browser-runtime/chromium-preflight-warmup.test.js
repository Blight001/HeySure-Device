'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  startChromiumPreflightWarmup,
  waitForChromiumPreflightWarmup,
} = require('../../../src/app/main/browser-runtime/chromium-preflight-warmup');

test('background preflight is shared with a launch that starts while it is running', async () => {
  let finishWorker;
  let workerCalls = 0;
  let primed = null;
  const executablePath = `C:\\runtime-${process.pid}-shared\\ai-free-browser.exe`;
  const runWorker = () => {
    workerCalls += 1;
    return new Promise((resolve) => { finishWorker = resolve; });
  };
  const dependencies = {
    resolveExecutable: () => executablePath,
    runWorker,
    prime: (options, result) => { primed = { options, result }; },
  };
  const first = startChromiumPreflightWarmup({ cacheFile: 'cache.json' }, dependencies);
  const second = startChromiumPreflightWarmup({ cacheFile: 'cache.json' }, dependencies);
  const launchWait = waitForChromiumPreflightWarmup(executablePath);

  assert.strictEqual(second, first);
  assert.strictEqual(launchWait, first);
  assert.equal(workerCalls, 1);
  finishWorker({ sandboxAccess: { ok: true }, preflight: { ok: true, checks: [] } });
  await first;
  assert.equal(primed.options.executablePath, executablePath);
  assert.equal(primed.result.ok, true);
});

test('background preflight failure remains retryable by the normal launch path', async () => {
  const warnings = [];
  const result = await startChromiumPreflightWarmup({
    logger: { warn: (message) => warnings.push(message) },
  }, {
    resolveExecutable: () => `C:\\runtime-${process.pid}-failure\\ai-free-browser.exe`,
    runWorker: async () => { throw new Error('worker unavailable'); },
  });

  assert.equal(result, null);
  assert.match(warnings[0], /打开时重试/);
});
