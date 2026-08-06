const {
  getActiveTabWebContents,
  resolveTabTitle,
  toggleSidebarVisibility,
} = require('./tab-common');
const { buildTabsPayload: buildPayload, getTabsSignature } = require('./tab-payload');

// 创建/初始化：createTabHelpers的具体业务逻辑。
function createTabHelpers(deps = {}) {
  const {
    logger = console,
    getTabs,
    getMainWindow,
    getSideView,
    getActiveTabId,
    setIsSidebarVisible,
    sendToSide,
    browserRuntimeManager,
  } = deps;

// 获取/读取/解析：resolveTabs的具体业务逻辑。
  const resolveTabs = () => (typeof getTabs === 'function' ? getTabs() : new Map());
// 获取/读取/解析：resolveMainWindow的具体业务逻辑。
  const resolveMainWindow = () => (typeof getMainWindow === 'function' ? getMainWindow() : null);
// 获取/读取/解析：resolveSideView的具体业务逻辑。
  const resolveSideView = () => (typeof getSideView === 'function' ? getSideView() : null);
// 获取/读取/解析：resolveActiveTabId的具体业务逻辑。
  const resolveActiveTabId = () => (typeof getActiveTabId === 'function' ? getActiveTabId() : null);
// 获取/读取/解析：resolveIsSidebarVisible的具体业务逻辑。
  const resolveIsSidebarVisible = () => (typeof deps.getIsSidebarVisible === 'function' ? deps.getIsSidebarVisible() : true);

  let tabsUpdateTimer = null;
  let lastTabsSignature = '';

  function buildTabsPayload() {
    return buildPayload({ browserRuntimeManager, resolveActiveTabId, resolveTabs });
  }

// 设置/更新/持久化：updateTabs的具体业务逻辑。
  function updateTabs(force = false) {
    try {
      const mainWindow = resolveMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (tabsUpdateTimer) {
        clearTimeout(tabsUpdateTimer);
        tabsUpdateTimer = null;
      }

// 处理：sendUpdate的具体业务逻辑。
      const sendUpdate = () => {
        const win = resolveMainWindow();
        if (!win || win.isDestroyed()) return;
        const tabData = buildTabsPayload();
        const signature = getTabsSignature(tabData);
        if (!force && signature && signature === lastTabsSignature) return;
        lastTabsSignature = signature;
        win.webContents.send('update-tabs', tabData);
        const sideView = resolveSideView();
        if (sideView && sideView.webContents && !sideView.webContents.isDestroyed()) {
          sideView.webContents.send('update-tabs', tabData);
        }
      };

      if (force) {
        sendUpdate();
      } else {
        tabsUpdateTimer = setTimeout(sendUpdate, 120);
      }
    } catch (_) {}
  }

// 获取/读取/解析：getActiveWC的具体业务逻辑。
  function getActiveWC() {
    return getActiveTabWebContents(resolveTabs(), resolveActiveTabId());
  }

// 设置/更新/持久化：toggleSidebar的具体业务逻辑。
  function toggleSidebar() {
    return toggleSidebarVisibility({
      getIsSidebarVisible: resolveIsSidebarVisible,
      setIsSidebarVisible,
      getMainWindow: resolveMainWindow,
      getSideView: resolveSideView,
      logger,
      logPrefix: 'TabHelpers',
    });
  }

  return {
    buildTabsPayload,
    getTabsSignature,
    updateTabs,
    getActiveWC,
    resolveTabTitle,
    toggleSidebar,
  };
}

module.exports = {
  createTabHelpers,
};
