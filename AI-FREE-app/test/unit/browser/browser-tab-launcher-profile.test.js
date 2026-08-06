'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const clashRuntimePath = require.resolve(
  '../../../src/app/main/features/network/clash-mini-control-runtime',
);
const launcherPath = require.resolve(
  '../../../src/app/main/features/browser/browser-tab-launcher',
);

require.cache[clashRuntimePath] = {
  exports: {
    getClashMiniStatus: () => ({
      running: true,
      enabled: true,
      coreDir: 'fixture-core',
    }),
    getClashMiniProxyEndpoint: () => ({ host: '127.0.0.1', port: 17890 }),
    getClashMiniRuntimeRoot: () => 'fallback-core',
  },
};
delete require.cache[launcherPath];
const { createBrowserTabLauncher } = require(launcherPath);

test('global proxy launch keeps proxy routing but passes no exit IP probe inputs', async () => {
  const tabs = new Map();
  const lookups = [];
  let launchedProfile = null;
  const launcher = createBrowserTabLauncher({
    browserRuntimeManager: {
      async launchProfile(profile) {
        launchedProfile = profile;
        return { status: 'ready' };
      },
    },
    getBrowserProxyEndpoint: () => ({ enabled: true, server: 'http://127.0.0.1:17890' }),
    hasPersistedChromiumProfile: () => false,
    licenseCache: { isVip: () => true },
    logger: { warn() {} },
    readPersistedBrowserSettings: () => ({}),
    resolveActiveTabId: () => null,
    resolveDefaultTabUrl: () => 'chrome://newtab/',
    resolveIsSidebarVisible: () => true,
    resolveMainWindow: () => ({
      isDestroyed: () => false,
      getContentSize: () => [1200, 800],
    }),
    resolveSideView: () => null,
    resolveTabBrowserProfile: async (options) => {
      lookups.push(options);
      return { locale: 'en-US', timezoneId: 'UTC' };
    },
    resolveTabs: () => tabs,
    setActiveTabId() {},
    switchTab() {},
    updateTabs() {},
  });

  const tabId = await launcher.addTab('chrome://newtab/', { tabId: 'magic-profile' });

  assert.equal(tabId, 'magic-profile');
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].geoProxyServer, undefined);
  assert.equal(lookups[0].httpGetUniversal, undefined);
  assert.equal(lookups[0].forceGeoLookup, undefined);
  assert.equal(launchedProfile.proxyServer, 'http://127.0.0.1:17890');
  assert.equal(tabs.get(tabId).networkMagicApplied, true);
});

test('loading-page navigation failures remain visible without profile probing', async () => {
  const tabs = new Map();
  const navigations = [];
  const warnings = [];
  const launcher = createBrowserTabLauncher({
    browserRuntimeManager: {
      async launchProfile() { return { status: 'ready' }; },
      async navigate(_id, _type, url) {
        navigations.push(url);
        if (navigations.length === 1) throw new Error('navigation failed');
      },
    },
    hasPersistedChromiumProfile: () => false,
    licenseCache: { isVip: () => true },
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    readPersistedBrowserSettings: () => ({}),
    resolveActiveTabId: () => null,
    resolveDefaultTabUrl: () => 'chrome://newtab/',
    resolveIsSidebarVisible: () => true,
    resolveMainWindow: () => ({
      isDestroyed: () => false,
      getContentSize: () => [1200, 800],
    }),
    resolveSideView: () => null,
    resolveTabBrowserProfile: async () => ({ locale: 'en-US', timezoneId: 'UTC' }),
    resolveTabs: () => tabs,
    setActiveTabId() {},
    switchTab() {},
    updateTabs() {},
  });

  await launcher.addTab('https://example.test/', {
    tabId: 'loading-profile',
    showLoadingPage: true,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(navigations[0], 'https://example.test/');
  assert.match(navigations[1], /^data:text\/html/);
  assert.match(warnings[0], /navigation failed/);
});

test('an existing account tab is reused without profile resolution', async () => {
  const existing = { id: 'existing-profile', accountId: 'account-a' };
  let switchedTo = null;
  let profileLookups = 0;
  const launcher = createBrowserTabLauncher({
    resolveMainWindow: () => ({ isDestroyed: () => false }),
    resolveTabs: () => new Map([[existing.id, existing]]),
    resolveTabBrowserProfile: async () => { profileLookups += 1; },
    switchTab: (id) => { switchedTo = id; },
  });

  const tabId = await launcher.addTab('https://example.test/', { accountId: 'account-a' });

  assert.equal(tabId, existing.id);
  assert.equal(switchedTo, existing.id);
  assert.equal(profileLookups, 0);
});
