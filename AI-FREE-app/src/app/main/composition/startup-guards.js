const { app } = require('electron');

// 设置/更新/持久化：applyWindowsAppUserModelId的具体业务逻辑。
function applyWindowsAppUserModelId() {
  if (process.platform !== 'win32') return;

  try {
    const pkg = require('../../../../package.json');
// 处理：appId的具体业务逻辑。
    const appId = (pkg && pkg.build && pkg.build.appId) || pkg.name || 'com.ai-free.app';
    app.setAppUserModelId(appId);
  } catch (_) {}
}

// 处理：acquireSingleInstance的具体业务逻辑。
function acquireSingleInstance({ onSecondInstance }) {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
    return false;
  }

  if (typeof onSecondInstance === 'function') {
    app.on('second-instance', onSecondInstance);
  }
  return true;
}

module.exports = {
  acquireSingleInstance,
  applyWindowsAppUserModelId,
};
