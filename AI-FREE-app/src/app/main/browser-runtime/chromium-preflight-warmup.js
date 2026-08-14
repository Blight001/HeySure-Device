'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { primeCachedChromiumPreflight } = require('./chromium-preflight');

const activeWarmups = new Map();

function workerFailure(payload) {
  const details = payload?.error || {};
  const error = /** @type {Error & {code?: string}} */ (new Error(
    String(details.message || 'Chromium 后台预检 Worker 失败'),
  ));
  error.code = String(details.code || 'CHROMIUM_PREFLIGHT_WORKER_FAILED');
  return error;
}

function runWarmupWorker(workerData, createWorker = (filename, options) => new Worker(filename, options)) {
  return new Promise((resolve, reject) => {
    const worker = createWorker(path.join(__dirname, 'chromium-preflight-worker.js'), { workerData });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      worker.removeAllListeners();
      if (error) reject(error); else resolve(value);
    };
    worker.once('message', (message) => {
      if (!message?.ok) finish(workerFailure(message)); else finish(null, message);
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (code !== 0) finish(workerFailure({ error: { message: `Worker exit ${code}` } }));
    });
  });
}

function warmupKey(executablePath) {
  return path.resolve(String(executablePath || '')).toLowerCase();
}

function startChromiumPreflightWarmup(options = {}, dependencies = {}) {
  let executablePath;
  try {
    const resolveExecutable = dependencies.resolveExecutable
      || ((launchOptions) => require('./chromium-launcher').resolveChromiumExecutable(launchOptions));
    executablePath = resolveExecutable(options);
  } catch (error) {
    options.logger?.warn?.('[ChromiumRuntime] 后台预检跳过:', error?.message || error);
    return Promise.resolve(null);
  }
  const key = warmupKey(executablePath);
  if (activeWarmups.has(key)) return activeWarmups.get(key);
  const runWorker = dependencies.runWorker || runWarmupWorker;
  const prime = dependencies.prime || primeCachedChromiumPreflight;
  const task = runWorker({ executablePath, cacheFile: String(options.cacheFile || '') }, dependencies.createWorker)
    .then((result) => {
      prime({ executablePath, sandboxAccess: result.sandboxAccess }, result.preflight);
      options.logger?.info?.('[ChromiumRuntime] Chromium 启动预检已后台预热');
      return { ...result, executablePath };
    })
    .catch((error) => {
      options.logger?.warn?.('[ChromiumRuntime] Chromium 后台预检失败，将在打开时重试:', error?.message || error);
      return null;
    })
    .finally(() => activeWarmups.delete(key));
  activeWarmups.set(key, task);
  return task;
}

function waitForChromiumPreflightWarmup(executablePath) {
  const task = activeWarmups.get(warmupKey(executablePath));
  return task ? task : null;
}

module.exports = {
  runWarmupWorker,
  startChromiumPreflightWarmup,
  waitForChromiumPreflightWarmup,
};
