const { app } = require('electron');

const { cleanupUpdateStorageRoot } = require('../services/app-updater');
const { initializeRunFileLogger } = require('../utils/logger');
const { getServerBase } = require('../config');
const { getCrashReporter } = require('../runtime/crash-reporter');

// 启动/打开/显示：startApp的具体业务逻辑。
function startApp() {
  const crashReports = getCrashReporter();
  crashReports?.setServerBaseResolver(getServerBase);
  crashReports?.setStartupPhase('initialize-run-logger');
  const runLogger = initializeRunFileLogger({ app, prefix: 'run' });
  crashReports?.attachRunLog(runLogger?.logFilePath);
  console.log('[启动] 主进程已加载，准备初始化应用');
  cleanupUpdateStorageRoot(null, console);

  crashReports?.setStartupPhase('bootstrap-main-app');
  const { startMainApp } = require('../bootstrap');
  startMainApp();
  crashReports?.setStartupPhase('lifecycle-registered');

  app.whenReady().then(() => {
    crashReports?.setStartupPhase('app-ready');
    const serverBase = getServerBase();
    console.log('[崩溃上报] 日志目录:', crashReports?.rootDir || '不可用');
    console.log('[崩溃上报] 独立看门狗 PID:', crashReports?.watchdogPid || '未启动');
    if (!serverBase) {
      console.warn('[崩溃上报] 尚未解析到服务器地址，报告将保留并稍后重试');
      return;
    }
    crashReports?.configure({ serverBase }).then((result) => {
      if (result?.uploaded) console.log(`[崩溃上报] 已补传 ${result.uploaded} 份报告`);
    }).catch((error) => console.warn('[崩溃上报] 启动补传失败:', error?.message || error));
  }).catch((error) => {
    crashReports?.capture('app-ready-rejected', error, {}, { fatal: true });
  });
}

startApp();
