'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let shuttingDown = false;
let runtimePrep = null;
let executable = null;
let configResult = null;
let controlReady = true;
let ruleResult = { ok: true, changed: false };
let spawnImpl = null;
const purges = [];
const debugLogs = [];

const contextPath = require.resolve('../../../src/app/main/runtime/app-context');
const assetsPath = require.resolve('../../../src/app/main/features/network/clash-mini-assets');
const controlPath = require.resolve('../../../src/app/main/features/network/clash-mini-control');
const configPath = require.resolve('../../../src/app/main/features/network/clash-mini-config');
const debugPath = require.resolve('../../../src/app/main/runtime/debug-console-log');
const targetPath = require.resolve('../../../src/app/main/features/network/clash-mini-process');

require.cache[contextPath] = { exports: { appContext: { isShuttingDown: () => shuttingDown } } };
require.cache[assetsPath] = { exports: {
  getClashMiniRuntimeRoot: () => 'fixture-runtime',
  resolveClashMiniExecutable: () => executable,
  prepareClashMiniRuntimeDirAsync: async () => runtimePrep,
  purgeClashMiniRuntimeConfigFiles: (dir) => { purges.push(dir); return { ok: true, removed: ['config.yaml'], failed: [] }; },
} };
require.cache[controlPath] = { exports: {
  waitForClashMiniControlApi: async () => controlReady,
  ensureClashMiniRuleMode: async () => ruleResult,
} };
require.cache[configPath] = { exports: { ensureClashMiniRuntimeConfig: () => configResult } };
require.cache[debugPath] = { exports: { writeDebugConsoleOnly: (...args) => debugLogs.push(args) } };
const childProcess = require('node:child_process');
childProcess.spawn = (...args) => spawnImpl(...args);
delete require.cache[targetPath];
const processService = require(targetPath);

class FakeProcess extends EventEmitter {
  constructor(pid = 4321) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0, null);
    this.emit('close', 0, null);
    return true;
  }
}

function createUi() {
  const messages = [];
  const proxyChanges = [];
  return {
    messages,
    proxyChanges,
    sendToSide: (...args) => messages.push(args),
    applyClashMiniBrowserProxy: async (enabled) => { proxyChanges.push(enabled); return { ok: true, updated: 2 }; },
  };
}

test.beforeEach(async () => {
  shuttingDown = false;
  runtimePrep = { ok: true, runtimeDir: 'fixture-runtime', assetSync: { ok: true } };
  executable = path.join('fixture-runtime', 'verge-mihomo.exe');
  configResult = { ok: true, configPath: path.join('fixture-runtime', 'config.yaml') };
  controlReady = true;
  ruleResult = { ok: true, changed: false };
  spawnImpl = () => new FakeProcess();
  purges.length = 0;
  debugLogs.length = 0;
  await processService.stopClashMiniProcess(null, { waitForPendingStart: false });
});

test('process state helpers and exit waiter handle already-exited and event-driven children', async () => {
  assert.equal(processService.hasClashMiniProcessExited(null), true);
  const exited = new FakeProcess();
  exited.exitCode = 1;
  assert.equal(processService.hasClashMiniProcessExited(exited), true);
  assert.equal(await processService.waitForClashMiniProcessExit(exited, 10), true);
  const pending = new FakeProcess();
  setImmediate(() => { pending.exitCode = 0; pending.emit('close', 0); });
  assert.equal(await processService.waitForClashMiniProcessExit(pending, 100), true);
  const stuck = new FakeProcess();
  assert.equal(await processService.waitForClashMiniProcessExit(stuck, 5), false);
});

test('network request logs stay debug-only while lifecycle logs reach the sidebar', () => {
  const ui = createUi();
  assert.equal(processService.isClashMiniNetworkRequestLog('[TCP] example.test', { stream: 'stdout' }), true);
  assert.equal(processService.isClashMiniNetworkRequestLog('[DNS] example.test'), false);
  const request = processService.emitClashMiniLog(ui, 'info', '[TCP] example.test', { stream: 'stdout' });
  assert.equal(request.text, '[TCP] example.test');
  assert.equal(debugLogs.length, 1);
  assert.equal(ui.messages.length, 0);
  processService.emitClashMiniLog(ui, 'warn', 'warning');
  processService.emitClashMiniLog(ui, 'error', 'failure');
  assert.equal(ui.messages.filter(([channel]) => channel === 'clash-mini-log').length, 2);
});

