'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CrashReporterRuntime } = require('../../../src/app/main/runtime/crash-reporter');

test('main crash reporter persists incidents and delegates upload to an independent watchdog', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-crash-main-test-'));
  const logPath = path.join(tempDir, 'run.log');
  fs.writeFileSync(logPath, 'startup line\nAuthorization: Bearer top-secret\nlast line', 'utf8');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const launches = [];
  const app = new EventEmitter();
  app.getPath = () => tempDir;
  app.getName = () => 'AI-FREE';
  app.getVersion = () => 'test-version';
  app.setPath = () => {};
  app.isPackaged = true;

  const reporter = new CrashReporterRuntime({
    app,
    crashReporter: { start() {} },
    ipcMain: new EventEmitter(),
    launchWatchdog: (options) => { launches.push(options); return 4242; },
    processAlive: (pid) => pid === 4242,
  }).initialize();
  reporter.attachRunLog(logPath);
  reporter.capture('recoverable-error', new Error('token=private-value'), {}, { severity: 'error' });

  let session = JSON.parse(fs.readFileSync(reporter.sessionPath, 'utf8'));
  assert.equal(session.reportedCrash, false, '非致命事件不能掩盖随后发生的原生崩溃');
  reporter.capture('fatal-error', new Error('boom'), { phase: 'test' }, {
    fatal: true,
    marksMainExit: true,
  });
  const result = await reporter.configure({ serverBase: 'https://crash.example.test' });
  session = JSON.parse(fs.readFileSync(reporter.sessionPath, 'utf8'));

  assert.equal(launches.length, 1);
  assert.equal(launches[0].sessionPath, reporter.sessionPath);
  assert.equal(session.watchdogPid, 4242);
  assert.equal(session.serverBase, 'https://crash.example.test');
  assert.equal(session.fatalIncidentRecorded, true);
  assert.equal(result.delegated, true);
  const incidents = fs.readdirSync(reporter.pendingDir).map((name) => (
    JSON.parse(fs.readFileSync(path.join(reporter.pendingDir, name), 'utf8'))
  ));
  assert.equal(incidents.length, 2);
  assert.doesNotMatch(incidents.find((item) => item.type === 'recoverable-error').stack, /private-value/);
  assert.match(incidents.find((item) => item.type === 'recoverable-error').stack, /\[REDACTED\]/);

  reporter.markCleanExit();
  assert.equal(JSON.parse(fs.readFileSync(reporter.sessionPath, 'utf8')).cleanExit, true);
});
