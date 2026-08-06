'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { redactSensitiveText } = require('./chromium-diagnostic-redaction');

const MAX_LOG_BYTES = 256 * 1024;
const MAX_BUNDLES = 10;
const EVENT_CHANNELS = [
  'Microsoft-Windows-CodeIntegrity/Operational',
  'Microsoft-Windows-AppLocker/EXE and DLL',
  'Microsoft-Windows-Windows Defender/Operational',
];

function safeTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function readLogTail(logFilePath, fileSystem) {
  try {
    const content = fileSystem.readFileSync(logFilePath);
    return content.subarray(Math.max(0, content.length - MAX_LOG_BYTES)).toString('utf8');
  } catch (_) {
    return '';
  }
}

function collectWindowsEvents(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return [];
  const env = options.env || process.env;
  const systemRoot = String(env.SystemRoot || env.WINDIR || 'C:\\Windows');
  const run = options.spawnSync || spawnSync;
  return EVENT_CHANNELS.map((channel) => {
    const result = run(path.join(systemRoot, 'System32', 'wevtutil.exe'), [
      'qe', channel,
      '/q:*[System[TimeCreated[timediff(@SystemTime) <= 900000]]]',
      '/c:20', '/rd:true', '/f:text',
    ], { windowsHide: true, encoding: 'utf8', timeout: 2000 });
    return {
      channel,
      status: result?.status ?? null,
      output: String(result?.stdout || result?.stderr || result?.error?.message || '').slice(-64 * 1024),
    };
  });
}

function cleanupOldBundles(diagnosticDir, fileSystem) {
  try {
    const files = fileSystem.readdirSync(diagnosticDir)
      .filter((name) => /^chromium-failure-.*\.json$/i.test(name))
      .map((name) => ({ name, time: fileSystem.statSync(path.join(diagnosticDir, name)).mtimeMs }))
      .sort((left, right) => right.time - left.time);
    for (const entry of files.slice(MAX_BUNDLES)) {
      fileSystem.rmSync(path.join(diagnosticDir, entry.name), { force: true });
    }
  } catch (_) {}
}

function writeJsonAtomic(filePath, value, fileSystem) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    fileSystem.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fileSystem.renameSync(temporary, filePath);
  } catch (error) {
    try { fileSystem.rmSync(temporary, { force: true }); } catch (_) {}
    throw error;
  }
}

function sanitizeBundle(value, options) {
  if (typeof value === 'string') {
    return redactSensitiveText(value, {
      userDataDir: options.userDataDir,
      homeDir: options.homeDir,
      tempDir: options.tempDir,
    });
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeBundle(item, options));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeBundle(item, options)]),
  );
}

function enrichWindowsEvents(filePath, bundle, options) {
  try {
    bundle.windowsEvents = collectWindowsEvents(options);
    writeJsonAtomic(filePath, sanitizeBundle(bundle, options), options.fs || fs);
  } catch (_) {}
}

function currentDate(options) {
  return options.now ? options.now() : new Date();
}

function bundleIdentifier(options) {
  return options.bundleId || crypto.randomBytes(4).toString('hex');
}

function createChromiumDiagnosticBundle(options = {}) {
  const diagnosticDir = path.resolve(String(options.diagnosticDir || ''));
  if (!options.diagnosticDir) return '';
  const fileSystem = options.fs || fs;
  const now = currentDate(options);
  const filePath = path.join(
    diagnosticDir,
    `chromium-failure-${safeTimestamp(now)}-${process.pid}-${bundleIdentifier(options)}.json`,
  );
  fileSystem.mkdirSync(diagnosticDir, { recursive: true });
  const bundle = {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    application: { name: 'AI-FREE', version: String(options.appVersion || '') },
    system: {
      platform: options.platform || process.platform,
      arch: options.arch || process.arch,
      release: options.osRelease || os.release(),
      version: options.osVersion || os.version(),
    },
    failure: options.failure || {},
    executablePath: String(options.executablePath || ''),
    arguments: Array.isArray(options.args) ? options.args : [],
    preflight: options.preflight || null,
    chromiumLogTail: readLogTail(options.logFilePath, fileSystem),
    windowsEvents: 'collection-pending',
  };
  writeJsonAtomic(filePath, sanitizeBundle(bundle, options), fileSystem);
  cleanupOldBundles(diagnosticDir, fileSystem);
  const schedule = options.schedule || setImmediate;
  schedule(() => enrichWindowsEvents(filePath, bundle, options));
  return filePath;
}

module.exports = {
  collectWindowsEvents,
  createChromiumDiagnosticBundle,
};
