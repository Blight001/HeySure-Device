const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createTabManager } = require('../../src/app/main/services/tab-manager');

test('Chromium 新建标签页不经过 data URL 启动占位页', async () => {
  const chromium = new EventEmitter();
  const tabs = new Map();
  let launchedProfile = null;
  const browserRuntimeManager = {
    chromium,
    async launchProfile(profile) {
      launchedProfile = profile;
      return { status: 'ready' };
    },
    async hide() {},
    async show() {},
    async focus() {},
  };
  const mainWindow = {
    isDestroyed: () => false,
    getContentSize: () => [1200, 800],
    emit() {},
  };
  let activeTabId = null;
  const manager = createTabManager({
    browserRuntimeManager,
    getTabs: () => tabs,
    getMainWindow: () => mainWindow,
    getActiveTabId: () => activeTabId,
    setActiveTabId: (tabId) => { activeTabId = tabId; },
    getIsSidebarVisible: () => true,
    updateTabs() {},
    sendToSide() {},
    logger: { warn() {} },
  });

  await manager.addTab('chrome://newtab/', {
    tabId: 'new-tab',
    showLoadingPage: true,
  });

  assert.equal(launchedProfile.initialUrl, 'chrome://new-tab-page/');
  assert.equal(tabs.get('new-tab').runtimeUrl, 'chrome://newtab/');
});

test('主窗口最大化后 Chromium 区域保留最大化前的侧栏宽度', async () => {
  const chromium = new EventEmitter();
  const tabs = new Map();
  let launchedBounds = null;
  let activeTabId = null;
  const manager = createTabManager({
    browserRuntimeManager: {
      chromium,
      async launchProfile(_profile, bounds) {
        launchedBounds = bounds;
        return { status: 'ready' };
      },
      async hide() {},
      async show() {},
      async focus() {},
    },
    getTabs: () => tabs,
    getMainWindow: () => ({
      isDestroyed: () => false,
      isMaximized: () => true,
      getContentSize: () => [1920, 1040],
      getNormalBounds: () => ({ width: 1200, height: 800 }),
      emit() {},
    }),
    getSideView: () => ({ getBounds: () => ({ width: 360 }) }),
    getActiveTabId: () => activeTabId,
    setActiveTabId: (tabId) => { activeTabId = tabId; },
    getIsSidebarVisible: () => true,
    updateTabs() {},
    sendToSide() {},
    logger: { warn() {} },
  });

  await manager.addTab('chrome://newtab/', { tabId: 'maximized-browser' });

  assert.deepEqual(launchedBounds, { x: 0, y: 41, width: 1560, height: 999 });
});

test('浏览器启动解析 Profile 时不再传入出口 IP 探测参数', async () => {
  const chromium = new EventEmitter();
  const tabs = new Map();
  let finishProfileLookup;
  let launchCount = 0;
  const lookups = [];
  const profileLookup = new Promise((resolve) => { finishProfileLookup = resolve; });
  let activeTabId = null;
  const manager = createTabManager({
    browserRuntimeManager: {
      chromium,
      async launchProfile() {
        launchCount += 1;
        return { status: 'ready' };
      },
      async hide() {},
      async show() {},
      async focus() {},
    },
    resolveTabBrowserProfile: (options) => {
      lookups.push(options);
      return profileLookup;
    },
    getTabs: () => tabs,
    getMainWindow: () => ({ isDestroyed: () => false, getContentSize: () => [1200, 800], emit() {} }),
    getActiveTabId: () => activeTabId,
    setActiveTabId: (tabId) => { activeTabId = tabId; },
    getIsSidebarVisible: () => true,
    updateTabs() {},
    sendToSide() {},
    logger: { warn() {}, error() {} },
  });

  const creation = manager.addTab('chrome://newtab/', {
    tabId: 'async-browser',
    fixedTitle: '异步窗口',
    browserSettings: {
      proxy: { mode: 'custom', protocol: 'http', host: '127.0.0.1', port: 7897 },
    },
  });

  assert.equal(tabs.get('async-browser')?.runtimeStatus, 'starting');
  assert.equal(activeTabId, 'async-browser');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launchCount, 0);
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].geoProxyServer, undefined);
  assert.equal(lookups[0].forceGeoLookup, undefined);
  assert.equal(lookups[0].skipGeoLookup, undefined);
  assert.equal(lookups[0].httpGetUniversal, undefined);

  finishProfileLookup({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    region: 'jp',
  });
  assert.equal(await creation, 'async-browser');
  assert.equal(launchCount, 1);
  assert.equal(tabs.get('async-browser')?.runtimeStatus, 'ready');
  assert.equal(tabs.get('async-browser')?.browserProfile?.timezoneId, 'Asia/Tokyo');
});

