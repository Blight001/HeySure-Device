// 可释放 IPC 注册器（阶段 2B）——替代原 register.js 的 monkeypatch 去重补丁。
// 规则（方案 §3.2）：
//   - 通道必须先在 contracts/ipc-channels.js 登记，未登记即抛错；
//   - 同一注册器实例内重复注册同一通道立即抛错并指出双方来源
//     （真正的冲突要暴露，不再静默覆盖）；
//   - 运行期合法的整体重注册（重登录后重跑 registerIPC）通过
//     "新建实例前 dispose 旧实例" 显式释放，见 register.js。
'use strict';

const { isRegisteredInvoke, isRegisteredEvent } = require('../../contracts/ipc-channels');
const {
  wrapLegacyIpcEventPayload,
  wrapLegacyIpcPayload,
} = require('../../contracts/ipc-payloads');

function createIpcRegistry(ipcMain, { source = 'unknown' } = {}) {
  const handles = new Map(); // channel -> registrar 描述
  const listeners = new Map(); // channel -> { registrar, listener }
  let disposed = false;

  const assertUsable = (channel, map, kind) => {
    if (disposed) {
      throw new Error(`[ipc-registry:${source}] 已 dispose 的注册器不能再注册 ${kind} '${channel}'`);
    }
    if (map.has(channel)) {
      throw new Error(`[ipc-registry:${source}] ${kind} 通道 '${channel}' 重复注册：已由 ${map.get(channel).registrar || map.get(channel)} 注册`);
    }
  };

  const api = {
    handle(channel, handler, { registrar = source } = {}) {
      if (!isRegisteredInvoke(channel)) {
        throw new Error(`[ipc-registry:${source}] invoke 通道 '${channel}' 未在 contracts/ipc-channels.js 登记`);
      }
      assertUsable(channel, handles, 'invoke');
      ipcMain.handle(channel, wrapLegacyIpcPayload(channel, handler));
      handles.set(channel, { registrar });
    },
    on(channel, listener, { registrar = source } = {}) {
      if (!isRegisteredEvent(channel)) {
        throw new Error(`[ipc-registry:${source}] event 通道 '${channel}' 未在 contracts/ipc-channels.js 登记`);
      }
      assertUsable(channel, listeners, 'event');
      const wrappedListener = wrapLegacyIpcEventPayload(channel, listener);
      ipcMain.on(channel, wrappedListener);
      listeners.set(channel, { registrar, listener: wrappedListener });
    },
    dispose() {
      if (disposed) return;
      for (const channel of handles.keys()) {
        try { ipcMain.removeHandler(channel); } catch (_) {}
      }
      for (const [channel, entry] of listeners.entries()) {
        try { ipcMain.removeListener(channel, entry.listener); } catch (_) {}
      }
      handles.clear();
      listeners.clear();
      disposed = true;
    },
    stats() {
      return { source, handles: handles.size, listeners: listeners.size, disposed };
    },
  };
  // 为各 register 模块提供带来源标记的视图，便于重复注册报错时定位
  api.scope = (registrar) => ({
    handle: (channel, handler) => api.handle(channel, handler, { registrar }),
    on: (channel, listener) => api.on(channel, listener, { registrar }),
  });
  return api;
}

module.exports = { createIpcRegistry };
