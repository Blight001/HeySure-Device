'use strict';

function promptImportedPlatformDecision({ ipcMain, ui, platformLabel, targetUrl, timeoutMs = 30000 }) {
  const safePlatformLabel = String(platformLabel || '').trim() || '未知平台';
  const safeTargetUrl = String(targetUrl || '').trim();
  const requestId = `cookie-import-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { ipcMain.removeListener('cookie-import-confirm-response', onResponse); } catch (_) {}
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const onResponse = (_event, payload = {}) => {
      if (String(payload?.requestId || '') !== requestId) return;
      finish({
        confirmed: payload.confirmed === true,
        cancelled: payload.cancelled === true,
        decidedUnknown: payload.decidedUnknown !== false,
      });
    };
    timer = setTimeout(() => finish({
      confirmed: false,
      cancelled: true,
      decidedUnknown: true,
      timedOut: true,
    }), timeoutMs);
    ipcMain.on('cookie-import-confirm-response', onResponse);
    try {
      if (ui && typeof ui.sendToSide === 'function') {
        ui.sendToSide('cookie-import-confirm-request', {
          requestId,
          platformLabel: safePlatformLabel,
          targetUrl: safeTargetUrl,
        });
        return;
      }
    } catch (error) {
      console.warn('[IPC] 发送导入确认请求失败:', error?.message || error);
    }
    finish({ confirmed: false, cancelled: true, decidedUnknown: true, error: '确认弹窗不可用' });
  });
}

module.exports = { promptImportedPlatformDecision };