test('自定义语言时区和位置直接生成 Chromium 启动参数', async () => {
  const chromium = new EventEmitter();
  const tabs = new Map();
  const lookups = [];
  let launchedProfile = null;
  const manager = createTabManager({
    browserRuntimeManager: {
      chromium,
      async launchProfile(profile) {
        launchedProfile = profile;
        return { status: 'ready' };
      },
      async hide() {},
      async show() {},
      async focus() {},
    },
    resolveTabBrowserProfile: async (options) => {
      lookups.push(options);
      return { locale: 'fr-FR', timezoneId: 'Europe/Paris' };
    },
    getTabs: () => tabs,
    getMainWindow: () => ({ isDestroyed: () => false, getContentSize: () => [1200, 800], emit() {} }),
    getActiveTabId: () => null,
    setActiveTabId() {},
    getIsSidebarVisible: () => true,
    updateTabs() {},
    sendToSide() {},
    logger: { warn() {}, error() {} },
  });

  await manager.addTab('chrome://newtab/', {
    tabId: 'custom-region-browser',
    hideBrowserToolbar: true,
    browserSettings: {
      language: { mode: 'custom', value: 'fr-FR' },
      timezone: { mode: 'custom', value: 'Europe/Paris' },
      geolocation: {
        permission: 'allow',
        mode: 'custom',
        longitude: 2.3522,
        latitude: 48.8566,
        accuracy: 20,
      },
    },
  });

  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].skipGeoLookup, undefined);
  assert.equal(lookups[0].forceGeoLookup, undefined);
  assert.equal(lookups[0].httpGetUniversal, undefined);
  assert.equal(launchedProfile.locale, 'fr-FR');
  assert.equal(launchedProfile.timezoneId, 'Europe/Paris');
  assert.equal(launchedProfile.hideToolbar, true);
});

