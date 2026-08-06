'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { appContext: defaultAppContext } = require('../runtime/app-context');
const { installShutdownUncaughtExceptionGuard } = require('../utils/logger');

function launchIndependentCommand(target, logger = console) {
  const resolvedTarget = String(target || '').trim();
  if (!resolvedTarget) throw new Error('启动目标为空');
  const extension = path.extname(resolvedTarget).toLowerCase();
  const cwd = path.dirname(resolvedTarget);
  const isWindows = process.platform === 'win32';
  let command = resolvedTarget;
  let args = [];
  if (isWindows && ['.exe', '.bat', '.cmd'].includes(extension)) {
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', 'start', '""', resolvedTarget];
  } else if (isWindows && extension === '.ps1') {
    command = 'powershell.exe';
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedTarget];
  }
  logger.warn?.('[退出] 准备独立启动更新包', { target: resolvedTarget, cwd, command, args });
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', (error) => logger.warn?.('[退出] 独立启动更新包失败:', error?.message || error));
  try { child.unref(); } catch (_) {}
  logger.log?.('[退出] 已独立拉起更新包进程', { pid: child.pid ?? null, target: resolvedTarget });
  return { pid: child.pid ?? null, target: resolvedTarget, command, args };
}

async function attemptAsync(logger, failureLabel, action) {
  try { return await action(); } catch (error) {
    logger.warn?.(`[退出] ${failureLabel}:`, error?.message || error);
    return null;
  }
}

function attemptSync(logger, failureLabel, action) {
  try { return action(); } catch (error) {
    logger.warn?.(`[退出] ${failureLabel}:`, error?.message || error);
    return null;
  }
}

async function stopRuntimeProcesses(deps, isUpdateExit) {
  const {
    logger, aiServerDeviceService, browserAutomationBridge,
    browserRuntimeManager, stopClashMiniProcess, sendToSide,
  } = deps;
  await attemptAsync(logger, '断开 AI 服务器设备连接失败', () => aiServerDeviceService?.stop?.());
  await attemptAsync(logger, '关闭 Chromium 原生自动化网关失败', () => browserAutomationBridge?.stop?.());
  await attemptAsync(logger, 'Chromium Profile 关闭失败', async () => {
    if (typeof browserRuntimeManager?.stopAll === 'function') {
      logger.log?.('[退出] 正在优雅关闭 Chromium Profile...');
      await browserRuntimeManager.stopAll({ timeoutMs: isUpdateExit ? 2000 : 5000 });
    }
  });
  await attemptAsync(logger, '关闭 Clash Mini 失败', async () => {
    logger.log?.('[退出] 正在关闭 Clash Mini...');
    const result = await stopClashMiniProcess({ sendToSide });
    if (result?.ok === false) logger.warn?.('[退出] Clash Mini 未完全退出:', result.error || result);
    else logger.log?.('[退出] Clash Mini 已关闭');
  });
}

function closePlatformResources(deps) {
  const { logger, BrowserWindow, shortcutManager, getGlobalHttpClient } = deps;
  attemptSync(logger, '关闭窗口失败', () => {
    logger.log?.('[退出] 关闭所有窗口...');
    for (const window of BrowserWindow.getAllWindows()) {
      try { window.close(); } catch (_) {}
    }
  });
  attemptSync(logger, '清理快捷键失败', () => {
    logger.log?.('[退出] 清理全局快捷键...');
    shortcutManager.unregister();
  });
  attemptSync(logger, '释放 HTTP 客户端失败', () => getGlobalHttpClient?.()?.close?.());
}

