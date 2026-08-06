'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChromiumDiagnosticBundle } = require('./chromium-diagnostic-bundle');
const { createChromiumLaunchDiagnostics } = require('./chromium-process-diagnostics');
const { redactSensitiveText } = require('./chromium-diagnostic-redaction');
const { formatChromiumPreflight } = require('./chromium-preflight');
const { callOptional } = require('../../shared/safe-values');

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_ENTRY_LENGTH = 4000;

function rotateLogIfNeeded(logFilePath, fileSystem) {
  try {
    if (!fileSystem.existsSync(logFilePath)
      || fileSystem.statSync(logFilePath).size < MAX_LOG_BYTES) return;
    const previousPath = `${logFilePath}.previous`;
    fileSystem.rmSync(previousPath, { force: true });
    fileSystem.renameSync(logFilePath, previousPath);
  } catch (_) {}
}

function appendLogLine(logFilePath, line, fileSystem) {
  if (!logFilePath) return false;
  try {
    fileSystem.mkdirSync(path.dirname(logFilePath), { recursive: true });
    rotateLogIfNeeded(logFilePath, fileSystem);
    const safeLine = redactSensitiveText(line).slice(0, MAX_ENTRY_LENGTH);
    fileSystem.appendFileSync(logFilePath, `${safeLine}\n`, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function executableDetails(executablePath, fileSystem) {
  try {
    const stat = fileSystem.statSync(executablePath);
    return `size=${stat.size} mtime=${stat.mtime.toISOString()}`;
  } catch (error) {
    return `stat-error=${error?.code || error?.message || error}`;
  }
}

function sandboxAccessDetails(result) {
  if (!result) return 'sandbox-access=unknown';
  if (result.ok) {
    const mode = result.cached ? 'memory-cache' : result.persistentCached ? 'persistent-cache' : 'verified';
    return `sandbox-access=ok(${mode})`;
  }
  return `sandbox-access=failed(status=${result.status ?? 'unknown'}, error=${result.error || 'unknown'})`;
}

function createChromiumLaunchLog(options = {}) {
  const configuredPath = String(options.logFilePath || '').trim();
  const logFilePath = configuredPath ? path.resolve(configuredPath) : '';
  const fileSystem = options.fs || fs;
  const now = options.now || (() => new Date());
  const timestamp = () => now().toISOString();
  const write = (kind, message) => (
    appendLogLine(logFilePath, `[${timestamp()}] [${kind}] ${message}`, fileSystem)
  );

  return {
    logFilePath,
    writeLaunch(details = {}) {
      const executablePath = String(details.executablePath || '');
      const args = Array.isArray(details.args) ? details.args.join(' ') : '';
      return write(
        'launch',
        `chromium-launch pid=${Number(details.pid || 0)} platform=${process.platform}/${process.arch} `
        + `os=${os.release()} executable=${executablePath} `
        + `${executableDetails(executablePath, fileSystem)} `
        + `${sandboxAccessDetails(details.sandboxAccess)} args=${args}`,
      );
    },
    writeOutput(source, value) {
      return write(String(source || 'output'), String(value || ''));
    },
  };
}

function attachChromiumLaunchLogging(options) {
  const { child, executablePath, args, logger, forwardOutput, shouldIgnore } = options;
  const launchLog = createChromiumLaunchLog({ logFilePath: options.logFilePath });
  const diagnostics = createChromiumLaunchDiagnostics({
    logFilePath: launchLog.logFilePath,
    onRecord: (source, value) => launchLog.writeOutput(source, value),
  });
  launchLog.writeLaunch({
    executablePath, pid: child.pid, args, sandboxAccess: options.sandboxAccess,
  });
  if (options.preflight) {
    diagnostics.record('preflight', formatChromiumPreflight(options.preflight));
  }
  diagnostics.preflight = options.preflight || null;
  diagnostics.createBundle = (failure) => createChromiumDiagnosticBundle({
    diagnosticDir: options.diagnosticDir,
    userDataDir: options.userDataDir,
    appVersion: options.appVersion,
    logFilePath: launchLog.logFilePath,
    executablePath,
    args,
    preflight: diagnostics.preflight,
    failure,
  });
  callOptional(logger, 'info', `[AI-FREE] 已启动外部浏览器内核: ${executablePath}`);
  if (launchLog.logFilePath) {
    callOptional(logger, 'info', `[ChromiumRuntime] 独立启动日志: ${launchLog.logFilePath}`);
  }
  callOptional(logger, 'info', `[ChromiumRuntime] PID=${child.pid}`);
  forwardOutput(child.stdout, (line) => {
    diagnostics.record('stdout', line);
    callOptional(logger, 'log', `[Chromium:${child.pid}] ${line}`);
  });
  forwardOutput(child.stderr, (line) => {
    diagnostics.record('stderr', line);
    callOptional(logger, 'warn', `[Chromium:${child.pid}] ${line}`);
  }, shouldIgnore);
  return diagnostics;
}

module.exports = {
  attachChromiumLaunchLogging,
  createChromiumLaunchLog,
  redactSensitiveText,
};
