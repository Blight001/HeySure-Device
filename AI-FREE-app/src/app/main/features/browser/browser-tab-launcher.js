'use strict';

const {
  normalizeAiFreeBrowserSettings,
  parseCookieJson,
} = require('../../utils/ai-free-browser-settings');
const { FREE_BROWSER_WINDOW_LIMIT, resolveVipAccess } = require('../../utils/vip-access');
const { resolveSidebarWidth } = require('../../../shared/sidebar-layout');
const {
  getClashMiniStatus,
  getClashMiniProxyEndpoint,
  getClashMiniRuntimeRoot,
} = require('../network/clash-mini-control-runtime');
const {
  buildAppliedBrowserEnvironment,
  buildAppliedBrowserSettings,
  buildBrowserStatusPageUrl,
  resolveChromiumExtensionPaths,
  resolveChromiumExtraArgs,
  resolveConfiguredBrowserProxy,
  resolveConfiguredHomepage,
} = require('./browser-environment');

class BrowserTabLauncher {
  constructor(deps = {}) {
    this.deps = deps;
    this.logger = deps.logger || console;
  }

  async addTab(url, options = {}) {
    const mainWindow = this.deps.resolveMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const identity = this.resolveIdentity(options);
    const existingTab = this.findAccountTab(identity.accountId);
    if (existingTab?.id) {
      this.deps.switchTab(existingTab.id, { focusBrowser: options.focusBrowser === true });
      return existingTab.id;
    }
    this.assertWindowAccess();
    const context = this.createLaunchContext(url, options, identity, mainWindow);
    this.publishStartingTab(context);
    try {
      await this.completeTabLaunch(context);
      return context.id;
    } catch (error) {
      this.rollbackFailedTab(context);
      this.logger.error?.(
        '[ChromiumRuntime] 内置 AI-FREE Chromium 启动失败，禁止回退到其他网页运行时:',
        error?.message || error,
      );
      throw error;
    }
  }

  resolveIdentity(options) {
    return {
      accountId: String(options.accountId || '').trim(),
      fixedTitle: String(options.fixedTitle || options.tabTitle || '').trim(),
      browserHistoryId: String(options.browserHistoryId || '').trim(),
    };
  }

  findAccountTab(accountId) {
    if (!accountId) return null;
    return Array.from(this.deps.resolveTabs().values())
      .find((tab) => String(tab?.accountId || '').trim() === accountId) || null;
  }

  assertWindowAccess() {
    const access = resolveVipAccess(this.deps.licenseCache?.getSnapshot?.() || {});
    if (access.isVip || this.deps.resolveTabs().size < FREE_BROWSER_WINDOW_LIMIT) return;
    try {
      this.deps.sendToSide?.('vip-access-required', {
        feature: '更多独立浏览器窗口', limit: FREE_BROWSER_WINDOW_LIMIT,
      });
    } catch (_) {}
    const error = /** @type {Error & {code?: string, vipRequired?: boolean}} */ (
      new Error(`普通用户最多同时打开 ${FREE_BROWSER_WINDOW_LIMIT} 个独立浏览器窗口，请前往个人中心开通 VIP`)
    );
    error.code = 'VIP_BROWSER_WINDOW_LIMIT';
    error.vipRequired = true;
    throw error;
  }

  createLaunchContext(url, options, identity, mainWindow) {
    const id = String(options.tabId || identity.accountId || Date.now().toString());
    const restoreLastSession = options.restoreLastSession === true
      && this.deps.hasPersistedChromiumProfile(id);
    const browserSettings = this.resolveBrowserSettings(options);
    const proxy = this.resolveEffectiveProxy(browserSettings);
    const urls = this.resolveLaunchUrls(url, options, identity.fixedTitle, browserSettings, restoreLastSession);
    return {
      id,
      url,
      options,
      identity,
      restoreLastSession,
      browserSettings,
      proxy,
      urls,
      bounds: this.resolveBounds(mainWindow),
      tab: this.createStartingTab(id, url, options, identity, browserSettings, proxy, urls),
      previouslyActiveTabId: String(this.deps.resolveActiveTabId() || ''),
      restoreSideFocus: options.focusBrowser !== true && (
        options.restoreSideFocus === true || this.deps.isSideViewFocused?.() === true
      ),
    };
  }

