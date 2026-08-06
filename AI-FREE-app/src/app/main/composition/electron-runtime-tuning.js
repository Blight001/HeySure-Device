// Electron 运行时调优（阶段 2D-3，自 bootstrap.js 原样迁出）：
// GPU 开关、后台节流豁免、防挂起保护。必须在 app ready 之前调用。
'use strict';

function tuneElectronRuntime({ app, fs, powerSaveBlocker, getStorePath }) {
  // Electron 的 GPU 开关必须在 ready 之前设置；侧栏保存后会在下次应用启动时读取。
  try {
    const storePath = getStorePath();
    if (storePath && fs.existsSync(storePath)) {
      const store = JSON.parse(fs.readFileSync(storePath, 'utf8') || '{}');
      if (store?.aiFreeBrowserSettings?.hardwareAcceleration === false) app.disableHardwareAcceleration();
    }
  } catch (error) {
    console.warn('[BrowserSettings] 读取硬件加速启动配置失败:', error?.message || error);
  }

  // 自动化任务必须与窗口可见性解耦。Chromium 默认会冻结最小化、被遮挡
  // 或移出 BrowserWindow 的页面，导致扩展定时器、Socket 和脚本执行中断。
  for (const switchName of [
    'disable-renderer-backgrounding',
    'disable-background-timer-throttling',
    'disable-backgrounding-occluded-windows',
  ]) {
    app.commandLine.appendSwitch(switchName);
  }

  let automationPowerBlockerId = null;
  app.whenReady().then(() => {
    try {
      if (automationPowerBlockerId === null && powerSaveBlocker && typeof powerSaveBlocker.start === 'function') {
        automationPowerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      }
    } catch (error) {
      console.warn('[AutomationRuntime] 无法启用后台运行保护:', error?.message || error);
    }
  });
  app.once('will-quit', () => {
    try {
      if (
        automationPowerBlockerId !== null
        && powerSaveBlocker
        && typeof powerSaveBlocker.isStarted === 'function'
        && powerSaveBlocker.isStarted(automationPowerBlockerId)
      ) {
        powerSaveBlocker.stop(automationPowerBlockerId);
      }
    } catch (_) {}
    automationPowerBlockerId = null;
  });
}

module.exports = { tuneElectronRuntime };
