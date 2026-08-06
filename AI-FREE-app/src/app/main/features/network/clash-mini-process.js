'use strict';

const { appContext } = require('../../runtime/app-context');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { writeDebugConsoleOnly } = require('../../runtime/debug-console-log');
const {
  getClashMiniRuntimeRoot,
  resolveClashMiniExecutable,
  prepareClashMiniRuntimeDirAsync,
  purgeClashMiniRuntimeConfigFiles,
} = require('./clash-mini-assets');
const {
  waitForClashMiniControlApi,
  ensureClashMiniRuleMode,
} = require('./clash-mini-control');
const {
  ensureClashMiniRuntimeConfig,
} = require('./clash-mini-config');

let clashStartedByApp = false;
let clashMiniProcess = null;
let clashMiniPid = null;
let clashMiniCoreDir = null;
let clashMiniExePath = null;
let clashMiniConfigPath = null;
let clashMiniProxyAppliedByApp = false;
let runtimeLicenseCache = null;
let clashMiniStartPromise = null;
let clashMiniStopPromise = null;
let clashMiniStartGeneration = 0;
const intentionallyStoppedClashProcesses = new WeakSet();

function isClashMiniStartCancelled(startGeneration) {
  return startGeneration !== clashMiniStartGeneration || appContext.isShuttingDown();
}

function buildClashMiniStartCancelledResult() {
  return {
    ...getClashMiniStatus(),
    ok: false,
    cancelled: true,
    error: 'Clash Mini 启动已取消',
  };
}

function hasClashMiniProcessExited(processRef) {
  return !processRef || processRef.exitCode != null || processRef.signalCode != null;
}

function waitForClashMiniProcessExit(processRef, timeoutMs) {
  if (hasClashMiniProcessExited(processRef)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      processRef.removeListener('exit', onExit);
      processRef.removeListener('close', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(hasClashMiniProcessExited(processRef)), timeoutMs);
    processRef.once('exit', onExit);
    processRef.once('close', onExit);
  });
}

function forceKillClashMiniProcessTree(pid, processRef) {
  if (process.platform !== 'win32' || !pid) return Promise.resolve(false);

  return new Promise((resolve) => {
    let killer;
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (_) {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { killer.kill(); } catch (_) {}
      finish(false);
    }, 5000);
    killer.once('error', () => finish(false));
    killer.once('close', (code) => finish(code === 0 || hasClashMiniProcessExited(processRef)));
  });
}

function setRuntimeLicenseCache(next) {
  runtimeLicenseCache = next || null;
}

function isClashMiniProcessRunning() {
  // killed 仅表示已经调用过 ChildProcess.kill()，不能用它判断 OS 进程已退出。
  return !!(clashMiniProcess && !hasClashMiniProcessExited(clashMiniProcess));
}

function getClashMiniStatus() {
  const actualEnabled = clashMiniProxyAppliedByApp === true;
  return {
    ok: true,
    running: isClashMiniProcessRunning(),
    enabled: isClashMiniProcessRunning() && actualEnabled,
    pid: clashMiniPid || null,
    coreDir: clashMiniCoreDir || '',
    exePath: clashMiniExePath || '',
    configPath: clashMiniConfigPath || '',
    startedByApp: clashStartedByApp === true,
    proxyAppliedByApp: actualEnabled,
  };
}

