'use strict';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attachChildWindowWithRetry(windowBridge, options, retryOptions = {}) {
  const attempts = Math.max(1, Number(retryOptions.attempts || 5));
  const delayMs = Math.max(0, Number(retryOptions.delayMs ?? 60));
  const sleep = retryOptions.sleep || delay;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const attached = windowBridge.attachChildWindow(options);
      if (attached && windowBridge.isChildWindowAttached(options.hostHwnd, options.childHwnd)) {
        return true;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  retryOptions.logger?.warn?.('[ChromiumRuntime] HWND 嵌入重试耗尽', lastError?.message || lastError || '未附着');
  return false;
}

module.exports = { attachChildWindowWithRetry };
