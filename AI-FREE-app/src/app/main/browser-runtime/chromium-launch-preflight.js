'use strict';

const { createChromiumDiagnosticBundle } = require('./chromium-diagnostic-bundle');
const { createChromiumLaunchLog } = require('./chromium-launch-log');
const { formatChromiumPreflight, runCachedChromiumPreflight } = require('./chromium-preflight');

function throwPreflightFailure(options, executablePath, preflight) {
  const detail = formatChromiumPreflight(preflight);
  const launchLog = createChromiumLaunchLog({ logFilePath: options.chromiumLogPath });
  launchLog.writeOutput('preflight', detail);
  const reason = `Chromium 启动前自检失败: ${detail}`;
  const diagnosticBundlePath = createChromiumDiagnosticBundle({
    diagnosticDir: options.chromiumDiagnosticDir,
    userDataDir: options.chromiumUserDataDir,
    appVersion: options.appVersion,
    logFilePath: options.chromiumLogPath,
    executablePath,
    preflight,
    failure: { reason, phase: 'preflight' },
  });
  const error = /** @type {Error & {code?: string, diagnosticBundlePath?: string}} */ (
    new Error(`${reason}${diagnosticBundlePath ? `；脱敏诊断包: ${diagnosticBundlePath}` : ''}`)
  );
  error.code = 'CHROMIUM_PREFLIGHT_FAILED';
  error.diagnosticBundlePath = diagnosticBundlePath;
  throw error;
}

function prepareChromiumPreflight(options, executablePath, sandboxAccess) {
  const preflight = runCachedChromiumPreflight({ executablePath, sandboxAccess });
  if (!preflight.ok) throwPreflightFailure(options, executablePath, preflight);
  return preflight;
}

module.exports = { prepareChromiumPreflight };
