'use strict';

const { createWindowBackgroundController } = require('../features/window/window-background-controller');
const { clampSidebarWidth, resolveSidebarWidth } = require('../../shared/sidebar-layout');
const { createAppShellWindowStateController } = require('./app-shell-window-state');

function createWindowInstance(deps, windowStateController) {
  const iconPath = typeof deps.resolveAppIconPath === 'function'
    ? deps.resolveAppIconPath()
    : deps.path.join(__dirname, '../../../', deps.FIXED_ICON_RELATIVE_PATH);
  const mainWindow = new deps.BrowserWindow({
    ...windowStateController.getWindowOptions(),
    title: deps.APP_DISPLAY_NAME,
    icon: iconPath,
    show: false,
    frame: true,
    titleBarStyle: 'default',
    autoHideMenuBar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: deps.path.join(__dirname, '../preload.js'),
    },
  });
  mainWindow.maximize();
  windowStateController.bindWindow(mainWindow);
  return mainWindow;
}

function configureWindowMenu(deps, mainWindow) {
  try {
    deps.Menu.setApplicationMenu(null);
    mainWindow.setMenu(null);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.setAutoHideMenuBar(true);
  } catch (error) {
    deps.logger.warn?.('[WindowMenu] 清理菜单栏失败:', error?.message || error);
  }
}

function createSidebarView(deps, mainWindow) {
  const sideView = new deps.WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: deps.path.join(__dirname, '../preload.js'),
    },
  });
  deps.setSideView?.(sideView);
  mainWindow.contentView.addChildView(sideView);
  deps.attachContextMenu(sideView.webContents, {
    addTab: deps.resolveAddTab(),
    downloadOrSaveMedia: deps.downloadOrSaveMedia,
    tabs: deps.resolveTabs(),
    activeTabId: deps.resolveActiveTabId(),
    refreshPage: deps.resolveRefreshActiveTab(),
  });
  try { deps.resolveAuth()?.applyZhHantRequestPrefs(sideView.webContents.session, sideView.webContents); } catch (_) {}
  return sideView;
}

function relaySidebarConsole(deps, details) {
  if (!details || typeof details !== 'object') return;
  const message = typeof details.message === 'string' ? details.message : '';
  const methods = { debug: 'log', info: 'log', warning: 'warn', error: 'error' };
  deps.logger[methods[details.level] || 'log']?.(message);
}

function loadSidebar(deps, sideView) {
  const sidebarLocalPath = deps.resolveControlPanelHtmlPath('ai-control.html');
  if (!sidebarLocalPath) {
    deps.logger.error?.('[启动] 未找到本地 src/app/sidebar/ai-control.html，侧边栏无法加载');
    return;
  }
  deps.logger.log?.('[启动] 加载本地侧边栏:', sidebarLocalPath);
  sideView.webContents.loadFile(sidebarLocalPath, {
    query: { dev: deps.isDevMode ? '1' : '0' },
  }).catch((error) => {
    deps.logger.error?.('[启动] 本地侧边栏加载失败:', error?.message || error);
  });
}

async function handleSidebarLoaded(deps, mainWindow) {
  deps.setSideAnnouncementReady(true);
  try {
    if (deps.canPollAnnouncements()) {
      await deps.ensureAnnouncementPoller().refreshNow();
    }
  } catch (error) {
    deps.logger.warn?.('[公告轮询] 侧边栏加载完成后刷新失败:', error?.message || error);
  }
  deps.sendToSide('update-device-id', await deps.computeDeviceId());
  try {
    const history = typeof deps.getAppConsoleHistory === 'function' ? deps.getAppConsoleHistory() : [];
    deps.sendToSide('app-console-history', history);
  } catch (_) {}
  try { deps.sendToSide('app-version', deps.app.getVersion()); } catch (_) {}
  setTimeout(async () => {
    try {
      await deps.checkDesktopShortcutAndPrompt(mainWindow, deps.sendToSide);
    } catch (error) {
      deps.logger.warn?.('[Startup] 桌面快捷方式检查失败:', error?.message || error);
    }
  }, 1000);
}

function bindSidebarEvents(deps, sideView, mainWindow) {
  sideView.webContents.on('console-message', (details) => relaySidebarConsole(deps, details));
  sideView.webContents.on('did-start-loading', () => deps.setSideAnnouncementReady(false));
  sideView.webContents.on('did-finish-load', () => handleSidebarLoaded(deps, mainWindow));
  sideView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    deps.logger.warn?.('[启动] 远程侧边栏加载失败:', { errorCode, errorDescription, validatedURL });
  });
}

