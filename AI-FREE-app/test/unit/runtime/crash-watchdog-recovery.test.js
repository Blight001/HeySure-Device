'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CrashWatchdogWorker } = require('../../../src/app/main/runtime/crash-watchdog/worker');

function createFixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-watchdog-recovery-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const restarts = [];
  const diagnostics = [];
  const worker = new CrashWatchdogWorker({
    rootDir,
    sessionPath: path.join(rootDir, 'session.json'),
    restartApplication: (target) => restarts.push(target),
    onDiagnostic: (message) => diagnostics.push(message),
  });
  return { worker, restarts, diagnostics };
}

test('packaged watchdog auto-recovers only the first abnormal exit in the window', (t) => {
  const fixture = createFixture(t);
  const state = { isPackaged: true, appExecutable: 'C:\\AI-FREE\\AI-FREE.exe' };

  assert.equal(fixture.worker.recoverApplicationIfAllowed(state).autoRecover, true);
  assert.equal(fixture.worker.recoverApplicationIfAllowed(state).autoRecover, false);
  assert.equal(fixture.worker.recoverApplicationIfAllowed(state).safeMode, true);

  assert.deepEqual(fixture.restarts, [state.appExecutable]);
  assert.match(fixture.diagnostics.at(-1), /safe-mode/);
});

test('development watchdog never records or restarts an abnormal exit', (t) => {
  const fixture = createFixture(t);

  assert.equal(fixture.worker.recoverApplicationIfAllowed({ isPackaged: false }), null);
  assert.deepEqual(fixture.restarts, []);
});
