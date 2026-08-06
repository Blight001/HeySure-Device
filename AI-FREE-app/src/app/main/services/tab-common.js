function isUsableWebContents(webContents) {
  return !!webContents && !(typeof webContents.isDestroyed === 'function' && webContents.isDestroyed());
}

function isUsableWindow(win) {
  return !!win && !(typeof win.isDestroyed === 'function' && win.isDestroyed());
}

function resolveTabTitle(tab = {}) {
  const fixedTitle = String(tab?.fixedTitle || tab?.tabTitle || '').trim();
  if (fixedTitle) {
    return fixedTitle;
  }
  const runtimeTitle = String(tab?.runtimeTitle || '').trim();
  if (runtimeTitle) return runtimeTitle;
  return '';
}

function normalizePersistPartitionName(partition) {
  return String(partition || '').trim().replace(/^persist:/, '');
}

function normalizeManagedTabPartitionSuffix(value) {
  const text = String(value || '').trim();
  if (!text) return Date.now().toString();
  return text
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || Date.now().toString();
}

function buildManagedTabPartitionName(accountId) {
  return `tab-${normalizeManagedTabPartitionSuffix(accountId)}`;
}

function buildDefaultManagedTabPartitionName() {
  return buildManagedTabPartitionName('default');
}

function getActiveTabWebContents(tabs, activeTabId) {
  void tabs;
  void activeTabId;
  return null;
}

function sendSidebarVisibility(target, visible) {
  const webContents = target?.webContents || null;
  if (isUsableWebContents(webContents)) {
    webContents.send(visible ? 'sidebar-expand' : 'sidebar-collapse');
  }
}

function focusSidebarInput(getMainWindow, getSideView) {
  const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
  // Expanding the sidebar must not activate the application when it is in the
  // background. The input repair is only for a user-triggered toggle inside an
  // already focused main window.
  if (!isUsableWindow(win) || (typeof win.isFocused === 'function' && !win.isFocused())) return false;

  const sideView = typeof getSideView === 'function' ? getSideView() : null;
  const sideWebContents = sideView?.webContents;
  if (!isUsableWebContents(sideWebContents)) return false;

  try {
    // BrowserWindow.focus() is a no-op when the app is already foregrounded,
    // which leaves Win32 focus in the embedded Chromium input queue. Focus the
    // shell renderer as an intermediate target before handing focus to the
    // sidebar WebContentsView. This mirrors the focus reset that naturally
    // occurs after the application goes to the background and comes back.
    if (typeof win.focus === 'function') win.focus();
    if (isUsableWebContents(win.webContents) && typeof win.webContents.focus === 'function') {
      win.webContents.focus();
    }
    sideWebContents.focus();
    return true;
  } catch (_) {
    return false;
  }
}

function scheduleSidebarLayoutRefresh(nextVisible, getMainWindow, getSideView) {
  const delay = nextVisible ? 140 : 400;
  setTimeout(() => {
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (isUsableWindow(win)) win.emit('resize');
    if (!nextVisible) return;
    focusSidebarInput(getMainWindow, getSideView);
    setImmediate(() => focusSidebarInput(getMainWindow, getSideView));
  }, delay);
}

function toggleSidebarVisibility(options = {}) {
  const {
    getIsSidebarVisible,
    setIsSidebarVisible,
    getMainWindow,
    getSideView,
    logger = null,
    logPrefix = 'Tabs',
  } = options;

  try {
    const currentVisible = typeof getIsSidebarVisible === 'function' ? getIsSidebarVisible() : true;
    const nextVisible = !currentVisible;
    if (typeof setIsSidebarVisible === 'function') {
      setIsSidebarVisible(nextVisible);
    }

    const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (isUsableWindow(mainWindow)) {
      mainWindow.webContents.send(nextVisible ? 'sidebar-expand' : 'sidebar-collapse');
    }

    const sideView = typeof getSideView === 'function' ? getSideView() : null;
    sendSidebarVisibility(sideView, nextVisible);

    scheduleSidebarLayoutRefresh(nextVisible, getMainWindow, getSideView);

    return nextVisible;
  } catch (error) {
    logger?.warn?.(`[${logPrefix}] toggleSidebar 失败:`, error?.message || error);
    return null;
  }
}

module.exports = {
  buildDefaultManagedTabPartitionName,
  buildManagedTabPartitionName,
  getActiveTabWebContents,
  normalizePersistPartitionName,
  resolveTabTitle,
  toggleSidebarVisibility,
};