function resolveLayout(deps, mainWindow, sideView) {
  const [width, height] = mainWindow.getContentSize();
  const tabBarHeight = 41;
  const isSidebarVisible = deps.getIsSidebarVisible ? deps.getIsSidebarVisible() : true;
  const sideViewWidth = resolveSidebarWidth({
    contentWidth: width,
    isVisible: isSidebarVisible,
    isMaximized: mainWindow.isMaximized?.() === true,
    currentWidth: sideView?.getBounds?.().width,
    normalWindowWidth: mainWindow.getNormalBounds?.().width,
    preferredWidth: deps.getPreferredSidebarWidth?.(),
  });
  const activeTab = deps.resolveTabs().get(deps.resolveActiveTabId());
  return {
    width,
    tabBarHeight,
    tabContentHeight: height - tabBarHeight,
    isSidebarVisible,
    sideViewWidth,
    activeTab,
    chromiumBounds: activeTab?.runtimeType === 'chromium'
      ? { x: 0, y: tabBarHeight, width: width - sideViewWidth, height: height - tabBarHeight }
      : null,
  };
}

function updateMainWindowLayout(deps, mainWindow) {
  const sideView = deps.getSideView?.();
  const layout = resolveLayout(deps, mainWindow, sideView);
  if (sideView && layout.isSidebarVisible) {
    sideView.setBounds({
      x: layout.width - layout.sideViewWidth,
      y: layout.tabBarHeight,
      width: layout.sideViewWidth,
      height: layout.tabContentHeight,
    });
  }
  sideView?.setVisible?.(layout.isSidebarVisible);
  if (!layout.activeTab || !layout.chromiumBounds) return;
  void deps.browserRuntimeManager?.resize(layout.activeTab.id, 'chromium', layout.chromiumBounds)
    .then(() => deps.updateTabs?.())
    .catch((error) => deps.logger.warn?.('[ChromiumRuntime] 同步窗口尺寸失败:', error?.message || error));
}

function handleMainWindowClosed(deps) {
  try {
    const panel = deps.resolveControlPanelWindow();
    if (panel && !panel.isDestroyed()) panel.close();
  } catch (_) {}
  deps.setMainWindow?.(null);
}

function bindMainWindowEvents(deps, mainWindow) {
  const updateLayout = () => updateMainWindowLayout(deps, mainWindow);
  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(() => deps.updateTabs(true), 0);
    mainWindow.setTitle(deps.APP_DISPLAY_NAME);
    deps.logger.log?.('[WindowTitle] did-finish-load, set title:', deps.APP_DISPLAY_NAME);
  });
  mainWindow.on('focus', () => setTimeout(() => deps.updateTabs(true), 0));
  mainWindow.on('resize', updateLayout);
  mainWindow.on('ready-to-show', updateLayout);
  mainWindow.on('closed', () => handleMainWindowClosed(deps));
}

function scheduleControlPanel(deps) {
  if (!deps.isControlPanelModeEnabled()) return;
  setTimeout(() => {
    try {
      deps.createControlPanelWindow();
    } catch (error) {
      deps.logger.warn?.('[启动] 创建控制页窗口失败:', error?.message || error);
    }
  }, 0);
}

function createMainWindow(deps, backgroundController, windowStateController) {
  const mainWindow = createWindowInstance(deps, windowStateController);
  deps.setMainWindow?.(mainWindow);
  mainWindow.loadFile(deps.path.join(__dirname, '../../views/app-shell.html'));
  configureWindowMenu(deps, mainWindow);
  mainWindow.setTitle(deps.APP_DISPLAY_NAME);
  bindMainWindowEvents(deps, mainWindow);
  const sideView = createSidebarView(deps, mainWindow);
  bindSidebarEvents(deps, sideView, mainWindow);
  loadSidebar(deps, sideView);
  scheduleControlPanel(deps);
  backgroundController.bindWindow(mainWindow);
  return mainWindow;
}

function revealMainWindow(deps) {
  try {
    const mainWindow = deps.resolveMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } catch (error) {
    deps.logger.warn?.('[启动] 显示主窗口失败:', error?.message || error);
  }
}

function createAppShellMainWindowController(deps = {}) {
  const backgroundController = createWindowBackgroundController(deps);
  const windowStateController = createAppShellWindowStateController(deps);
  let preferredSidebarWidth = windowStateController.getSidebarWidth();
  const controllerDeps = {
    ...deps,
    getPreferredSidebarWidth: () => preferredSidebarWidth,
  };
  const setSidebarWidth = (requestedWidth) => {
    const mainWindow = deps.resolveMainWindow?.();
    const isSidebarVisible = deps.getIsSidebarVisible ? deps.getIsSidebarVisible() : true;
    if (!mainWindow || mainWindow.isDestroyed?.() || !isSidebarVisible) return 0;
    preferredSidebarWidth = clampSidebarWidth(requestedWidth, mainWindow.getContentSize?.()[0]);
    if (preferredSidebarWidth === 0) return 0;
    windowStateController.setSidebarWidth(preferredSidebarWidth);
    updateMainWindowLayout(controllerDeps, mainWindow);
    return preferredSidebarWidth;
  };
  return {
    createMainWindow: () => createMainWindow(controllerDeps, backgroundController, windowStateController),
    revealMainWindow: () => backgroundController.revealWindow() || revealMainWindow(deps),
    setSidebarWidth,
  };
}

module.exports = { createAppShellMainWindowController };
