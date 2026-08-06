'use strict';

const { normalizeAiFreeBrowserSettings } = require('../../utils/ai-free-browser-settings');

const DEFAULT_TUTORIAL_URL = 'https://www.yuque.com/kelingaishipindian/tx5gwq/xbsl692ls9xope0e?singleDoc#';
const DEFAULT_BROWSER_TAB_URL = 'chrome://newtab/';
const TUTORIAL_TAB_TITLE = '使用教程[AI-FREE]';
const MINIMUM_BROWSER_TAB_ID = '1';

function text(value) {
  return String(value || '').trim();
}

class BrowserTutorialController {
  constructor(deps) {
    this.deps = deps;
    this.logger = deps.logger || console;
    this.tutorialTabOpeningPromise = null;
    this.minimumBrowserOpeningPromise = null;
  }

  resolveConfiguredTutorialUrl() {
    try { return text(this.deps.licenseCache?.getRuntimeConfig?.()?.tutorialUrl); } catch (_) { return ''; }
  }

  resolveDefaultTabUrl() {
    return DEFAULT_BROWSER_TAB_URL;
  }

  readTutorialHistoryRecord() {
    try {
      const storePath = this.deps.getStorePath?.() || '';
      if (!storePath || !this.deps.fs?.existsSync?.(storePath)) return null;
      const store = JSON.parse(this.deps.fs.readFileSync(storePath, 'utf8') || '{}');
      const records = Array.isArray(store?.browserHistory) ? store.browserHistory : [];
      const matches = records
        .filter((item) => item?.kind === 'tutorial' || text(item?.name) === TUTORIAL_TAB_TITLE)
        .sort((left, right) => Number(right?.lastOpenedAt || 0) - Number(left?.lastOpenedAt || 0));
      const record = matches[0];
      if (!record?.id) return null;
      return { id: text(record.id), url: text(record.url), settings: normalizeAiFreeBrowserSettings(record.settings || {}) };
    } catch (_) {
      return null;
    }
  }

  findExistingTutorialTab() {
    return Array.from(this.deps.resolveTabs().values()).find((tab) => (
      tab?.isTutorialTab === true || text(tab?.fixedTitle || tab?.runtimeTitle) === TUTORIAL_TAB_TITLE
    ));
  }

  async syncTutorialTabUrl(tutorialUrl = '') {
    const targetUrl = text(tutorialUrl || this.resolveConfiguredTutorialUrl());
    const existingTab = this.findExistingTutorialTab();
    if (!targetUrl || !existingTab?.id) return { ok: true, updated: false, tabId: existingTab?.id || '' };
    if (text(existingTab.requestedUrl) === targetUrl) return { ok: true, updated: false, tabId: existingTab.id };
    try {
      await this.deps.browserRuntimeManager.navigate(existingTab.id, 'chromium', targetUrl);
      existingTab.requestedUrl = targetUrl;
      existingTab.runtimeUrl = targetUrl;
      this.deps.resolveTabs().set(existingTab.id, existingTab);
      this.deps.updateTabs();
      return { ok: true, updated: true, tabId: existingTab.id };
    } catch (error) {
      this.logger.warn?.('[教程] 同步服务器最新地址失败:', error?.message || error);
      return { ok: false, updated: false, tabId: existingTab.id, message: error?.message || String(error) };
    }
  }

  createFocusRestorer(options, focusBrowser) {
    const shouldRestore = !focusBrowser && (options.restoreSideFocus === true || this.deps.isSideViewFocused());
    return () => {
      if (!shouldRestore) return;
      this.deps.restoreSideViewFocus();
      setImmediate(this.deps.restoreSideViewFocus);
    };
  }

  async navigateExistingTab(tabId, requestedUrl, focusBrowser, restoreFocus) {
    const targetUrl = requestedUrl || this.resolveConfiguredTutorialUrl();
    if (targetUrl) {
      try {
        await this.deps.browserRuntimeManager.navigate(tabId, 'chromium', targetUrl);
        const tab = this.deps.resolveTabs().get(text(tabId));
        if (tab) {
          tab.requestedUrl = targetUrl;
          tab.runtimeUrl = targetUrl;
          this.deps.resolveTabs().set(tab.id, tab);
          this.deps.updateTabs();
        }
      } catch (error) {
        this.logger.warn?.('[教程] 更新服务器下发地址失败:', error?.message || error);
      }
    }
    this.deps.switchTab(tabId, { focusBrowser });
    restoreFocus();
    return tabId;
  }

  createTutorialTab(requestedUrl, requestedTabId, focusBrowser) {
    const history = this.readTutorialHistoryRecord();
    const targetUrl = requestedUrl || this.resolveConfiguredTutorialUrl() || history?.url || DEFAULT_TUTORIAL_URL;
    const historyId = text(history?.id);
    const generatedId = historyId
      ? `browser-tab-${historyId.replace(/[^a-z0-9_-]/gi, '_')}`
      : 'browser-tab-tutorial-default';
    return this.deps.addTab(targetUrl, {
      tabId: requestedTabId || generatedId,
      fixedTitle: TUTORIAL_TAB_TITLE,
      isTutorialTab: true,
      browserHistoryId: historyId,
      restoreLastSession: false,
      focusBrowser,
      browserSettings: {
        ...(history?.settings || {}),
        region: 'cn',
        locale: 'zh-CN',
        acceptLanguage: 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
  }

  async openTutorialTab(requestedUrl = '', options = {}) {
    const targetUrl = text(requestedUrl);
    const requestedTabId = text(options.tabId);
    const focusBrowser = options.focusBrowser === true;
    const restoreFocus = this.createFocusRestorer(options, focusBrowser);
    const existingTab = this.findExistingTutorialTab();
    const navigate = (tabId) => this.navigateExistingTab(tabId, targetUrl, focusBrowser, restoreFocus);
    if (existingTab?.id) return navigate(existingTab.id);
    if (this.tutorialTabOpeningPromise) {
      const openingTabId = await this.tutorialTabOpeningPromise;
      return openingTabId ? navigate(openingTabId) : null;
    }
    this.tutorialTabOpeningPromise = this.createTutorialTab(targetUrl, requestedTabId, focusBrowser);
    try {
      const tabId = await this.tutorialTabOpeningPromise;
      restoreFocus();
      return tabId;
    } finally {
      this.tutorialTabOpeningPromise = null;
    }
  }

  async ensureMinimumBrowserTab() {
    const tabs = this.deps.resolveTabs();
    if (tabs.size) return text(tabs.keys().next().value);
    if (this.minimumBrowserOpeningPromise) return this.minimumBrowserOpeningPromise;
    this.deps.setActiveTabId?.(null);
    this.minimumBrowserOpeningPromise = this.deps.addTab(DEFAULT_BROWSER_TAB_URL, {
      tabId: MINIMUM_BROWSER_TAB_ID, fixedTitle: '新建窗口', focusBrowser: false,
      showLoadingPage: true, restoreLastSession: false,
    });
    try { return await this.minimumBrowserOpeningPromise; } finally { this.minimumBrowserOpeningPromise = null; }
  }

  toApi() {
    return {
      ensureMinimumBrowserTab: this.ensureMinimumBrowserTab.bind(this),
      openTutorialTab: this.openTutorialTab.bind(this),
      resolveDefaultTabUrl: this.resolveDefaultTabUrl.bind(this),
      syncTutorialTabUrl: this.syncTutorialTabUrl.bind(this),
    };
  }
}

function createBrowserTutorialController(deps = {}) {
  return new BrowserTutorialController(deps).toApi();
}

module.exports = { createBrowserTutorialController };
