const { createAppConsoleBridge } = require('../runtime/app-console');
const { appContext } = require('../runtime/app-context');

// 创建/初始化：createUiBridge的具体业务逻辑。
function createUiBridge({ getMainWindow, getSideView, getControlPanelWindow, getConsoleWindow }) {
  let sideView = null;
  let mainWindow = null;
  let controlPanelWindow = null;
  let consoleWindow = null;

  const appConsoleBridge = createAppConsoleBridge({
    historyLimit: 500,
    getSenders: () => {
      sideView = getSideView();
      controlPanelWindow = typeof getControlPanelWindow === 'function' ? getControlPanelWindow() : null;
      consoleWindow = typeof getConsoleWindow === 'function' ? getConsoleWindow() : null;
      const senders = [];
      if (sideView && sideView.webContents && !sideView.webContents.isDestroyed()) {
        senders.push(sideView.webContents);
      }
      if (controlPanelWindow && controlPanelWindow.webContents && !controlPanelWindow.webContents.isDestroyed()) {
        senders.push(controlPanelWindow.webContents);
      }
      if (consoleWindow && consoleWindow.webContents && !consoleWindow.webContents.isDestroyed()) {
        senders.push(consoleWindow.webContents);
      }
      return senders;
    },
    getDebugSenders: () => {
      consoleWindow = typeof getConsoleWindow === 'function' ? getConsoleWindow() : null;
      if (consoleWindow && consoleWindow.webContents && !consoleWindow.webContents.isDestroyed()) {
        return [consoleWindow.webContents];
      }
      return [];
    },
  });

  appConsoleBridge.install();
  // 供底层网络模块使用，刻意不回退到 console.*，避免调试专用日志泄漏到终端。
  appContext.setDebugConsoleWrite((level, args) => appConsoleBridge.pushDebugOnly(level, args));

// 处理：sendToSide的具体业务逻辑。
  function sendToSide(channel, ...args) {
    try {
      let delivered = false;
      sideView = getSideView();
      mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
      controlPanelWindow = typeof getControlPanelWindow === 'function' ? getControlPanelWindow() : null;
      if (sideView && sideView.webContents && !sideView.webContents.isDestroyed()) {
        sideView.webContents.send(channel, ...args);
        delivered = true;
      }
      if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(channel, ...args);
        delivered = true;
      }
      if (controlPanelWindow && controlPanelWindow.webContents && !controlPanelWindow.webContents.isDestroyed()) {
        controlPanelWindow.webContents.send(channel, ...args);
        delivered = true;
      }
      return delivered;
    } catch (_) {
      return false;
    }
  }

  return {
    sendToSide,
    getAppConsoleHistory: () => appConsoleBridge.getHistory(),
    getDebugConsoleHistory: () => appConsoleBridge.getDebugHistory(),
  };
}

module.exports = {
  createUiBridge,
};
