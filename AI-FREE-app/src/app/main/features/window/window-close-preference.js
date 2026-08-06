'use strict';

const WINDOW_CLOSE_BEHAVIORS = new Set(['ask', 'hide', 'quit']);
const DEFAULT_WINDOW_CLOSE_BEHAVIOR = 'ask';

function normalizeWindowCloseBehavior(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return WINDOW_CLOSE_BEHAVIORS.has(normalized)
    ? normalized
    : DEFAULT_WINDOW_CLOSE_BEHAVIOR;
}

function readWindowCloseBehavior(readStoreConfigSafe) {
  try {
    const store = typeof readStoreConfigSafe === 'function' ? readStoreConfigSafe() : {};
    return normalizeWindowCloseBehavior(store?.windowCloseBehavior);
  } catch (_) {
    return DEFAULT_WINDOW_CLOSE_BEHAVIOR;
  }
}

function writeWindowCloseBehavior(readStoreConfigSafe, writeStoreConfigSafe, behavior) {
  const normalized = normalizeWindowCloseBehavior(behavior);
  if (normalized !== behavior) {
    return {
      ok: false,
      error: { code: 'WINDOW_CLOSE_BEHAVIOR_INVALID', message: '无效的窗口关闭方式', retryable: false },
    };
  }
  try {
    const currentStore = typeof readStoreConfigSafe === 'function'
      ? (readStoreConfigSafe() || {})
      : {};
    const wrote = typeof writeStoreConfigSafe === 'function'
      && writeStoreConfigSafe({ ...currentStore, windowCloseBehavior: normalized });
    return wrote
      ? { ok: true, data: { behavior: normalized } }
      : {
        ok: false,
        error: { code: 'WINDOW_CLOSE_BEHAVIOR_WRITE_FAILED', message: '保存窗口关闭方式失败', retryable: true },
      };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'WINDOW_CLOSE_BEHAVIOR_WRITE_FAILED',
        message: error?.message || String(error),
        retryable: true,
      },
    };
  }
}

module.exports = {
  DEFAULT_WINDOW_CLOSE_BEHAVIOR,
  normalizeWindowCloseBehavior,
  readWindowCloseBehavior,
  writeWindowCloseBehavior,
};
