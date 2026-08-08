const { BrowserWindow, nativeTheme } = require('electron');
const { resolveTabTitle } = require('../../services/tab-common');
const { createTabContextMenuController } = require('../../features/browser/tab-context-menu-controller');
const { createSidebarFocusHandler } = require('../../features/browser/sidebar-focus-controller');
const {
  readWindowCloseBehavior,
  writeWindowCloseBehavior,
} = require('../../features/window/window-close-preference');

function uiIpcError(error) {
  return error?.message || String(error);
}

function normalizeAppTheme(theme) {
  const value = String(theme || '').trim();
  return value === 'light' || value === 'gold' ? value : 'dark';
}

function sendThemeToContents(webContents, theme) {
  try {
    if (webContents && !webContents.isDestroyed()) webContents.send('app-theme-changed', theme);
  } catch (_) {}
}

function createThemeController(ui) {
  let currentTheme = 'dark';
  return {
    current: () => currentTheme,
    broadcast(theme) {
      currentTheme = normalizeAppTheme(theme);
      try { if (nativeTheme) nativeTheme.themeSource = currentTheme === 'light' ? 'light' : 'dark'; } catch (_) {}
      try {
        const mainWindow = ui?.getMainWindow?.();
        if (mainWindow && !mainWindow.isDestroyed()) {
          const backgrounds = { light: '#f6f9fd', gold: '#0c0b09', dark: '#0f1115' };
          mainWindow.setBackgroundColor(backgrounds[currentTheme]);
          sendThemeToContents(mainWindow.webContents, currentTheme);
        }
      } catch (_) {}
      try { ui?.sendToSide?.('app-theme-changed', currentTheme); } catch (_) {}
    },
  };
}

function browserDataClearCapability(ui, profileId) {
  const manager = ui?.browserRuntimeManager;
  return Boolean(profileId && manager && typeof manager.clearData === 'function');
}

function validateBrowserDataClearRequest(ui, payload) {
  const profileId = String(payload?.profileId || '').trim();
  if (!browserDataClearCapability(ui, profileId)) return { error: { ok: false, message: '当前浏览器不支持清空数据' } };
  const tab = ui?.getTabs?.().get?.(profileId);
  if (!tab) return { error: { ok: false, message: '浏览器窗口不存在' } };
  const contents = ui?.getSideView?.()?.webContents;
  if (!contents || contents.isDestroyed?.()) {
    return { error: { ok: false, message: '侧边栏尚未就绪，无法显示确认弹窗' } };
  }
  return { profileId, tab, contents };
}

function validateBrowserDataClearResolution(ui, event, payload, pendingRequests) {
  const requestId = String(payload?.requestId || '').trim();
  const pending = pendingRequests.get(requestId);
  if (!pending) return { error: { ok: false, message: '清空请求已失效，请重新操作' } };
  const contents = ui?.getSideView?.()?.webContents;
  if (!contents || contents.id !== event.sender?.id) {
    return { error: { ok: false, message: '只能从侧边栏确认清空操作' } };
  }
  return { requestId, pending };
}