async function cleanupPersistentRuntime(deps) {
  const {
    logger,
    cleanupAllBrowserSessionData,
    cleanupBrowserPartitionsRootDir,
    cleanupClashMiniRuntimeConfig,
    getClashMiniRuntimeRoot,
  } = deps;
  await attemptAsync(logger, '清理浏览器缓存失败', async () => {
    logger.log?.('[退出] 清理浏览器缓存...');
    const result = await cleanupAllBrowserSessionData({ source: '应用退出', force: true });
    logger.log?.('[退出] 浏览器缓存清理完成:', result);
  });
  await attemptAsync(logger, '删除 Partitions 根目录失败', async () => {
    logger.log?.('[退出] 删除 Partitions 根目录...');
    const result = await cleanupBrowserPartitionsRootDir();
    logger.log?.('[退出] Partitions 根目录清理完成:', result);
  });
  await attemptAsync(logger, '清理 Clash Mini 运行配置失败', async () => {
    logger.log?.('[退出] 清理 Clash Mini 运行配置...');
    const root = typeof getClashMiniRuntimeRoot === 'function' ? getClashMiniRuntimeRoot() : '';
    const result = typeof cleanupClashMiniRuntimeConfig === 'function'
      ? cleanupClashMiniRuntimeConfig(root)
      : { ok: false, error: 'cleanupClashMiniRuntimeConfig unavailable' };
    logger.log?.('[退出] Clash Mini 运行配置清理完成:', result);
  });
}

async function runShutdownCleanup(deps, pendingUpdate) {
  const isUpdateExit = Boolean(pendingUpdate.target);
  await stopRuntimeProcesses(deps, isUpdateExit);
  closePlatformResources(deps);
  if (isUpdateExit) {
    deps.logger.log?.('[退出] 更新退出模式：跳过浏览器缓存和深度清理');
  } else {
    await cleanupPersistentRuntime(deps);
  }
}

function finishPendingUpdate(deps, pendingUpdate) {
  if (!pendingUpdate.target) return;
  deps.appContext.clearPendingUpdateInstall();
  try {
    deps.logger.log?.('[退出] 发现待安装更新包，准备在退出后启动:', pendingUpdate);
    deps.launchIndependentCommand(pendingUpdate.target, deps.logger);
  } catch (error) {
    deps.logger.warn?.('[退出] 启动待安装更新包失败:', error?.message || error);
  }
}

function createBeforeQuitHandler(deps) {
  return function beforeQuit(event) {
    if (!deps.appContext.beginMainAppExit()) return;
    try { event.preventDefault(); } catch (_) {}
    void (async () => {
      deps.logger.log?.('[退出] 主进程开始退出流程...');
      deps.appContext.markShuttingDown();
      deps.installShutdownGuard();
      try { deps.sendToSide?.('app-shutting-down', { reason: 'quit' }); } catch (_) {}
      const pendingUpdate = deps.appContext.getPendingUpdateInstall();
      const hardExitTimer = setTimeout(
        () => deps.app.exit(0),
        pendingUpdate.target ? 8000 : 20000,
      );
      try {
        await runShutdownCleanup(deps, pendingUpdate);
        deps.logger.log?.('[退出] 清理完成，退出应用...');
      } catch (error) {
        deps.logger.error?.('[退出] 退出清理流程失败:', error);
      } finally {
        clearTimeout(hardExitTimer);
        finishPendingUpdate(deps, pendingUpdate);
        deps.app.exit(0);
      }
    })().catch((error) => {
      deps.logger.error?.('[退出] 未处理的退出异常:', error);
      try { deps.app.exit(1); } catch (_) {}
    });
  };
}

function registerAppShutdown(deps = {}) {
  /** @type {Record<string, any>} */
  const normalized = {
    ...deps,
    appContext: deps.appContext || defaultAppContext,
    installShutdownGuard: deps.installShutdownGuard || installShutdownUncaughtExceptionGuard,
    launchIndependentCommand: deps.launchIndependentCommand || launchIndependentCommand,
    logger: deps.logger || console,
  };
  const handler = createBeforeQuitHandler(normalized);
  normalized.app.on('before-quit', handler);
  return () => normalized.app.removeListener?.('before-quit', handler);
}

module.exports = {
  cleanupPersistentRuntime,
  closePlatformResources,
  createBeforeQuitHandler,
  launchIndependentCommand,
  registerAppShutdown,
  runShutdownCleanup,
  stopRuntimeProcesses,
};
