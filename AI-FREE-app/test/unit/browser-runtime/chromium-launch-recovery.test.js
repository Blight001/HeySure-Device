'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FAILURE_CATEGORY,
  classifyChromiumLaunchFailure,
  createChromiumLaunchRecovery,
  getChromiumHandshakeBudget,
} = require('../../../src/app/main/browser-runtime/chromium-launch-recovery');

function failure(code, details = {}) {
  return Object.assign(new Error('launch failed'), { code }, details);
}

test('classifies launch failures without treating a generic process crash as GPU-related', () => {
  assert.equal(classifyChromiumLaunchFailure(failure('CHROMIUM_LAUNCH_CANCELLED')), FAILURE_CATEGORY.CANCELLED);
  assert.equal(classifyChromiumLaunchFailure(failure('BROWSER_RESOURCE_MEMORY_CRITICAL')), FAILURE_CATEGORY.RESOURCE);
  assert.equal(classifyChromiumLaunchFailure(failure('CHROMIUM_PREFLIGHT_FAILED')), FAILURE_CATEGORY.SAFETY);
  assert.equal(classifyChromiumLaunchFailure(failure('CHROMIUM_EXECUTABLE_NOT_FOUND')), FAILURE_CATEGORY.EXECUTABLE_MISSING);
  assert.equal(classifyChromiumLaunchFailure(failure('CHROMIUM_GPU_PROCESS_CRASHED')), FAILURE_CATEGORY.GPU);
  assert.equal(classifyChromiumLaunchFailure(failure('CHROMIUM_PROCESS_EXITED')), FAILURE_CATEGORY.UNKNOWN);
  assert.equal(classifyChromiumLaunchFailure(failure('CHROMIUM_WINDOW_TIMEOUT')), FAILURE_CATEGORY.HANDSHAKE_TIMEOUT);
  assert.equal(classifyChromiumLaunchFailure(failure('CHROMIUM_HWND_ATTACH_FAILED')), FAILURE_CATEGORY.HOST_ATTACHMENT);
});

test('only explicit structured GPU diagnostics enable GPU-safe retry', () => {
  const recovery = createChromiumLaunchRecovery();
  const decision = recovery.decide(failure('CHROMIUM_PROCESS_EXITED'), {
    diagnostics: { processType: 'gpu-process', reason: 'gpu process crashed' },
  });
  assert.equal(decision.retry, true);
  assert.equal(decision.mode, 'gpu-safe');
  assert.deepEqual(decision.launchOverrides.additionalArgs, ['--disable-gpu']);
  assert.equal(decision.cleanupRequired, true);
  assert.equal(decision.requireProcessTreeExit, true);
  assert.equal(decision.requireProfileLockReleased, true);
  assert.equal(decision.requireHostWindowDestroyed, true);
});

test('recovery controller grants at most one retry for one user operation', () => {
  const recovery = createChromiumLaunchRecovery();
  const first = recovery.decide(failure('CHROMIUM_GPU_INIT_FAILED'));
  const second = recovery.decide(failure('CHROMIUM_GPU_INIT_FAILED'));
  assert.equal(first.retry, true);
  assert.equal(first.retryCount, 1);
  assert.equal(second.retry, false);
  assert.equal(second.code, 'CHROMIUM_RETRY_LIMIT_REACHED');
  assert.equal(recovery.retryCount, 1);
});

test('safety, resources, missing runtime, cancellation and unknown failures never retry', () => {
  const cases = [
    failure('CHROMIUM_PREFLIGHT_FAILED'),
    failure('BROWSER_RESOURCE_DISK_CRITICAL'),
    failure('CHROMIUM_EXECUTABLE_NOT_FOUND'),
    failure('CHROMIUM_LAUNCH_CANCELLED'),
    failure('CHROMIUM_PROCESS_EXITED'),
  ];
  for (const error of cases) {
    assert.equal(createChromiumLaunchRecovery().decide(error).retry, false);
  }
});

test('low-spec or cold handshake timeout gets one bounded extended retry while process is alive', () => {
  const lowSpec = createChromiumLaunchRecovery().decide(failure('CHROMIUM_WINDOW_TIMEOUT'), {
    lowSpecMode: true,
    processAlive: true,
  });
  assert.equal(lowSpec.retry, true);
  assert.equal(lowSpec.mode, 'extended-handshake');
  assert.equal(lowSpec.launchOverrides.launchTimeoutMs, 60_000);

  const dead = createChromiumLaunchRecovery().decide(failure('CHROMIUM_WINDOW_TIMEOUT'), {
    coldStart: true,
    processAlive: false,
  });
  assert.equal(dead.retry, false);

  assert.equal(getChromiumHandshakeBudget(), 30_000);
  assert.equal(getChromiumHandshakeBudget({ coldStart: true }), 60_000);
  assert.equal(getChromiumHandshakeBudget({ requestedTimeoutMs: 500_000 }), 90_000);
  assert.equal(getChromiumHandshakeBudget({ coldStart: true, elapsedLaunchMs: 60_000 }), 30_000);

  const exhausted = createChromiumLaunchRecovery().decide(failure('CHROMIUM_WINDOW_TIMEOUT'), {
    lowSpecMode: true,
    processAlive: true,
    elapsedLaunchMs: 88_000,
  });
  assert.equal(exhausted.retry, false);
  assert.equal(exhausted.code, 'CHROMIUM_TOTAL_LAUNCH_BUDGET_EXHAUSTED');
});

test('an explicit cancellation prevents retry even when the failure was otherwise recoverable', () => {
  const result = createChromiumLaunchRecovery().decide(failure('CHROMIUM_GPU_INIT_FAILED'), {
    cancelled: true,
  });
  assert.equal(result.retry, false);
  assert.equal(result.category, FAILURE_CATEGORY.CANCELLED);
  assert.equal(result.code, 'CHROMIUM_RETRY_CANCELLED');
});

test('host attachment failure requests cleanup and a single host rebuild', () => {
  const decision = createChromiumLaunchRecovery().decide(failure('CHROMIUM_HWND_ATTACH_FAILED'));
  assert.equal(decision.retry, true);
  assert.equal(decision.mode, 'rebuild-host');
  assert.equal(decision.launchOverrides.rebuildHostWindow, true);
});
