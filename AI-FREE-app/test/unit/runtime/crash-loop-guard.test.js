'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  EXIT_KIND,
  RECOVERY_ACTION,
  classifyExit,
  createCrashLoopGuard,
} = require('../../../src/app/main/runtime/crash-loop-guard');

function withGuard(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-crash-loop-'));
  let currentTime = 1_000_000;
  const guard = createCrashLoopGuard({
    filePath: path.join(directory, 'crash-loop.json'),
    now: () => currentTime,
  });
  try {
    callback(guard, (value) => { currentTime = value; }, directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('classifies normal, update and abnormal exits explicitly', () => {
  assert.equal(classifyExit({ reason: 'user-quit' }), EXIT_KIND.NORMAL);
  assert.equal(classifyExit({ updating: true }), EXIT_KIND.UPDATE);
  assert.equal(classifyExit({ reason: 'crashed' }), EXIT_KIND.CRASH);
  assert.equal(classifyExit({ exitCode: 0 }), EXIT_KIND.CRASH);
});

test('one abnormal exit within ten minutes allows one automatic recovery', () => {
  withGuard((guard) => {
    const decision = guard.recordExit({ reason: 'crashed' });
    assert.equal(decision.crashCount, 1);
    assert.equal(decision.action, RECOVERY_ACTION.RECOVER);
    assert.equal(decision.autoRecover, true);
    assert.equal(decision.safeMode, false);
  });
});

test('second crash stops automatic recovery and third crash enters safe mode', () => {
  withGuard((guard, setTime) => {
    guard.recordExit({ reason: 'crashed' });
    setTime(1_001_000);
    const second = guard.recordExit({ reason: 'crashed' });
    assert.equal(second.action, RECOVERY_ACTION.STOP);
    assert.equal(second.autoRecover, false);
    assert.equal(second.safeMode, false);

    setTime(1_002_000);
    const third = guard.recordExit({ reason: 'crashed' });
    assert.equal(third.action, RECOVERY_ACTION.SAFE_MODE);
    assert.equal(third.safeMode, true);
    assert.deepEqual(third.safeModePolicy, {
      autoRestoreChromium: false,
      launchClash: false,
      preflightWarmup: false,
      recommendDisableHardwareAcceleration: true,
    });
  });
});

test('normal and update exits are not counted and never request recovery', () => {
  withGuard((guard) => {
    const normal = guard.recordExit({ normal: true });
    const update = guard.recordExit({ reason: 'install-update' });
    assert.equal(normal.crashCount, 0);
    assert.equal(normal.action, RECOVERY_ACTION.STOP);
    assert.equal(update.crashCount, 0);
    assert.equal(update.action, RECOVERY_ACTION.STOP);
  });
});

test('crashes outside the rolling ten-minute window expire', () => {
  withGuard((guard, setTime) => {
    guard.recordExit({ reason: 'crashed' });
    setTime(1_000_000 + (10 * 60 * 1000) + 1);
    const decision = guard.recordExit({ reason: 'crashed' });
    assert.equal(decision.crashCount, 1);
    assert.equal(decision.action, RECOVERY_ACTION.RECOVER);
  });
});

test('state persists across guard instances and corrupt state fails closed without crashing', () => {
  withGuard((guard, setTime, directory) => {
    const filePath = path.join(directory, 'crash-loop.json');
    guard.recordExit({ reason: 'crashed' });
    setTime(1_001_000);
    const restored = createCrashLoopGuard({ filePath, now: () => 1_001_000 });
    assert.equal(restored.inspect().crashCount, 1);

    fs.writeFileSync(filePath, '{broken', 'utf8');
    const recovered = createCrashLoopGuard({ filePath, now: () => 1_002_000 });
    assert.equal(recovered.inspect().crashCount, 0);
    assert.equal(recovered.recordExit({ reason: 'crashed' }).autoRecover, true);
  });
});

test('reset removes recorded crashes', () => {
  withGuard((guard) => {
    guard.recordExit({ reason: 'crashed' });
    guard.reset();
    assert.equal(guard.inspect().crashCount, 0);
  });
});
