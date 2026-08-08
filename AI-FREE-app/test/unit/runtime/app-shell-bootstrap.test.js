const test = require('node:test');
const assert = require('node:assert/strict');

const { createAppShellBootstrap } = require('../../../src/app/main/services/app-shell-bootstrap');

function bootstrapDeps(options = {}) {
  let bootstrapped = options.bootstrapped === true;
  const calls = {
    createMainWindow: 0,
    openTutorial: 0,
    registerIPCContext: null,
    revealMainWindow: 0,
  };
  const readStoreConfigSafe = () => ({ windowCloseBehavior: 'hide' });
  const writeStoreConfigSafe = () => true;
  const deps = {
    accountStorage: {},
    app: { getPath: () => 'C:/AI-FREE-test-user-data' },
    applyPluginSettings() {},
    createAuthCookie: () => ({}),
    createHttpClient: () => ({}),
    createMainWindow: () => { calls.createMainWindow += 1; },
    ensureAnnouncementPoller: () => ({ start() {} }),
    extensionManager: { async initialize() {} },
    fs: {
      promises: {
        readdir: async () => [],
      },
    },
    getServerBase: () => '',
    initDownloadPrefs() {},
    isControlPanelOnlyModeEnabled: () => false,
    isDevMode: false,
    licenseCache: { getRuntimeConfig: () => ({}) },
    logger: { error() {}, log() {}, warn() {} },
    path: { join: (...parts) => parts.join('/') },
    readStoreConfigSafe,
    registerIPC(context) { calls.registerIPCContext = context; },
    resolveActiveTabId: () => null,
    resolveAddTab: () => () => {},
    resolveAuth: () => ({}),
    resolveCloseTab: () => () => {},
    resolveGlobalHttpClient: () => ({}),
    resolveIsMainBootstrapped: () => bootstrapped,
    resolveMainWindow: () => (
      Object.prototype.hasOwnProperty.call(options, 'mainWindow') ? options.mainWindow : {}
    ),
    resolveOpenTutorialTab: () => () => { calls.openTutorial += 1; },
    resolveRefreshActiveTab: () => () => {},
    resolveRefreshActiveTabToUrl: () => () => {},
    resolveRefreshTab: () => () => {},
    resolveRenameTab: () => () => {},
    resolveReorderTab: () => () => {},
    resolveSetTabAccountId: () => () => {},
    resolveSetTabBrowserSettings: () => () => {},
    resolveSetZoom: () => () => {},
    resolveSideView: () => null,
    resolveSwitchTab: () => () => {},
    resolveSyncTutorialTabUrl: () => () => {},
    resolveTabs: () => new Map(),
    revealMainWindow() { calls.revealMainWindow += 1; },
    setSidebarWidth: (width) => width,
    setAuth() {},
    setIsMainBootstrapped: (value) => { bootstrapped = value; },
    statePluginGetter: () => ({}),
    updateTabs() {},
    writeStoreConfigSafe,
  };
  return { calls, deps, readStoreConfigSafe, writeStoreConfigSafe };
}

test('软件启动显示内置首页且不自动打开教程或启动浏览器', async () => {
  const { calls, deps } = bootstrapDeps();

  await createAppShellBootstrap(deps)();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.createMainWindow, 1);
  assert.equal(calls.openTutorial, 0);
});

test('主界面已初始化但窗口缺失时只重建软件外壳', async () => {
  const { calls, deps } = bootstrapDeps({ bootstrapped: true, mainWindow: null });

  await createAppShellBootstrap(deps)();

  assert.equal(calls.createMainWindow, 1);
  assert.equal(calls.revealMainWindow, 1);
  assert.equal(calls.openTutorial, 0);
});

test('启动注册 IPC 时注入窗口关闭方式的持久化依赖', async () => {
  const {
    calls,
    deps,
    readStoreConfigSafe,
    writeStoreConfigSafe,
  } = bootstrapDeps();

  await createAppShellBootstrap(deps)();

  assert.equal(calls.registerIPCContext.readStoreConfigSafe, readStoreConfigSafe);
  assert.equal(calls.registerIPCContext.writeStoreConfigSafe, writeStoreConfigSafe);
});

test('启动 IPC 保留晚绑定的全局网络魔法浏览器同步动作', async () => {
  const { calls, deps } = bootstrapDeps();
  const proxyChanges = [];
  deps.applyClashMiniBrowserProxy = async (enabled) => {
    proxyChanges.push(enabled);
    return { ok: true, updated: 2 };
  };

  await createAppShellBootstrap(deps)();
  const result = await calls.registerIPCContext.ui.applyClashMiniBrowserProxy(true);

  assert.deepEqual(result, { ok: true, updated: 2 });
  assert.deepEqual(proxyChanges, [true]);
});

test('启动 IPC 注入侧边栏宽度调整动作', async () => {
  const { calls, deps } = bootstrapDeps();

  await createAppShellBootstrap(deps)();

  assert.equal(calls.registerIPCContext.ui.setSidebarWidth(480), 480);
});