test('cancelled and preflight failures return stable results without spawning', async () => {
  const ui = createUi();
  shuttingDown = true;
  const cancelled = await processService.startClashMiniProcessOnce(ui);
  assert.equal(cancelled.cancelled, true);
  shuttingDown = false;

  runtimePrep = { ok: false, error: 'assets unavailable' };
  assert.equal((await processService.startClashMiniProcessOnce(ui)).error, 'assets unavailable');
  runtimePrep = { ok: true, runtimeDir: 'fixture-runtime', assetSync: { ok: false, missing: ['geo.dat'] } };
  configResult = { ok: false, error: 'config invalid' };
  assert.equal((await processService.startClashMiniProcessOnce(ui)).error, 'config invalid');
  configResult = { ok: true };
  executable = null;
  assert.equal((await processService.startClashMiniProcessOnce(ui)).error, '未找到 verge-mihomo.exe');
  assert.ok(ui.messages.some(([, entry]) => entry?.text?.includes('Geo/规则资产缺失')));
});

test('successful start streams logs, reuses running core and stops cleanly', async () => {
  const ui = createUi();
  const child = new FakeProcess(9876);
  spawnImpl = (command, args, options) => {
    assert.equal(command, executable);
    assert.deepEqual(args, ['-d', 'fixture-runtime']);
    assert.equal(options.cwd, 'fixture-runtime');
    return child;
  };
  const first = await processService.startClashMiniProcess(ui);
  assert.equal(first.ok, true);
  assert.equal(first.started, true);
  assert.equal(first.pid, 9876);
  child.stdout.emit('data', 'core ready');
  child.stderr.emit('data', 'minor warning');
  const again = await processService.startClashMiniProcessOnce(ui);
  assert.equal(again.alreadyRunning, true);
  assert.equal(processService.isClashMiniProcessRunning(), true);

  const runtimeConfigs = [];
  processService.setRuntimeLicenseCache({ setRuntimeConfig: (value) => runtimeConfigs.push(value) });
  const stopped = await processService.stopClashMiniProcess(ui);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);
  assert.equal(child.killed, true);
  assert.deepEqual(runtimeConfigs, [{ systemProxyEnabled: false }]);
  assert.ok(ui.proxyChanges.includes(false));
});

test('control and rule-mode failures stop unhealthy spawned processes', async () => {
  const ui = createUi();
  let child = new FakeProcess();
  spawnImpl = () => child;
  controlReady = false;
  const unavailable = await processService.startClashMiniProcessOnce(ui);
  assert.equal(unavailable.controlApiReady, false);
  assert.equal(child.killed, true);

  controlReady = true;
  ruleResult = { ok: false, error: 'rule rejected' };
  child = new FakeProcess();
  const rejected = await processService.startClashMiniProcessOnce(ui);
  assert.equal(rejected.controlApiReady, true);
  assert.equal(child.killed, true);
});

test('spawn exceptions are contained and no-process stop still clears browser proxy', async () => {
  const ui = createUi();
  spawnImpl = () => { throw new Error('spawn failed'); };
  const failed = await processService.startClashMiniProcessOnce(ui);
  assert.deepEqual({ ok: failed.ok, error: failed.error }, { ok: false, error: 'spawn failed' });
  const stopped = await processService.stopClashMiniProcessOnce(ui);
  assert.equal(stopped.stopped, false);
  assert.deepEqual(ui.proxyChanges, [false]);
});

test('cleanup delegates only for existing runtime directories', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-process-cleanup-'));
  try {
    assert.deepEqual(processService.cleanupClashMiniRuntimeConfig(''), { ok: true, removed: [], failed: [] });
    assert.deepEqual(processService.cleanupClashMiniRuntimeConfig(path.join(temp, 'missing')), { ok: true, removed: [], failed: [] });
    assert.equal(processService.cleanupClashMiniRuntimeConfig(temp).ok, true);
    assert.deepEqual(purges, [temp]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
