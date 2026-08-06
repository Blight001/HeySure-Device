// 注入滚轮缩放监听脚本
async function injectZoomWheelListener(wc) {
  try {
    if (!wc || wc.isDestroyed()) return;

    // 获取当前标签页的缩放级别
    let initialZoom = 100;
    try {
      const zoomFactor = wc.getZoomFactor();
      if (zoomFactor && zoomFactor > 0) {
        initialZoom = Math.round(zoomFactor * 100);
      }
    } catch (_) {}

    const zoomScript = `
      (function() {
        if (window.__zoomWheelListenerInjected) return;
        window.__zoomWheelListenerInjected = true;

        let currentZoom = ${initialZoom};
        const MIN_ZOOM = 50;
        const MAX_ZOOM = 150;
        const ZOOM_STEP = 5;
        let lastWheelTime = 0;
        const DEBOUNCE_MS = 50;

        // 监听主进程通过 postMessage 发送的缩放级别更新
        window.addEventListener('message', function(event) {
          if (event.data && event.data.type === 'active-zoom') {
            const zoomFactor = event.data.zoomFactor;
            if (typeof zoomFactor === 'number' && zoomFactor > 0) {
              currentZoom = Math.round(zoomFactor * 100);
              currentZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom));
            }
          }
        });

        document.addEventListener('wheel', function(event) {
          if (event.ctrlKey) {
            event.preventDefault();
            event.stopPropagation();

            const now = Date.now();
            if (now - lastWheelTime < DEBOUNCE_MS) {
              return;
            }
            lastWheelTime = now;

            const delta = event.deltaY;
            if (delta < 0) {
              currentZoom = Math.min(currentZoom + ZOOM_STEP, MAX_ZOOM);
            } else if (delta > 0) {
              currentZoom = Math.max(currentZoom - ZOOM_STEP, MIN_ZOOM);
            }

            const zoomFactor = currentZoom / 100;
            if (window.aiFree && window.aiFree.ui && window.aiFree.ui.setZoom) {
              window.aiFree.ui.setZoom(zoomFactor);
            }
          }
        }, { passive: false, capture: true });
      })();
    `;
    await wc.executeJavaScript(zoomScript, true);
  } catch (e) {
    console.warn('[Zoom] 注入滚轮监听脚本失败:', e?.message || e);
  }
}

module.exports = {
  injectZoomWheelListener
};
