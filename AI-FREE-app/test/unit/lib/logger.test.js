'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { appContext } = require('../../../src/app/main/runtime/app-context');
const {
  createLogger,
  initializeRunFileLogger,
  installShutdownUncaughtExceptionGuard,
  isExpectedShutdownNetworkError,
} = require('../../../src/app/main/utils/logger');

test('renderer logger sends only to live web contents and accepts mixed values', () => {
  const sent = [];
  let destroyed = false;
  const logger = createLogger({
    getSideWebContents: () => ({
      isDestroyed: () => destroyed,
      send: (...args) => sent.push(args),
    }),
  });
  logger.sendToSide('status', { ok: true }, 3);
  assert.deepEqual(sent, [['status', { ok: true }, 3]]);
  destroyed = true;
  logger.sendToSide('late', 'ignored');
  assert.equal(sent.length, 1);
  assert.doesNotThrow(() => logger.log('Fixture', 'text', 1, true, { nested: 'value' }, new Error('problem')));
});

test('shutdown guard is idempotent and only swallows expected reset failures', () => {
  const handlers = [];
  const processRef = { prependListener: (event, handler) => handlers.push([event, handler]) };
  assert.equal(installShutdownUncaughtExceptionGuard({ processRef }), true);
  assert.equal(installShutdownUncaughtExceptionGuard({ processRef }), false);
  assert.equal(handlers[0][0], 'uncaughtException');

  appContext.setShuttingDown(false);
  assert.equal(isExpectedShutdownNetworkError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), false);
  appContext.setShuttingDown(true);
  assert.equal(isExpectedShutdownNetworkError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isExpectedShutdownNetworkError(new Error('socket ECONNRESET while closing')), true);
  assert.equal(isExpectedShutdownNetworkError(new Error('permission denied')), false);
  assert.doesNotThrow(() => handlers[0][1](Object.assign(new Error('reset'), { code: 'ECONNRESET' })));
  assert.throws(() => handlers[0][1](new Error('unexpected')), /unexpected/);
  appContext.setShuttingDown(false);
});

test('run file logger writes levels, strips ANSI and restores console on close', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-run-logger-'));
  const originalConsoleLog = console.log;
  try {
    const runtime = initializeRunFileLogger({
      app: { getPath: () => root, getName: () => 'fixture-app' },
      dirName: 'diagnostics',
      prefix: 'fixture',
    });
    assert.match(runtime.logFilePath, /diagnostics[\\/]fixture-/);
    console.info('\u001b[31mred\u001b[0m', { ok: true });
    console.warn('warning-line');
    runtime.writeLine('debug', 'debug-line');
    runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(console.log.name, 'bound log');
    const content = fs.readFileSync(runtime.logFilePath, 'utf8');
    assert.match(content, /red \{ ok: true \}/);
    assert.doesNotMatch(content, /\u001b\[/);
    assert.match(content, /warning-line/);
    assert.match(content, /debug-line/);
    assert.equal(initializeRunFileLogger(), runtime);
  } finally {
    console.log = originalConsoleLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