  resolveBrowserSettings(options) {
    const runtimeConfig = typeof this.deps.licenseCache?.getRuntimeConfig === 'function'
      ? this.deps.licenseCache.getRuntimeConfig()
      : {};
    const serverSettings = runtimeConfig && typeof runtimeConfig.browserSettings === 'object'
      ? runtimeConfig.browserSettings
      : {};
    const optionSettings = options.browserSettings && typeof options.browserSettings === 'object'
      ? options.browserSettings
      : {};
    const raw = { ...serverSettings, ...this.deps.readPersistedBrowserSettings(), ...optionSettings };
    return { ...raw, ...normalizeAiFreeBrowserSettings(raw) };
  }

  resolveEffectiveProxy(browserSettings) {
    const status = getClashMiniStatus();
    const useMagic = status?.running === true && status?.enabled === true;
    const magicProxy = useMagic ? this.resolveMagicProxy(status) : null;
    const configured = resolveConfiguredBrowserProxy(browserSettings);
    return {
      useMagic,
      value: useMagic ? (magicProxy || { enabled: false }) : (configured || { enabled: false }),
    };
  }

  resolveMagicProxy(status) {
    const coreDir = status.coreDir || getClashMiniRuntimeRoot();
    const endpoint = getClashMiniProxyEndpoint(coreDir);
    if (!endpoint || !Number.isFinite(Number(endpoint.port))) return null;
    const host = String(endpoint.host || '127.0.0.1').trim() || '127.0.0.1';
    return {
      enabled: true,
      server: `http://${host}:${Number(endpoint.port)}`,
      bypassRules: '<local>;127.0.0.1;localhost;::1',
    };
  }

  resolveLaunchUrls(url, options, fixedTitle, browserSettings, restoreLastSession) {
    const target = restoreLastSession
      ? ''
      : options.deferChromiumNavigation === true
        ? 'about:blank'
        : (url || resolveConfiguredHomepage(browserSettings, this.deps.resolveDefaultTabUrl()));
    const opensNativeNewTab = /^chrome:\/\/newtab\/?$/i.test(target);
    let initial = target;
    if (restoreLastSession) initial = '';
    else if (opensNativeNewTab) initial = 'chrome://new-tab-page/';
    else if (options.showLoadingPage === true) {
      initial = buildBrowserStatusPageUrl(fixedTitle || '新建窗口', '正在启动独立浏览器…');
    }
    return { target, initial, opensNativeNewTab };
  }

  resolveBounds(mainWindow) {
    const [contentWidth, contentHeight] = mainWindow.getContentSize();
    const sideView = this.deps.resolveSideView?.();
    const sidebarWidth = resolveSidebarWidth({
      contentWidth,
      isVisible: this.deps.resolveIsSidebarVisible(),
      isMaximized: mainWindow.isMaximized?.() === true,
      currentWidth: sideView?.getBounds?.().width,
      normalWindowWidth: mainWindow.getNormalBounds?.().width,
      retainCurrentWidth: true,
    });
    return { x: 0, y: 41, width: contentWidth - sidebarWidth, height: Math.max(0, contentHeight - 41) };
  }

  createStartingTab(id, url, options, identity, browserSettings, proxy, urls) {
    return {
      id,
      zoomFactor: 1,
      accountId: identity.accountId,
      browserHistoryId: identity.browserHistoryId,
      isTutorialTab: options.isTutorialTab === true,
      fixedTitle: identity.fixedTitle,
      runtimeTitle: identity.fixedTitle || 'AI-FREE',
      requestedUrl: String(url || '').trim(),
      runtimeUrl: urls.target && urls.target !== 'about:blank' ? urls.target : '',
      runtimeType: 'chromium',
      runtimeStatus: 'starting',
      hideBrowserToolbar: options.hideBrowserToolbar === true,
      networkMagicApplied: proxy.useMagic && proxy.value?.enabled === true,
      browserProfile: null,
      browserSettings,
    };
  }

  publishStartingTab(context) {
    this.deps.resolveTabs().set(context.id, context.tab);
    this.deps.updateTabs(true);
    this.deps.switchTab(context.id, { focusBrowser: false });
  }

  assertCreationActive(context) {
    if (this.deps.resolveTabs().get(context.id) === context.tab) return;
    const error = /** @type {Error & {code?: string}} */ (new Error('浏览器栏目已在创建过程中关闭'));
    error.code = 'BROWSER_TAB_CREATION_CANCELLED';
    throw error;
  }

  async completeTabLaunch(context) {
    const profile = await this.resolveBrowserProfile(context);
    this.assertCreationActive(context);
    context.tab.browserProfile = profile;
    const runtimeState = await this.deps.browserRuntimeManager.launchProfile(
      this.buildRuntimeProfile(context, profile), context.bounds,
    );
    await this.stopCancelledRuntime(context);
    context.tab.runtimeStatus = runtimeState.status;
    await this.applyConfiguredCookies(context);
    this.deps.switchTab(context.id, { focusBrowser: context.options.focusBrowser === true });
    this.navigateFromLoadingPage(context);
    this.restoreSideFocusAfterLaunch(context);
  }

