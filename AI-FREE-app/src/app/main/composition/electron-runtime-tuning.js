// Electron 运行时调优（阶段 2D-3，自 bootstrap.js 原样迁出）：
// GPU 开关、后台节流豁免、防挂起保护。必须在 app ready 之前调用。
'use strict';

function tuneElectronRuntime({ app, fs, getStorePath }) {
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

}

module.exports = { tuneElectronRuntime };
