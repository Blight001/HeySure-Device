'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const SAFE_MODE_CRASH_COUNT = 3;
const EXIT_KIND = Object.freeze({ CRASH: 'crash', NORMAL: 'normal', UPDATE: 'update' });
const RECOVERY_ACTION = Object.freeze({
  RECOVER: 'recover',
  SAFE_MODE: 'safe-mode',
  STOP: 'stop',
});

function normalizeTimestamp(value, fallback) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : fallback;
}

function classifyExit(details = {}) {
  const reason = String(details.kind || details.reason || '').trim().toLowerCase();
  if (details.updating === true || ['update', 'updating', 'install-update'].includes(reason)) {
    return EXIT_KIND.UPDATE;
  }
  if (details.normal === true || ['normal', 'quit', 'user-quit', 'shutdown'].includes(reason)) {
    return EXIT_KIND.NORMAL;
  }
  return EXIT_KIND.CRASH;
}

function sanitizeState(value) {
  const crashes = Array.isArray(value?.crashes)
    ? value.crashes.filter(Number.isFinite).map(Number)
    : [];
  return { version: 1, crashes };
}

function readState(filePath, fileSystem) {
  if (!filePath) return sanitizeState();
  try { return sanitizeState(JSON.parse(fileSystem.readFileSync(filePath, 'utf8'))); } catch (_) { return sanitizeState(); }
}

function writeState(filePath, state, fileSystem) {
  if (!filePath) return;
  fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    fileSystem.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    fileSystem.renameSync(temporary, filePath);
  } finally {
    try { if (fileSystem.existsSync(temporary)) fileSystem.unlinkSync(temporary); } catch (_) {}
  }
}

function buildDecision(crashCount, exitKind) {
  const safeMode = crashCount >= SAFE_MODE_CRASH_COUNT;
  const ignoredExit = exitKind === EXIT_KIND.NORMAL || exitKind === EXIT_KIND.UPDATE;
  const action = ignoredExit
    ? RECOVERY_ACTION.STOP
    : safeMode
    ? RECOVERY_ACTION.SAFE_MODE
    : (crashCount === 1 ? RECOVERY_ACTION.RECOVER : RECOVERY_ACTION.STOP);
  return Object.freeze({
    action,
    autoRecover: action === RECOVERY_ACTION.RECOVER,
    crashCount,
    exitKind,
    safeMode: ignoredExit ? false : safeMode,
    safeModePolicy: safeMode && !ignoredExit ? Object.freeze({
      autoRestoreChromium: false,
      launchClash: false,
      preflightWarmup: false,
      recommendDisableHardwareAcceleration: true,
    }) : null,
  });
}

function createCrashLoopGuard(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const filePath = options.filePath ? path.resolve(options.filePath) : '';
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const windowMs = Math.max(1_000, Number(options.windowMs) || DEFAULT_WINDOW_MS);

  function recentCrashes(at) {
    const lowerBound = at - windowMs;
    return readState(filePath, fileSystem).crashes
      .filter((timestamp) => timestamp > lowerBound && timestamp <= at)
      .sort((left, right) => left - right);
  }

  function recordExit(details = {}) {
    const at = normalizeTimestamp(details.at, now());
    const exitKind = classifyExit(details);
    const crashes = recentCrashes(at);
    if (exitKind === EXIT_KIND.CRASH) crashes.push(at);
    writeState(filePath, { version: 1, crashes }, fileSystem);
    return buildDecision(crashes.length, exitKind);
  }

  function inspect(at = now()) {
    const crashes = recentCrashes(normalizeTimestamp(at, now()));
    return buildDecision(crashes.length, null);
  }

  function reset() {
    writeState(filePath, sanitizeState(), fileSystem);
  }

  return Object.freeze({ inspect, recordExit, reset });
}

module.exports = {
  DEFAULT_WINDOW_MS,
  EXIT_KIND,
  RECOVERY_ACTION,
  SAFE_MODE_CRASH_COUNT,
  classifyExit,
  createCrashLoopGuard,
};
