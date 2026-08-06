class ChromiumHealthMonitor {
  constructor(options = {}) {
    this.intervalMs = Math.max(1000, Number(options.intervalMs) || 3000);
    this.heartbeatTimeoutMs = Math.max(this.intervalMs * 2, Number(options.heartbeatTimeoutMs) || 12000);
    this.isWindowAlive = options.isWindowAlive || (() => true);
    this.onFailure = options.onFailure || (() => {});
    this.timer = null;
  }

  start(getState) {
    this.stop();
    this.timer = setInterval(() => {
      const state = getState();
      if (!state || !['ready', 'hidden'].includes(state.status)) return;
      if (state.browserHwnd && !this.isWindowAlive(state.browserHwnd)) {
        this.onFailure({ code: 'CHROMIUM_WINDOW_LOST', message: 'Chromium 主窗口已失效' });
        return;
      }
      if (state.bridgeConnected && state.lastHeartbeatAt > 0 && Date.now() - state.lastHeartbeatAt > this.heartbeatTimeoutMs) {
        this.onFailure({ code: 'CHROMIUM_HEARTBEAT_TIMEOUT', message: 'Chromium 心跳超时' });
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { ChromiumHealthMonitor };
