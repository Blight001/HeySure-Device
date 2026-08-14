'use strict';

const { parentPort, workerData } = require('worker_threads');
const { ensureChromiumSandboxAccess } = require('./chromium-sandbox-access');
const { runChromiumPreflight } = require('./chromium-preflight');

function serializeError(error) {
  return { code: String(error?.code || 'CHROMIUM_PREFLIGHT_WORKER_FAILED'), message: String(error?.message || error) };
}

try {
  const logger = /** @type {Console} */ (/** @type {unknown} */ ({ info() {}, warn() {} }));
  const sandboxAccess = ensureChromiumSandboxAccess(workerData.executablePath, logger, {
    cacheFile: workerData.cacheFile,
  });
  const preflight = runChromiumPreflight({
    executablePath: workerData.executablePath,
    sandboxAccess,
  });
  parentPort.postMessage({ ok: true, sandboxAccess, preflight });
} catch (error) {
  parentPort.postMessage({ ok: false, error: serializeError(error) });
}
