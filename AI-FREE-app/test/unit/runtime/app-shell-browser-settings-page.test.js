'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAppShellMainWindowController } = require('../../../src/app/main/services/app-shell-main-window');

test('浏览器配置内嵌主窗口且只创建侧边栏子视图', () => {
  const views = [];
  let mainWindow = null;
  let sideView = null;
  let maximizeCalls = 0;
  const loadedPages = [];
  class FakeView {
    constructor() {
      this.visible = true;
      this.bounds = null;
      this.webContents = {
        session: {},
        loadFile: async (file) => { loadedPages.push(file); },
        on: () => {},
      };
      views.push(this);
    }
    getBounds() { return this.bounds || { width: 300 }; }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
  }
  class FakeWindow {
    constructor() {
      this.events = new Map();
      this.webContents = { on: () => {}, isDestroyed: () => false };
      this.contentView = { addChildView: () => {} };
    }
    on(name, listener) {
      const listeners = this.events.get(name) || [];
      listeners.push(listener);
      this.events.set(name, listeners);
    }
    once(name, listener) { this.on(name, listener); }
    emit(name) { for (const listener of this.events.get(name) || []) listener(); }
    getContentSize() { return [1000, 700]; }
    getNormalBounds() { return { width: 1000, height: 700 }; }
    getBounds() { return this.getNormalBounds(); }
    isDestroyed() { return false; }
    isMaximized() { return true; }
    isMinimized() { return false; }
    loadFile() {}
    maximize() { maximizeCalls += 1; }
    setAutoHideMenuBar() {}
    setMenu() {}
    setMenuBarVisibility() {}
    setTitle() {}
  }
  class FakeTray {
    isDestroyed() { return false; }
    on() {}
    setContextMenu() {}
    setToolTip() {}
  }
  const controller = createAppShellMainWindowController({
    APP_DISPLAY_NAME: 'AI-FREE', BrowserWindow: FakeWindow, WebContentsView: FakeView, Tray: FakeTray,
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
    app: { getPath: () => 'C:/tmp', on: () => {}, once: () => {} },
    fs: { existsSync: () => false, mkdirSync: () => {}, unlinkSync: () => {} },
    path, screen: {}, logger: { error: () => {}, log: () => {}, warn: () => {} },
    resolveAppIconPath: () => 'C:/app/logo.ico',
    attachContextMenu: () => {}, resolveAddTab: () => null, resolveTabs: () => new Map(),
    resolveActiveTabId: () => null, resolveRefreshActiveTab: () => null, resolveAuth: () => null,
    resolveControlPanelHtmlPath: (fileName) => `C:/app/sidebar/${fileName}`,
    getSideView: () => sideView, setSideView: (view) => { sideView = view; },
    setMainWindow: (window) => { mainWindow = window; }, resolveMainWindow: () => mainWindow,
    resolveControlPanelWindow: () => null, closeDevConsoleWindow: () => {},
    getIsSidebarVisible: () => true, isControlPanelModeEnabled: () => false,
  });

  const window = controller.createMainWindow();
  assert.equal(maximizeCalls, 1);
  window.emit('ready-to-show');
  assert.equal(views.length, 1);
  assert.deepEqual(loadedPages, ['C:/app/sidebar/ai-control.html']);
  assert.deepEqual(views[0].bounds, { x: 700, y: 41, width: 300, height: 659 });
  assert.equal(views[0].visible, true);
  window.emit('closed');
});