function createBrowserDataClearController(ui, closeContextMenu) {
  const pendingRequests = new Map();

  async function request(payload = {}) {
    try {
      const validated = validateBrowserDataClearRequest(ui, payload);
      if (validated.error) return validated.error;
      const { profileId, tab, contents } = validated;
      closeContextMenu();
      ui?.ensureSidebarVisible?.();
      const requestId = `browser-data-clear-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timeout = setTimeout(() => pendingRequests.delete(requestId), 120000);
      pendingRequests.set(requestId, { profileId, timeout });
      contents.send('browser-data-clear-confirm-request', { requestId, profileId, title: resolveTabTitle(tab) });
      return { ok: true, pending: true };
    } catch (error) {
      return { ok: false, message: uiIpcError(error) };
    }
  }

  async function resolve(event, payload = {}) {
    const validated = validateBrowserDataClearResolution(ui, event, payload, pendingRequests);
    if (validated.error) return validated.error;
    const { requestId, pending } = validated;
    clearTimeout(pending.timeout);
    pendingRequests.delete(requestId);
    if (payload?.confirmed !== true) return { ok: true, cancelled: true };
    try {
      if (!ui?.getTabs?.().get?.(pending.profileId)) return { ok: false, message: '浏览器窗口不存在' };
      const state = await ui.browserRuntimeManager.clearData(pending.profileId);
      return { ok: true, state };
    } catch (error) {
      return { ok: false, message: uiIpcError(error) };
    }
  }

  return { request, resolve };
}

function getManagedTabs(ui) {
  return typeof ui?.getTabs === 'function' ? ui.getTabs() : new Map();
}

function getManagedActiveTabId(ui) {
  return typeof ui?.getActiveTabId === 'function' ? ui.getActiveTabId() : null;
}

function findManagedTabById(ui, tabId) {
  const id = String(tabId || '').trim();
  if (!id) return null;
  const tabs = getManagedTabs(ui);
  if (typeof tabs.get === 'function' && tabs.has(id)) return tabs.get(id);
  try {
    for (const tab of tabs.values()) {
      if (String(tab?.id || '').trim() === id) return tab;
    }
  } catch (_) {}
  return null;
}

function serializeManagedTab(ui, tab) {
  if (!tab) return null;
  const id = String(tab.id || '');
  return {
    id,
    appTabId: id,
    title: resolveTabTitle(tab),
    url: String(tab.runtimeUrl || ''),
    active: id === String(getManagedActiveTabId(ui) || ''),
    accountId: String(tab.accountId || '').trim(),
    runtimeType: 'chromium',
  };
}

function listManagedTabs(ui) {
  const tabs = Array.from(getManagedTabs(ui).values()).map((tab) => serializeManagedTab(ui, tab)).filter(Boolean);
  return {
    ok: true,
    activeTabId: String(getManagedActiveTabId(ui) || ''),
    tabs,
    activeTab: tabs.find((tab) => tab.active) || null,
  };
}

function normalizeBridgeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('缺少 URL');
  if (value === 'about:blank') return value;
  try { return new URL(value).href; } catch (_) { return new URL(`https://${value}`).href; }
}

function createTabBridgeActions(ui) {
  const resultTabs = () => listManagedTabs(ui).tabs;
  return {
    'tab:identify': async ({ activeTab }) => ({ ok: true, tab: serializeManagedTab(ui, activeTab), tabs: resultTabs() }),
    'tab:list': async () => listManagedTabs(ui),
    'tab:switch': async ({ targetTab }) => {
      if (!targetTab?.id || typeof ui.switchTab !== 'function') return { ok: false, message: '目标标签不存在或无法切换' };
      ui.switchTab(targetTab.id);
      return { ok: true, action: 'switch', tab: serializeManagedTab(ui, targetTab), tabs: resultTabs() };
    },
    'tab:close': async ({ targetTab }) => {
      if (!targetTab?.id || typeof ui.closeTab !== 'function') return { ok: false, message: '目标标签不存在或无法关闭' };
      const closing = serializeManagedTab(ui, targetTab);
      await ui.closeTab(targetTab.id);
      return { ok: true, action: 'close', tab: closing, tabs: resultTabs() };
    },
    'tab:open': async ({ targetTab, payload }) => {
      if (typeof ui.addTab !== 'function') return { ok: false, message: '打开标签功能不可用' };
      const openedId = await ui.addTab(normalizeBridgeUrl(payload?.url), {
        browserSettings: targetTab?.browserSettings, runtimeType: 'chromium',
      });
      return { ok: true, action: 'open', tab: serializeManagedTab(ui, findManagedTabById(ui, openedId)), tabs: resultTabs() };
    },
    'tab:replace': async ({ targetTab, payload }) => {
      if (!targetTab?.id || !ui?.browserRuntimeManager) return { ok: false, message: '目标网页不可用' };
      if (typeof ui.switchTab === 'function') ui.switchTab(targetTab.id);
      await ui.browserRuntimeManager.navigate(targetTab.id, 'chromium', normalizeBridgeUrl(payload?.url));
      return { ok: true, action: 'replace', tab: serializeManagedTab(ui, targetTab), tabs: resultTabs() };
    },
    'tab:history': async () => ({ ok: false, message: '内置 Chromium 暂未开放前进/后退桥接' }),
    'tab:reload': async ({ targetTab }) => {
      if (!targetTab?.id || typeof ui.refreshTab !== 'function') return { ok: false, message: '目标网页不可用' };
      const result = await ui.refreshTab(targetTab.id);
      return result?.ok ? { ok: true, action: 'reload', tab: serializeManagedTab(ui, targetTab) } : result;
    },
    'tab:capture': async () => ({ ok: false, message: '请通过 Chromium 内的 AI-FREE 自动化扩展执行截图' }),
  };
}

function createTabBridgeHandler(ui) {
  const actions = createTabBridgeActions(ui);
  return async (_event, payload = {}) => {
    try {
      const command = String(payload?.command || payload?.action || '').trim();
      const activeTab = findManagedTabById(ui, getManagedActiveTabId(ui));
      const targetTab = findManagedTabById(ui, payload?.appTabId || payload?.tabId) || activeTab;
      const action = actions[command];
      if (!action) return { ok: false, message: `未知 MCP 浏览器桥接命令: ${command || '(empty)'}` };
      return action({ activeTab, targetTab, payload });
    } catch (error) {
      return { ok: false, message: uiIpcError(error) };
    }
  };
}

function registerBrowserRuntimeIPC(ipc, ui, clearController) {
  ipc.handle('get-browser-runtime-state', async (_event, payload = {}) => {
    const manager = ui?.browserRuntimeManager;
    if (!manager) return { ok: false, message: 'Browser Runtime 不可用' };
    const profileId = String(payload?.profileId || '').trim();
    return { ok: true, nativeHostAvailable: manager.isChromiumAvailable(), state: profileId ? manager.getState(profileId) : null, states: manager.listStates() };
  });
  ipc.handle('restart-browser-runtime', async (_event, payload = {}) => {
    const profileId = String(payload?.profileId || '').trim();
    if (!profileId || !ui?.browserRuntimeManager) return { ok: false, message: '缺少 Chromium Profile ID' };
    try { return { ok: true, state: await ui.browserRuntimeManager.restart(profileId) }; }
    catch (error) { return { ok: false, message: uiIpcError(error) }; }
  });
  ipc.handle('clear-browser-runtime-data', (_event, payload) => clearController.request(payload));
  ipc.handle('resolve-browser-data-clear-confirm', (event, payload) => clearController.resolve(event, payload));
}

function registerTabIPC(ipc, ui, contextMenu) {
  ipc.on('add-tab', (_event, url) => ui.addTab(url));
  ipc.on('switch-tab', (_event, tabId) => ui.switchTab(tabId));
  ipc.on('close-tab', (_event, tabId) => { void ui.closeTab(tabId); });
  ipc.handle('show-tab-context-menu', async (event, payload = {}) => {
    try {
      const tabId = String(payload?.tabId || '').trim();
      if (!tabId) return { ok: false, message: '缺少标签 ID' };
      const opened = contextMenu.openTabContextMenuWindow({
        tabId,
        x: Number(payload?.x ?? 0),
        y: Number(payload?.y ?? 0),
        parentWindow: BrowserWindow.fromWebContents(event.sender),
      });
      return opened ? { ok: true } : { ok: false, message: '打开浏览器菜单失败' };
    } catch (error) { return { ok: false, message: uiIpcError(error) }; }
  });
  ipc.handle('get-tabs-state', async () => {
    try {
      const activeId = getManagedActiveTabId(ui);
      const tabs = Array.from(getManagedTabs(ui).values()).map((tab) => ({
        id: tab.id, title: resolveTabTitle(tab), isActive: tab.id === activeId, accountId: String(tab.accountId || '').trim(),
      }));
      return { ok: true, tabs };
    } catch (error) { return { ok: false, error: uiIpcError(error), tabs: [] }; }
  });
  ipc.handle('browser-mcp-bridge', createTabBridgeHandler(ui));
  ipc.handle('refresh-tab', async (_event, tabId) => {
    try { return ui.refreshTab ? ui.refreshTab(tabId) : { ok: false, message: '刷新功能不可用' }; }
    catch (error) { return { ok: false, message: uiIpcError(error) }; }
  });
  ipc.on('reorder-tab', (_event, payload = {}) => {
    try { ui.reorderTab?.(payload.tabId, payload.targetTabId, payload.position); } catch (_) {}
  });
}

function readSidebarWidth(sideView) {
  if (!sideView) return 0;
  const bounds = sideView.getBounds?.();
  return Number(bounds?.width) || 0;
}

function registerUiUtilityIPC(ipc, ctx) {
  const { ui } = ctx;
  ipc.handle('set-sidebar-width', async (event, payload = {}) => {
    const sideView = ui.getSideView?.();
    const sideContents = sideView?.webContents;
    if (payload.width === undefined) {
      return { ok: true, width: readSidebarWidth(sideView) };
    }
    if (!sideContents || sideContents.isDestroyed?.() || sideContents.id !== event.sender?.id) {
      return { ok: false, message: '当前页面不是内嵌侧边栏' };
    }
    const width = ui.setSidebarWidth?.(payload.width) || 0;
    return width > 0 ? { ok: true, width } : { ok: false, message: '侧边栏当前不可调整' };
  });
  ipc.handle('get-window-close-behavior', async () => ({
    ok: true,
    data: { behavior: readWindowCloseBehavior(ctx.readStoreConfigSafe) },
  }));
  ipc.handle('set-window-close-behavior', async (_event, payload = {}) => (
    writeWindowCloseBehavior(
      ctx.readStoreConfigSafe,
      ctx.writeStoreConfigSafe,
      String(payload?.behavior || ''),
    )
  ));
  ipc.on('toggle-sidebar', () => ui.toggleSidebar());
  ipc.on('ensure-sidebar-visible', () => ui.ensureSidebarVisible?.());
  ipc.on('request-account-center', () => {
    try {
      ui.ensureSidebarVisible?.();
      const contents = ui.getSideView?.()?.webContents;
      if (contents && !contents.isDestroyed?.()) contents.send('open-account-center');
    } catch (_) {}
  });
  ipc.handle('open-active-web-console', async () => {
    try {
      const contents = ui.getActiveWC?.();
      if (!contents || contents.isDestroyed?.()) return { ok: false, message: '当前没有可查看控制台的网页' };
      if (contents.isDevToolsOpened?.()) {
        try { contents.devToolsWebContents?.focus?.(); } catch (_) {}
        return { ok: true, opened: true, alreadyOpen: true };
      }
      contents.openDevTools({ mode: 'detach' });
      return { ok: true, opened: true, alreadyOpen: false };
    } catch (error) { return { ok: false, message: uiIpcError(error) }; }
  });
  ipc.on('reveal-cookie-import', () => {
    try { ui.sendToSide?.('cookie-import-unlock'); ui.ensureSidebarVisible?.(); } catch (_) {}
  });
  ipc.on('set-zoom', (_event, zoomFactor) => ui.setZoom(zoomFactor));
  ipc.on('refresh-active-tab-to-url', (_event, url) => ui.refreshActiveTabToUrl(url));
  ipc.on('refresh-active-tab', () => ui.refreshActiveTab());
  ipc.on('smart-refresh-active-tab', async () => {
    try {
      const contents = ui.getActiveWC?.();
      if (!contents || contents.isDestroyed?.()) return;
      const url = contents.getURL?.() || '';
      if (String(url).startsWith('https://dreamina.capcut.com/ai-tool/')) {
        const targetUrl = typeof ctx.getDreamTargetUrl === 'function' ? ctx.getDreamTargetUrl() : ctx.DREAM_TARGET_URL;
        ui.refreshActiveTabToUrl(targetUrl);
      } else ui.refreshActiveTab();
    } catch (_) {}
  });
  ipc.handle('focus-sidebar-input', createSidebarFocusHandler(ui));
  ipc.on('open-tutorial', (_event, url) => { void ui?.openTutorialTab?.(url); });
}

function registerUiIPC(ctx) {
  const ipc = ctx.ipc.scope('register/ui');
  const contextMenu = createTabContextMenuController();
  const theme = createThemeController(ctx.ui);
  const clearController = createBrowserDataClearController(ctx.ui, contextMenu.closeTabContextMenuWindow);
  registerBrowserRuntimeIPC(ipc, ctx.ui, clearController);
  ipc.on('app-theme-changed', (_event, nextTheme) => theme.broadcast(nextTheme));
  ipc.handle('get-app-theme', async () => ({ ok: true, theme: theme.current() }));
  registerTabIPC(ipc, ctx.ui, contextMenu);
  registerUiUtilityIPC(ipc, ctx);
}

module.exports = { registerUiIPC };
