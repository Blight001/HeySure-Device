'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildWatchdogEnvironment,
  launchCrashWatchdog,
} = require('../../../src/app/main/runtime/crash-watchdog/launcher');

test('watchdog launcher creates a detached hidden Node-mode process', () => {
  const calls = [];
  let unrefCalled = false;
  const pid = launchCrashWatchdog({
    entryPath: 'C:\\Program Files\\AI-FREE\\crash-watchdog\\entry.js',
    executablePath: 'C:\\Program Files\\AI-FREE\\AI-FREE.exe',
    rootDir: 'C:\\Users\\test\\AppData\\Roaming\\ai-free\\crash-reports',
    sessionPath: 'C:\\Users\\test\\session.json',
    parentPid: 1234,
    environment: { SystemRoot: 'C:\\Windows', PATH: 'test-path', SECRET_TOKEN: 'must-not-copy' },
  }, {
    existsSync: () => true,
    spawn: (...args) => {
      calls.push(args);
      return { pid: 5678, unref: () => { unrefCalled = true; } };
    },
  });

  assert.equal(pid, 5678);
  assert.equal(unrefCalled, true);
  assert.equal(calls.length, 1);
  const [executable, args, options] = calls[0];
  assert.equal(executable, 'C:\\Program Files\\AI-FREE\\AI-FREE.exe');
  assert.deepEqual(args.slice(-2), ['--parent-pid', '1234']);
  assert.equal(options.detached, true);
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio, 'ignore');
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(options.env.SECRET_TOKEN, undefined);
});

test('watchdog environment only forwards the required host variables', () => {
  const environment = buildWatchdogEnvironment({
    APPDATA: 'app-data',
    NODE_EXTRA_CA_CERTS: 'cert.pem',
    ACCOUNT_PASSWORD: 'do-not-forward',
  });
  assert.equal(environment.APPDATA, 'app-data');
  assert.equal(environment.NODE_EXTRA_CA_CERTS, 'cert.pem');
  assert.equal(environment.ACCOUNT_PASSWORD, undefined);
});
