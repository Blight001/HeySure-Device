'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('侧边栏状态事件同时投递到内嵌浏览器配置首页', () => {
  const consoleModulePath = require.resolve('../../../src/app/main/runtime/app-console');
  const bridgeModulePath = require.resolve('../../../src/app/main/composition/create-ui-bridge');
  const originalConsoleModule = require.cache[consoleModulePath];
  const originalBridgeModule = require.cache[bridgeModulePath];
  let debugSenders = null;
  require.cache[consoleModulePath] = {
    id: consoleModulePath,
    filename: consoleModulePath,
    loaded: true,
    exports: {
      createAppConsoleBridge: (options) => {
        debugSenders = options.getDebugSenders;
        return {
          install() {},
          pushDebugOnly() {},
          getHistory: () => [],
          getDebugHistory: () => [],
        };
      },
    },
    children: [],
    paths: [],
  };
  delete require.cache[bridgeModulePath];

  try {
    const { createUiBridge } = require(bridgeModulePath);
    const sidebarEvents = [];
    const mainEvents = [];
    const makeView = (events) => ({
      webContents: {
        isDestroyed: () => false,
        send: (...args) => events.push(args),
      },
    });
    const bridge = createUiBridge({
      getMainWindow: () => makeView(mainEvents),
      getSideView: () => makeView(sidebarEvents),
      getControlPanelWindow: () => null,
      isDevMode: true,
    });

    assert.equal(bridge.sendToSide('clash-mini-status', { running: true }), true);
    assert.deepEqual(sidebarEvents, [['clash-mini-status', { running: true }]]);
    assert.deepEqual(mainEvents, [['clash-mini-status', { running: true }]]);
    assert.equal(debugSenders().length, 1, '开发模式调试日志应投递到侧边栏 WebContents');
  } finally {
    if (originalConsoleModule) require.cache[consoleModulePath] = originalConsoleModule;
    else delete require.cache[consoleModulePath];
    if (originalBridgeModule) require.cache[bridgeModulePath] = originalBridgeModule;
    else delete require.cache[bridgeModulePath];
  }
});
