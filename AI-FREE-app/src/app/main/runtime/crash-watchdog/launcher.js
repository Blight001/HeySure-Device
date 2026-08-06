'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveWatchdogEntry(app, runtimeDir = __dirname) {
  if (app?.isPackaged && process.resourcesPath) {
    return path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'src',
      'app',
      'main',
      'runtime',
      'crash-watchdog',
      'entry.js',
    );
  }
  return path.join(runtimeDir, 'entry.js');
}

function buildWatchdogEnvironment(environment = process.env) {
  const names = [
    'APPDATA', 'HOME', 'LOCALAPPDATA', 'NODE_EXTRA_CA_CERTS', 'PATH',
    'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
  ];
  const result = { ELECTRON_RUN_AS_NODE: '1', AI_FREE_CRASH_WATCHDOG: '1' };
  for (const name of names) {
    if (environment[name]) result[name] = environment[name];
  }
  return result;
}

function buildWatchdogArgs(entryPath, options) {
  return [
    entryPath,
    '--root', options.rootDir,
    '--session', options.sessionPath,
    '--parent-pid', String(options.parentPid),
  ];
}

function launchCrashWatchdog(options = {}, dependencies = {}) {
  const spawn = dependencies.spawn || childProcess.spawn;
  const existsSync = dependencies.existsSync || fs.existsSync;
  const entryPath = options.entryPath || resolveWatchdogEntry(options.app);
  if (!existsSync(entryPath)) throw new Error(`独立崩溃看门狗文件缺失: ${entryPath}`);
  const child = spawn(options.executablePath || process.execPath, buildWatchdogArgs(entryPath, options), {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: buildWatchdogEnvironment(options.environment),
  });
  child.unref?.();
  return Number(child.pid) || 0;
}

module.exports = { buildWatchdogEnvironment, launchCrashWatchdog, resolveWatchdogEntry };