function isClashMiniNetworkRequestLog(text, extra = {}) {
  if (!extra || !extra.stream) return false;
  return /(?:msg=)?["']?\[(?:TCP|UDP|DNS)\]/i.test(String(text || ''));
}

function emitClashMiniLog(ui, level, message, extra = {}) {
  const text = String(message || '').trim();
  const prefix = '[Clash Mini]';
  const debugOnly = isClashMiniNetworkRequestLog(text, extra);
  const entry = {
    level,
    text,
    timestamp: new Date().toISOString(),
    ...extra,
  };

  if (debugOnly) {
    writeDebugConsoleOnly(level, prefix, text, extra);
  } else {
    try {
      if (level === 'error') {
        console.error(prefix, text, extra);
      } else if (level === 'warn') {
        console.warn(prefix, text, extra);
      } else {
        console.log(prefix, text, extra);
      }
    } catch (_) {}
  }

  if (!debugOnly) {
    try {
      ui?.sendToSide?.('clash-mini-log', entry);
    } catch (_) {}
    try {
      ui?.sendToSide?.('clash-mini-status', getClashMiniStatus());
    } catch (_) {}
  }
  return entry;
}

function resetClashMiniProcessState(processRef = clashMiniProcess) {
  if (clashMiniProcess !== processRef) return;
  clashMiniProcess = null;
  clashMiniPid = null;
  clashMiniCoreDir = null;
  clashMiniExePath = null;
  clashMiniConfigPath = null;
  clashStartedByApp = false;
  clashMiniProxyAppliedByApp = false;
}

async function syncBrowserProxy(ui, enabled) {
  if (typeof ui?.applyClashMiniBrowserProxy !== 'function') return null;
  return Promise.resolve(ui.applyClashMiniBrowserProxy(enabled)).catch(() => null);
}

function formatBrowserProxyMessage(result) {
  if (result?.ok !== true) return '';
  const count = Number(result.updated);
  return `，浏览器代理已同步${Number.isFinite(count) ? `(${count} 个标签页)` : ''}`;
}

async function validateRuleMode(ui, coreDir, stopOnFailure = false) {
  const result = await ensureClashMiniRuleMode(coreDir);
  if (result.ok) return null;
  const message = `Mihomo 无法切换到规则模式：${result.error || '未知错误'}`;
  emitClashMiniLog(ui, 'error', message);
  if (stopOnFailure) await stopClashMiniProcess(ui, { waitForPendingStart: false });
  return { ok: false, error: message, controlApiReady: true };
}

async function reuseRunningProcess(ui, startCancelled) {
  if (!isClashMiniProcessRunning()) return null;
  const coreDir = clashMiniCoreDir || getClashMiniRuntimeRoot();
  const controlApiReady = await waitForClashMiniControlApi(coreDir, 10000, startCancelled);
  if (startCancelled()) return buildClashMiniStartCancelledResult();
  if (!controlApiReady) {
    const message = 'Mihomo 进程存在但控制端口不可用，已停止异常进程';
    emitClashMiniLog(ui, 'error', message);
    await stopClashMiniProcess(ui, { waitForPendingStart: false });
    return { ok: false, error: message, controlApiReady: false };
  }
  const ruleFailure = await validateRuleMode(ui, coreDir);
  if (startCancelled()) return buildClashMiniStartCancelledResult();
  if (ruleFailure) return ruleFailure;
  const proxyResult = await syncBrowserProxy(ui, true);
  if (startCancelled()) return buildClashMiniStartCancelledResult();
  clashMiniProxyAppliedByApp = proxyResult?.ok === true;
  emitClashMiniLog(ui, 'info', `Clash Mini 已重新运行${formatBrowserProxyMessage(proxyResult)}`);
  return { ok: true, alreadyRunning: true, ...getClashMiniStatus() };
}

async function prepareRuntime(ui, startCancelled) {
  const runtimePrep = await prepareClashMiniRuntimeDirAsync();
  if (startCancelled()) return { result: buildClashMiniStartCancelledResult() };
  if (!runtimePrep.ok) {
    const error = runtimePrep.error || '准备 Clash Mini 运行目录失败';
    emitClashMiniLog(ui, 'error', error);
    return { result: { ok: false, error } };
  }
  if (!runtimePrep.assetSync?.ok) {
    const missing = runtimePrep.assetSync?.missing;
    const details = missing?.length ? missing.join(', ') : (runtimePrep.assetSync?.error || '未知错误');
    emitClashMiniLog(ui, 'warn', `本地 Geo/规则资产缺失: ${details}（将回退到离线兜底）`);
  }
  const configResult = ensureClashMiniRuntimeConfig(runtimePrep.runtimeDir);
  if (startCancelled()) return { result: buildClashMiniStartCancelledResult() };
  if (!configResult.ok) {
    const error = configResult.error || '未找到可启动的 Clash 运行配置';
    emitClashMiniLog(ui, 'error', error);
    return { result: { ok: false, error } };
  }
  const exePath = resolveClashMiniExecutable(runtimePrep.runtimeDir);
  if (!exePath) {
    emitClashMiniLog(ui, 'error', '未找到 verge-mihomo.exe');
    return { result: { ok: false, error: '未找到 verge-mihomo.exe' } };
  }
  return { runtimePrep, configResult, exePath };
}

function bindClashMiniStreams(ui, processRef) {
  for (const [stream, level] of [['stdout', 'info'], ['stderr', 'warn']]) {
    processRef[stream]?.on('data', (data) => {
      const text = String(data || '').trim();
      if (text) emitClashMiniLog(ui, level, text, { stream });
    });
  }
}

function handleClashMiniExit(ui, processRef, code, signal) {
  const intentional = intentionallyStoppedClashProcesses.has(processRef);
  intentionallyStoppedClashProcesses.delete(processRef);
  resetClashMiniProcessState(processRef);
  if (!intentional && !isClashMiniProcessRunning()) void syncBrowserProxy(ui, false);
  const level = intentional || code === 0 ? 'info' : 'warn';
  const reason = intentional ? '已按请求停止' : '进程已退出';
  emitClashMiniLog(ui, level, `Clash Mini ${reason}，退出码: ${code}${signal ? `, 信号: ${signal}` : ''}`);
}

function handleClashMiniError(ui, processRef, error) {
  const intentional = intentionallyStoppedClashProcesses.has(processRef);
  intentionallyStoppedClashProcesses.delete(processRef);
  intentionallyStoppedClashProcesses.add(processRef);
  resetClashMiniProcessState(processRef);
  if (!intentional && !isClashMiniProcessRunning()) void syncBrowserProxy(ui, false);
  emitClashMiniLog(ui, 'error', `Clash Mini 启动失败: ${error?.message || error}`);
}

function spawnClashMiniCore(ui, prepared) {
  const { runtimePrep, configResult, exePath } = prepared;
  clashMiniCoreDir = runtimePrep.runtimeDir;
  clashMiniExePath = exePath;
  clashMiniConfigPath = configResult.configPath || path.join(runtimePrep.runtimeDir, 'config.yaml');
  emitClashMiniLog(ui, 'info', `启动命令: ${path.basename(exePath)} -d ${runtimePrep.runtimeDir}`);
  clashMiniProcess = spawn(exePath, ['-d', runtimePrep.runtimeDir], {
    cwd: runtimePrep.runtimeDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  clashMiniPid = clashMiniProcess.pid || null;
  clashStartedByApp = true;
  const processRef = clashMiniProcess;
  bindClashMiniStreams(ui, processRef);
  processRef.on('close', (code, signal) => handleClashMiniExit(ui, processRef, code, signal));
  processRef.on('error', (error) => handleClashMiniError(ui, processRef, error));
  return processRef;
}

async function finishClashMiniStart(ui, runtimeDir, startCancelled) {
  const ready = await waitForClashMiniControlApi(runtimeDir, 30000, startCancelled);
  if (startCancelled()) return buildClashMiniStartCancelledResult();
  if (!ready || !isClashMiniProcessRunning()) {
    const message = 'Mihomo 控制端口未能在 30 秒内启动，请检查 Clash YAML 配置或端口占用';
    emitClashMiniLog(ui, 'error', message);
    await stopClashMiniProcess(ui, { waitForPendingStart: false });
    return { ok: false, error: message, controlApiReady: false };
  }
  const ruleFailure = await validateRuleMode(ui, runtimeDir, true);
  if (ruleFailure) return ruleFailure;
  if (startCancelled()) return buildClashMiniStartCancelledResult();
  const proxyResult = await syncBrowserProxy(ui, true);
  if (startCancelled()) return buildClashMiniStartCancelledResult();
  clashMiniProxyAppliedByApp = proxyResult?.ok === true;
  const proxyMessage = formatBrowserProxyMessage(proxyResult) || '，浏览器代理已切换到本地混合端口';
  emitClashMiniLog(ui, 'info', `Clash Mini 已启动，PID: ${clashMiniPid || 'unknown'}${proxyMessage}`);
  return { ok: true, started: true, ...getClashMiniStatus() };
}

async function startClashMiniProcessOnce(ui, options = {}, startGeneration = clashMiniStartGeneration) {
  const startCancelled = () => isClashMiniStartCancelled(startGeneration);
  if (startCancelled()) return buildClashMiniStartCancelledResult();
  const existing = await reuseRunningProcess(ui, startCancelled);
  if (existing) return existing;
  const prepared = await prepareRuntime(ui, startCancelled);
  if (prepared.result) return prepared.result;
  try {
    if (startCancelled()) return buildClashMiniStartCancelledResult();
    spawnClashMiniCore(ui, prepared);
    return finishClashMiniStart(ui, prepared.runtimePrep.runtimeDir, startCancelled);
  } catch (error) {
    if (startCancelled()) return buildClashMiniStartCancelledResult();
    emitClashMiniLog(ui, 'error', `启动 Clash Mini 失败: ${error?.message || error}`);
    resetClashMiniProcessState();
    return { ok: false, error: error?.message || String(error) };
  }
}

// 自动预热、账号验证和手动点击可能同时请求启动。所有调用方共享同一个任务，
// 防止后到的请求把“正在初始化”的 Mihomo 误判为异常进程并提前终止。
function startClashMiniProcess(ui, options = {}) {
  if (clashMiniStartPromise) {
    return clashMiniStartPromise;
  }

  const startGeneration = ++clashMiniStartGeneration;
  const sharedPromise = startClashMiniProcessOnce(ui, options, startGeneration).finally(() => {
    if (clashMiniStartPromise === sharedPromise) {
      clashMiniStartPromise = null;
    }
  });
  clashMiniStartPromise = sharedPromise;
  return sharedPromise;
}

async function terminateClashMiniProcess(ui, processRef, pid) {
  try {
    processRef?.kill?.();
  } catch (error) {
    emitClashMiniLog(ui, 'warn', `直接结束进程失败: ${error?.message || error}`);
  }
  let exited = await waitForClashMiniProcessExit(processRef, 1500);
  if (!exited && process.platform === 'win32' && pid) {
    emitClashMiniLog(ui, 'warn', `Clash Mini 未及时退出，正在强制结束进程树，PID: ${pid}`);
    await forceKillClashMiniProcessTree(pid, processRef);
    exited = await waitForClashMiniProcessExit(processRef, 3000);
  }
  return exited;
}

function updateStoppedRuntimeConfig() {
  if (typeof runtimeLicenseCache?.setRuntimeConfig === 'function') {
    runtimeLicenseCache.setRuntimeConfig({ systemProxyEnabled: false });
  }
}

async function stopClashMiniProcessOnce(ui, pendingStartPromise = null) {
  // 停止请求可能发生在资源复制/配置生成阶段，此时还没有 ChildProcess。
  // 等启动任务看到 generation 变化并自行退出，避免停止流程返回后又拉起核心。
  if (pendingStartPromise) {
    await pendingStartPromise.catch(() => {});
  }

  if (!isClashMiniProcessRunning()) {
    await syncBrowserProxy(ui, false);
    return { ok: true, stopped: false, ...getClashMiniStatus() };
  }

  const pid = clashMiniPid;
  const processRef = clashMiniProcess;
  if (processRef && typeof processRef === 'object') intentionallyStoppedClashProcesses.add(processRef);
  emitClashMiniLog(ui, 'info', `正在停止 Clash Mini，PID: ${pid || 'unknown'}`);

  // 先让浏览器脱离本地代理，再结束 Mihomo。反过来会让所有仍在传输的
  // Chromium socket 同时收到 ECONNRESET，并可能在退出期形成未处理异常。
  await syncBrowserProxy(ui, false);
  clashMiniProxyAppliedByApp = false;
  const exited = await terminateClashMiniProcess(ui, processRef, pid);

  if (exited && clashMiniProcess === processRef) {
    resetClashMiniProcessState(processRef);
  }
  updateStoppedRuntimeConfig();
  if (!exited) {
    const error = `Clash Mini 进程未能在超时内退出，PID: ${pid || 'unknown'}`;
    emitClashMiniLog(ui, 'error', error);
    return { ...getClashMiniStatus(), ok: false, stopped: false, error };
  }
  emitClashMiniLog(ui, 'info', 'Clash Mini 已停止，进程资源已释放');
  return { ok: true, stopped: true, ...getClashMiniStatus() };
}

function stopClashMiniProcess(ui, options = {}) {
  if (clashMiniStopPromise) return clashMiniStopPromise;

  // 启动流程自身发现失败时也会调用停止；该路径不能等待自身 promise。
  // 外部停止/应用退出则等待取消后的启动任务收敛，避免代理切换互相覆盖。
  const pendingStartPromise = options?.waitForPendingStart === false ? null : clashMiniStartPromise;
  // 同步失效当前启动任务，确保它不会跨过下一处 await 后继续 spawn/应用代理。
  clashMiniStartGeneration += 1;
  const sharedPromise = stopClashMiniProcessOnce(ui, pendingStartPromise).finally(() => {
    if (clashMiniStopPromise === sharedPromise) {
      clashMiniStopPromise = null;
    }
  });
  clashMiniStopPromise = sharedPromise;
  return sharedPromise;
}

function cleanupClashMiniRuntimeConfig(coreDir) {
  if (!coreDir || !fs.existsSync(coreDir)) {
    return { ok: true, removed: [], failed: [] };
  }

  return purgeClashMiniRuntimeConfigFiles(coreDir);
}

module.exports = {
  isClashMiniStartCancelled,
  buildClashMiniStartCancelledResult,
  hasClashMiniProcessExited,
  waitForClashMiniProcessExit,
  forceKillClashMiniProcessTree,
  setRuntimeLicenseCache,
  isClashMiniProcessRunning,
  getClashMiniStatus,
  isClashMiniNetworkRequestLog,
  emitClashMiniLog,
  startClashMiniProcessOnce,
  startClashMiniProcess,
  stopClashMiniProcessOnce,
  stopClashMiniProcess,
  cleanupClashMiniRuntimeConfig,
};