  restoreSideFocusAfterLaunch(context) {
    if (!context.restoreSideFocus || typeof this.deps.restoreSideViewFocus !== 'function') return;
    const restore = () => this.deps.restoreSideViewFocus();
    restore();
    setImmediate(restore);
    const timer = setTimeout(restore, 80);
    timer.unref?.();
  }

  async resolveBrowserProfile(context) {
    if (typeof this.deps.resolveTabBrowserProfile !== 'function') return null;
    return this.deps.resolveTabBrowserProfile({
      browserSettings: context.browserSettings,
      logger: this.logger,
    });
  }

  buildRuntimeProfile(context, profile) {
    const { id, identity, urls, restoreLastSession, browserSettings, proxy, url } = context;
    return {
      profileId: id,
      runtimeType: 'chromium',
      displayName: identity.fixedTitle,
      initialUrl: urls.initial,
      restoreLastSession,
      hideToolbar: context.options.hideBrowserToolbar === true,
      restoreFallbackUrl: String(url || '').trim(),
      locale: profile?.locale,
      acceptLanguage: profile?.acceptLanguage,
      timezoneId: profile?.timezoneId,
      userAgent: profile?.userAgent,
      browserEnvironment: buildAppliedBrowserEnvironment(profile),
      browserSettingsSnapshot: buildAppliedBrowserSettings(browserSettings),
      proxyServer: proxy.value?.enabled ? proxy.value.server : '',
      proxyBypassList: proxy.value?.bypassRules || '',
      extraArgs: resolveChromiumExtraArgs(browserSettings),
      executablePath: browserSettings.chromiumExecutablePath,
      extensionPaths: resolveChromiumExtensionPaths(browserSettings, this.deps.extensionManager),
      allowPrototypeWindowDiscovery: browserSettings.allowPrototypeWindowDiscovery === true,
      remoteDebuggingPipe: browserSettings.remoteDebuggingPipe === true,
      autoGrantPermissionOrigins: browserSettings.automation?.permissionOrigins || [],
    };
  }

  async stopCancelledRuntime(context) {
    if (this.deps.resolveTabs().get(context.id) === context.tab) return;
    try { await this.deps.browserRuntimeManager.stop(context.id, 'chromium', { timeoutMs: 4000 }); } catch (_) {}
    this.assertCreationActive(context);
  }

  async applyConfiguredCookies(context) {
    const cookies = parseCookieJson(context.browserSettings);
    if (!cookies.length || typeof this.deps.browserRuntimeManager.setCookies !== 'function') return;
    try {
      await this.deps.browserRuntimeManager.setCookies(context.id, cookies);
    } catch (error) {
      this.logger.warn?.('[ChromiumRuntime] AI-FREE Cookie 注入失败:', error?.message || error);
    }
  }

  navigateFromLoadingPage(context) {
    const { options, urls, id, identity } = context;
    if (options.showLoadingPage !== true || urls.opensNativeNewTab || !urls.target || urls.target === urls.initial) return;
    void this.deps.browserRuntimeManager.navigate(id, 'chromium', urls.target).catch((error) => {
      this.logger.warn?.('[ChromiumRuntime] 新浏览器导航失败:', error?.message || error);
      const statusUrl = buildBrowserStatusPageUrl(
        identity.fixedTitle || '新建窗口', '页面打开失败，请稍后刷新重试。', 'error',
      );
      return this.deps.browserRuntimeManager.navigate(id, 'chromium', statusUrl).catch(() => {});
    });
  }

  rollbackFailedTab(context) {
    const tabs = this.deps.resolveTabs();
    if (tabs.get(context.id) === context.tab) tabs.delete(context.id);
    if (String(this.deps.resolveActiveTabId() || '') !== context.id) {
      this.deps.updateTabs(true);
      return;
    }
    const fallbackId = tabs.has(context.previouslyActiveTabId)
      ? context.previouslyActiveTabId
      : String(tabs.keys().next().value || '');
    if (fallbackId) this.deps.switchTab(fallbackId);
    else {
      this.deps.setActiveTabId?.(null);
      this.deps.updateTabs(true);
    }
  }
}

function createBrowserTabLauncher(deps = {}) {
  const launcher = new BrowserTabLauncher(deps);
  return { addTab: (...args) => launcher.addTab(...args) };
}

module.exports = { createBrowserTabLauncher };