test('侧栏输入中创建浏览器会在 HWND 附着完成后恢复侧栏原生焦点', async () => {
  const chromium = new EventEmitter();
  const tabs = new Map();
  const calls = [];
  let activeTabId = null;
  const browserRuntimeManager = {
    chromium,
    async launchProfile() { return { status: 'ready' }; },
    async hide() {},
    async show() {},
    async focus() { calls.push('browser-focus'); },
    releaseFocus(profileId, type) { calls.push(`release:${profileId}:${type}`); },
  };
  const manager = createTabManager({
    browserRuntimeManager,
    getTabs: () => tabs,
    getMainWindow: () => ({
      webContents: { isDestroyed: () => false, focus: () => calls.push('shell-focus') },
      isDestroyed: () => false,
      isFocused: () => true,
      getContentSize: () => [1200, 800],
      emit() {},
    }),
    getSideView: () => ({ webContents: {
      isDestroyed: () => false,
      isFocused: () => true,
      focus: () => calls.push('sidebar-focus'),
    } }),
    getActiveTabId: () => activeTabId,
    setActiveTabId: (tabId) => { activeTabId = tabId; },
    getIsSidebarVisible: () => true,
    updateTabs() {},
    sendToSide() {},
    logger: { warn() {}, error() {} },
  });

  await manager.addTab('chrome://newtab/', { tabId: 'background-browser', focusBrowser: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(calls.includes('release:background-browser:chromium'));
  assert.ok(calls.includes('sidebar-focus'));
  assert.equal(calls.includes('browser-focus'), false);
});

test('异步创建失败时移除占位并恢复之前的栏目', async () => {
  const chromium = new EventEmitter();
  const tabs = new Map([['existing-browser', {
    id: 'existing-browser', runtimeType: 'chromium', runtimeStatus: 'ready',
  }]]);
  let activeTabId = 'existing-browser';
  const manager = createTabManager({
    browserRuntimeManager: {
      chromium,
      async launchProfile() { throw new Error('launch failed'); },
      async hide() {},
      async show() {},
      async focus() {},
    },
    getTabs: () => tabs,
    getMainWindow: () => ({ isDestroyed: () => false, getContentSize: () => [1200, 800], emit() {} }),
    getActiveTabId: () => activeTabId,
    setActiveTabId: (tabId) => { activeTabId = tabId; },
    getIsSidebarVisible: () => false,
    updateTabs() {},
    sendToSide() {},
    logger: { warn() {}, error() {} },
  });

  await assert.rejects(
    manager.addTab('chrome://newtab/', { tabId: 'failed-browser' }),
    /launch failed/,
  );

  assert.deepEqual([...tabs.keys()], ['existing-browser']);
  assert.equal(activeTabId, 'existing-browser');
});

test('加载中关闭栏目会取消后续启动', async () => {
  const chromium = new EventEmitter();
  const tabs = new Map([['existing-browser', {
    id: 'existing-browser', runtimeType: 'chromium', runtimeStatus: 'ready',
  }]]);
  let activeTabId = 'existing-browser';
  let finishProfileLookup;
  let launchCount = 0;
  const profileLookup = new Promise((resolve) => { finishProfileLookup = resolve; });
  const manager = createTabManager({
    browserRuntimeManager: {
      chromium,
      async launchProfile() { launchCount += 1; return { status: 'ready' }; },
      async stop() {},
      async hide() {},
      async show() {},
      async focus() {},
    },
    resolveTabBrowserProfile: () => profileLookup,
    getTabs: () => tabs,
    getMainWindow: () => ({ isDestroyed: () => false, getContentSize: () => [1200, 800], emit() {} }),
    getActiveTabId: () => activeTabId,
    setActiveTabId: (tabId) => { activeTabId = tabId; },
    getIsSidebarVisible: () => false,
    updateTabs() {},
    sendToSide() {},
    logger: { warn() {}, error() {} },
  });

  const creation = manager.addTab('chrome://newtab/', { tabId: 'cancelled-browser' });
  await manager.closeTab('cancelled-browser');
  finishProfileLookup({ locale: 'zh-CN' });

  await assert.rejects(creation, /创建过程中关闭/);
  assert.equal(launchCount, 0);
  assert.deepEqual([...tabs.keys()], ['existing-browser']);
  assert.equal(activeTabId, 'existing-browser');
});

test('普通空白栏目不会把服务器教程地址当作默认主页', async () => {
  const chromium = new EventEmitter();
  const tabs = new Map();
  let launchedProfile = null;
  const manager = createTabManager({
    browserRuntimeManager: {
      chromium,
      async launchProfile(profile) {
        launchedProfile = profile;
        return { status: 'ready' };
      },
      async hide() {},
      async show() {},
      async focus() {},
    },
    licenseCache: {
      getRuntimeConfig: () => ({ tutorialUrl: 'https://server.example.com/tutorial' }),
    },
    getTabs: () => tabs,
    getMainWindow: () => ({ isDestroyed: () => false, getContentSize: () => [1200, 800], emit() {} }),
    getActiveTabId: () => null,
    setActiveTabId() {},
    getIsSidebarVisible: () => false,
    updateTabs() {},
    sendToSide() {},
    logger: { warn() {}, error() {} },
  });

  await manager.addTab('', { tabId: 'ordinary-browser' });

  assert.equal(launchedProfile.initialUrl, 'chrome://new-tab-page/');
  assert.equal(tabs.get('ordinary-browser')?.runtimeUrl, 'chrome://newtab/');
  assert.equal(tabs.get('ordinary-browser')?.isTutorialTab, false);
});

test('服务器更换教程地址后同步刷新已打开的教程页', async () => {
  const chromium = new EventEmitter();
  const tabs = new Map([['tutorial-browser', {
    id: 'tutorial-browser',
    runtimeType: 'chromium',
    isTutorialTab: true,
    requestedUrl: 'https://old.example.com/guide',
    runtimeUrl: 'https://old.example.com/guide',
  }]]);
  const navigations = [];
  let updateCount = 0;
  const manager = createTabManager({
    browserRuntimeManager: {
      chromium,
      async navigate(profileId, runtimeType, url) {
        navigations.push({ profileId, runtimeType, url });
      },
    },
    getTabs: () => tabs,
    getMainWindow: () => ({ isDestroyed: () => false, emit() {} }),
    getActiveTabId: () => 'tutorial-browser',
    getIsSidebarVisible: () => false,
    updateTabs() { updateCount += 1; },
    sendToSide() {},
    logger: { warn() {}, error() {} },
  });

  const result = await manager.syncTutorialTabUrl('https://new.example.com/guide');

  assert.equal(result.updated, true);
  assert.deepEqual(navigations, [{
    profileId: 'tutorial-browser',
    runtimeType: 'chromium',
    url: 'https://new.example.com/guide',
  }]);
  assert.equal(tabs.get('tutorial-browser').requestedUrl, 'https://new.example.com/guide');
  assert.equal(tabs.get('tutorial-browser').runtimeUrl, 'https://new.example.com/guide');
  assert.equal(updateCount, 1);
});

test('同步教程地址不会重新打开用户已经关闭的教程页', async () => {
  const tabs = new Map();
  let launchCount = 0;
  const manager = createTabManager({
    browserRuntimeManager: {
      chromium: new EventEmitter(),
      async launchProfile() { launchCount += 1; },
      async navigate() { throw new Error('不应导航'); },
    },
    getTabs: () => tabs,
    getMainWindow: () => ({ isDestroyed: () => false, emit() {} }),
    getActiveTabId: () => null,
    getIsSidebarVisible: () => false,
    updateTabs() {},
    sendToSide() {},
    logger: { warn() {}, error() {} },
  });

  const result = await manager.syncTutorialTabUrl('https://new.example.com/guide');

  assert.equal(result.updated, false);
  assert.equal(launchCount, 0);
  assert.equal(tabs.size, 0);
});

test('关闭最后一个浏览器后回到内置首页且不再启动 Chromium', async () => {
  const chromium = new EventEmitter();
  const tabs = new Map([['old-browser', {
    id: 'old-browser',
    runtimeType: 'chromium',
    runtimeStatus: 'ready',
  }]]);
  let activeTabId = 'old-browser';
  let launchCount = 0;
  const manager = createTabManager({
    browserRuntimeManager: {
      chromium,
      async stop() {},
      async launchProfile() { launchCount += 1; return { status: 'ready' }; },
      async hide() {},
      async show() {},
      async focus() {},
    },
    getTabs: () => tabs,
    getMainWindow: () => ({ isDestroyed: () => false, getContentSize: () => [1200, 800], emit() {} }),
    getActiveTabId: () => activeTabId,
    setActiveTabId: (tabId) => { activeTabId = tabId; },
    getIsSidebarVisible: () => false,
    updateTabs() {},
    sendToSide() {},
    logger: { warn() {}, error() {} },
  });

  await manager.closeTab('old-browser');

  assert.equal(tabs.size, 0);
  assert.equal(activeTabId, null);
  assert.equal(launchCount, 0);
});

test('切换到内置首页会隐藏当前 Chromium 并保留浏览器标签', async () => {
  const chromium = new EventEmitter();
  const tabs = new Map([['active-browser', {
    id: 'active-browser',
    runtimeType: 'chromium',
    runtimeStatus: 'ready',
  }]]);
  const hidden = [];
  let activeTabId = 'active-browser';
  let updateCount = 0;
  const manager = createTabManager({
    browserRuntimeManager: {
      chromium,
      async hide(profileId) { hidden.push(profileId); },
    },
    getTabs: () => tabs,
    getMainWindow: () => ({ isDestroyed: () => false, emit() {} }),
    getActiveTabId: () => activeTabId,
    setActiveTabId: (tabId) => { activeTabId = tabId; },
    getIsSidebarVisible: () => false,
    updateTabs() { updateCount += 1; },
    sendToSide() {},
    logger: { warn() {}, error() {} },
  });

  manager.switchTab(null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(hidden, ['active-browser']);
  assert.equal(activeTabId, null);
  assert.equal(tabs.size, 1);
  assert.equal(updateCount, 1);
});

test('Chromium 意外关闭时同步关闭对应栏目', async () => {
  const chromium = new EventEmitter();
  const tabs = new Map([
    ['browser-1', { id: 'browser-1', runtimeType: 'chromium' }],
    ['browser-2', { id: 'browser-2', runtimeType: 'chromium' }],
  ]);
  const stopped = [];
  const browserRuntimeManager = {
    chromium,
    async stop(profileId) {
      stopped.push(profileId);
    },
  };
  const mainWindow = {
    isDestroyed: () => false,
    emit() {},
  };

  createTabManager({
    browserRuntimeManager,
    getTabs: () => tabs,
    getMainWindow: () => mainWindow,
    getActiveTabId: () => 'browser-2',
    updateTabs() {},
    sendToSide() {},
    logger: { warn() {} },
  });

  chromium.emit('crashed', { profileId: 'browser-1', lastError: { message: '已退出' } });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(stopped, ['browser-1']);
  assert.equal(tabs.has('browser-1'), false);
  assert.equal(tabs.has('browser-2'), true);
});

test('软件整体退出时不由崩溃回调重复关闭栏目', async () => {
  const { appContext } = require('../../src/app/main/runtime/app-context');
  const previousShutdownState = appContext.isShuttingDown();
  appContext.setShuttingDown(true);
  try {
    const chromium = new EventEmitter();
    const tabs = new Map([['browser-1', { id: 'browser-1', runtimeType: 'chromium' }]]);
    let stopped = false;

    createTabManager({
      browserRuntimeManager: {
        chromium,
        async stop() { stopped = true; },
      },
      getTabs: () => tabs,
      getMainWindow: () => ({ isDestroyed: () => false, emit() {} }),
      getActiveTabId: () => 'browser-1',
      updateTabs() {},
      logger: { warn() {} },
    });

    chromium.emit('crashed', { profileId: 'browser-1' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(stopped, false);
    assert.equal(tabs.has('browser-1'), true);
  } finally {
    appContext.setShuttingDown(previousShutdownState);
  }
});
