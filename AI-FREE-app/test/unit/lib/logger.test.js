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
  pruneRunLogs,
} = require('../../../src/app/main/utils/logger');

function writeRunLog(dir, name, size, mtimeMs) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x'.repeat(size));
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

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

test('run log cleanup enforces age, count and total size without touching foreign logs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-run-cleanup-'));
  const now = Date.now();
  try {
    const newest = writeRunLog(root, 'run-2026-08-14T10-00-00-000Z-1.log', 20, now - 1000);
    const overBytes = writeRunLog(root, 'run-2026-08-14T09-00-00-000Z-2.log', 20, now - 2000);
    const overCount = writeRunLog(root, 'run-2026-08-14T08-00-00-000Z-3.log', 5, now - 3000);
    const expired = writeRunLog(root, 'run-2026-07-01T08-00-00-000Z-4.log', 5, now - 100000);
    const chromiumLog = writeRunLog(root, 'chromium-runtime.log', 5, now - 100000);
    const diagnosticLog = writeRunLog(root, 'diagnostic-2026-08-14.log', 5, now - 100000);
    const malformedRunLog = writeRunLog(root, 'run-manual.log', 5, now - 100000);

    const result = pruneRunLogs(root, 'run', {
      maxAgeMs: 50000,
      maxFiles: 2,
      maxTotalBytes: 30,
    }, { now });

    assert.deepEqual(result.failed, []);
    assert.equal(fs.existsSync(newest), true);
    assert.equal(fs.existsSync(overBytes), false);
    assert.equal(fs.existsSync(overCount), false);
    assert.equal(fs.existsSync(expired), false);
    assert.equal(fs.existsSync(chromiumLog), true);
    assert.equal(fs.existsSync(diagnosticLog), true);
    assert.equal(fs.existsSync(malformedRunLog), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run log cleanup reports deletion failures and continues', () => {
  const errors = [];
  const fakeFs = {
    readdirSync: () => [{ name: 'run-2026-08-14T10-00-00-000Z-1.log', isFile: () => true }],
    statSync: () => ({ mtimeMs: 0, size: 10 }),
    unlinkSync: () => { throw new Error('locked'); },
  };
  const result = pruneRunLogs('C:\\logs', 'run', { maxAgeMs: 1 }, {
    fs: fakeFs,
    now: 100,
    onError: (error) => errors.push(error.message),
  });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.failed, ['run-2026-08-14T10-00-00-000Z-1.log']);
  assert.deepEqual(errors, ['locked']);
});

test('run file logger caps file size, strips ANSI and restores console on close', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-run-logger-'));
  const originalConsoleLog = console.log;
  try {
    const runtime = initializeRunFileLogger({
      app: { getPath: () => root, getName: () => 'fixture-app' },
      dirName: 'diagnostics',
      prefix: 'fixture',
      limits: { maxFileBytes: 2048 },
    });
    assert.match(runtime.logFilePath, /diagnostics[\\/]fixture-/);
    console.info('\u001b[31mred\u001b[0m', { ok: true });
    console.warn('warning-line');
    runtime.writeLine('debug', 'debug-line');
    runtime.writeLine('info', 'x'.repeat(4096));
    runtime.writeLine('info', 'must-not-reach-file');
    runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(console.log.name, 'bound log');
    const content = fs.readFileSync(runtime.logFilePath, 'utf8');
    assert.match(content, /red \{ ok: true \}/);
    assert.doesNotMatch(content, /\u001b\[/);
    assert.match(content, /warning-line/);
    assert.match(content, /debug-line/);
    assert.match(content, /文件已达到容量上限/);
    assert.doesNotMatch(content, /must-not-reach-file/);
    assert.ok(fs.statSync(runtime.logFilePath).size <= 2048);
    assert.equal(initializeRunFileLogger(), runtime);
  } finally {
    console.log = originalConsoleLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
