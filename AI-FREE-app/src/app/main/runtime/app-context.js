// 应用级运行时上下文（阶段 2D）——业务性 global.* 的替代者。
// 原 global._isShuttingDown / _mainAppExiting / _pendingUpdateInstall* /
// __APP_SESSION_ID__ / __APP_DEBUG_CONSOLE_WRITE__ 全部收敛到这里；
// 新代码禁止再挂业务状态到 global。
// 默认导出进程级单例（多数消费方直接 require）；createAppContext 供测试
// 或未来完全依赖注入时使用。本模块必须保持零依赖，避免环形引用。
'use strict';

function createAppContext() {
  const state = {
    shuttingDown: false,
    mainAppExiting: false,
    pendingUpdateInstall: { version: '', target: '' },
    sessionId: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    debugConsoleWrite: null,
  };

  return {
    // ---- 退出流程 ----
    isShuttingDown: () => state.shuttingDown === true,
    markShuttingDown: () => { state.shuttingDown = true; },
    // 仅供测试/模拟恢复状态使用；生产退出流程一律走 markShuttingDown（单向）
    setShuttingDown: (value) => { state.shuttingDown = value === true; },
    // before-quit 重入保护：首次调用返回 true 并标记，之后返回 false
    beginMainAppExit: () => {
      if (state.mainAppExiting) return false;
      state.mainAppExiting = true;
      return true;
    },

    // ---- 更新安装挂起状态 ----
    setPendingUpdateInstall: ({ version = '', target = '' } = {}) => {
      state.pendingUpdateInstall = { version: String(version || ''), target: String(target || '') };
    },
    getPendingUpdateInstall: () => ({
      version: String(state.pendingUpdateInstall.version || '').trim(),
      target: String(state.pendingUpdateInstall.target || '').trim(),
    }),
    clearPendingUpdateInstall: () => {
      state.pendingUpdateInstall = { version: '', target: '' };
    },

    // ---- 会话标识 ----
    getSessionId: () => state.sessionId,

    // ---- 调试控制台写入钩子（由 create-ui-bridge 装配时设置）----
    setDebugConsoleWrite: (fn) => { state.debugConsoleWrite = typeof fn === 'function' ? fn : null; },
    getDebugConsoleWrite: () => state.debugConsoleWrite,
  };
}

const appContext = createAppContext();

module.exports = { appContext, createAppContext };
