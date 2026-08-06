function isUsableContents(contents) {
  return Boolean(contents) && !contents.isDestroyed?.();
}

function resolveSidebarFocusTarget(ui, event) {
  const sideView = typeof ui?.getSideView === 'function' ? ui.getSideView() : null;
  if (isUsableContents(sideView?.webContents)) return sideView.webContents;
  return isUsableContents(event?.sender) ? event.sender : null;
}

function focusMainWindow(mainWindow) {
  if (!mainWindow || mainWindow.isDestroyed?.()) return;
  if (mainWindow.isMinimized?.()) {
    try { mainWindow.restore?.(); } catch (_) {}
  }
  if (!mainWindow.isFocused?.()) {
    try { mainWindow.focus?.(); } catch (_) {}
  }
}

function releaseActiveBrowserFocus(ui) {
  const profileId = String(ui?.getActiveTabId?.() || '').trim();
  const manager = ui?.browserRuntimeManager;
  if (!profileId || typeof manager?.releaseFocus !== 'function') return false;
  try { return manager.releaseFocus(profileId, 'chromium'); } catch (_) { return false; }
}

function createSidebarFocusAction(mainWindow, sideContents, event) {
  return () => {
    try {
      if (isUsableContents(sideContents)) {
        if (isUsableContents(mainWindow?.webContents)) mainWindow.webContents.focus();
        sideContents.focus();
        return true;
      }
      if (isUsableContents(event?.sender)) {
        event.sender.focus();
        return true;
      }
    } catch (_) {}
    return false;
  };
}

function createSidebarFocusHandler(ui) {
  return async (event, request = {}) => {
    try {
      const textInput = request?.interaction === 'text-input';
      const mainWindow = ui?.getMainWindow?.();
      const sideContents = resolveSidebarFocusTarget(ui, event);
      releaseActiveBrowserFocus(ui);
      focusMainWindow(mainWindow);
      const focusSide = createSidebarFocusAction(mainWindow, sideContents, event);
      focusSide();
      if (textInput) return { ok: true, stableTextInput: true };
      await new Promise((resolve) => setImmediate(resolve));
      focusSide();
      await new Promise((resolve) => setTimeout(resolve, 20));
      focusSide();
      return { ok: true, sideFocused: Boolean(sideContents?.isFocused?.()) };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };
}

module.exports = { createSidebarFocusHandler };
