// 统一 IPC/服务返回契约（阶段 2D，方案 §3.2）：
//   成功: { ok: true, data }
//   失败: { ok: false, error: { code, message, retryable, details? } }
// 新接口一律使用本模块；存量接口在各域整改（阶段 3/4）时迁移。
// 本模块零依赖，主进程与测试均可直接 require。
'use strict';

/** @typedef {import('./ipc-contracts').IpcErrorPayload} IpcErrorPayload */
/** @template T @typedef {import('./ipc-contracts').IpcResult<T>} IpcResult */

class AppError extends Error {
  /**
   * @param {string} code 稳定错误码（如 'NETWORK_TIMEOUT'、'VIP_REQUIRED'）
   * @param {string} message 面向用户/日志的消息
   * @param {{ retryable?: boolean, details?: unknown, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = String(code || 'UNKNOWN');
    this.retryable = options.retryable === true;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** @template T @param {T} data @returns {IpcResult<T>} */
const ok = (data) => ({ ok: true, data });

/** @returns {IpcErrorPayload} */
function toErrorPayload(error, fallbackCode = 'UNKNOWN') {
  if (error instanceof AppError) {
    const payload = { code: error.code, message: error.message, retryable: error.retryable };
    if (error.details !== undefined) payload.details = error.details;
    return payload;
  }
  return {
    code: fallbackCode,
    message: String((error && error.message) || error || '未知错误'),
    retryable: false,
  };
}

/** @returns {IpcResult<never>} */
const fail = (error, fallbackCode = 'UNKNOWN') => ({ ok: false, error: toErrorPayload(error, fallbackCode) });

// 包装 async handler：正常返回自动套 ok()，抛错自动映射为 fail()
const wrapIpcResult = (handler, { fallbackCode = 'UNKNOWN' } = {}) => async (...args) => {
  try {
    return ok(await handler(...args));
  } catch (error) {
    return fail(error, fallbackCode);
  }
};

module.exports = { AppError, ok, fail, toErrorPayload, wrapIpcResult };
