'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let clashStatus = { running: true, enabled: true, coreDir: 'fixture-core' };
let endpoint = { host: '127.0.0.2', port: 17890 };
let shuttingDown = false;
const runtimePath = require.resolve('../../../src/app/main/features/network/clash-mini-control-runtime');
const contextPath = require.resolve('../../../src/app/main/runtime/app-context');
const environmentPath = require.resolve('../../../src/app/main/features/browser/browser-environment');
const targetPath = require.resolve('../../../src/app/main/features/browser/browser-network-controller');

require.cache[runtimePath] = { exports: {
  getClashMiniStatus: () => clashStatus,
  getClashMiniProxyEndpoint: () => endpoint,
  getClashMiniRuntimeRoot: () => 'fallback-core',
} };
require.cache[contextPath] = { exports: { appContext: { isShuttingDown: () => shuttingDown } } };
require.cache[environmentPath] = { exports: {
  buildAppliedBrowserEnvironment: (profile) => ({ locale: profile.locale, timezoneId: profile.timezoneId }),
  resolveConfiguredBrowserProxy: (settings) => {
    const proxy = settings?.proxy || {};
    if (proxy.mode !== 'custom') return { enabled: false };
    return {
      enabled: true,
      server: `${proxy.protocol || 'http'}://${proxy.host}:${proxy.port}`,
      bypassRules: '<local>',
    };
  },
} };
delete require.cache[targetPath];
const { createBrowserNetworkController } = require(targetPath);

function createFixture(overrides = {}) {
  const tabs = new Map();
  const instances = new Map();
  const restarts = [];
  let updates = 0;
  const loggerMessages = [];
  let profileLookups = 0;
  const controller = createBrowserNetworkController({
    browserRuntimeManager: {
      chromium: { instances },
      restart: async (id) => { restarts.push(id); return { status: 'running' }; },
    },
    logger: { warn: (...args) => loggerMessages.push(args.join(' ')) },
    resolveTabBrowserProfile: async () => { profileLookups += 1; throw new Error('unexpected profile lookup'); },
    resolveTabs: () => tabs,
    updateTabs: () => { updates += 1; },
    ...overrides,
  });
  return {
    controller,
    instances,
    loggerMessages,
    profileLookups: () => profileLookups,
    restarts,
    tabs,
    updates: () => updates,
  };
}

test.beforeEach(() => {
  clashStatus = { running: true, enabled: true, coreDir: 'fixture-core' };
  endpoint = { host: '127.0.0.2', port: 17890 };
  shuttingDown = false;
});

test('proxy endpoint is normalized and rejects unavailable control data', () => {
  const { controller } = createFixture();
  assert.deepEqual(controller.getBrowserProxyEndpoint(), {
    enabled: true,
    server: 'http://127.0.0.2:17890',
    bypassRules: '<local>;127.0.0.1;localhost;::1',
  });
  endpoint = { host: '', port: '7890' };
  assert.equal(controller.getBrowserProxyEndpoint().server, 'http://127.0.0.1:7890');
  endpoint = { port: 'invalid' };
  assert.equal(controller.getBrowserProxyEndpoint(), null);
  clashStatus = {};
  assert.equal(controller.getBrowserProxyEndpoint(), null);
});

test('global magic updates every browser and avoids redundant restarts', async () => {
  const fixture = createFixture();
  const magic = { id: 'magic', browserSettings: { proxy: { mode: 'default' } }, browserProfile: { region: 'CN' } };
  const direct = { id: 'direct', browserSettings: { proxy: { mode: 'default' } } };
  fixture.tabs.set(magic.id, magic);
  fixture.tabs.set(direct.id, direct);
  fixture.instances.set(magic.id, { profile: { proxyServer: '', proxyBypassList: '' } });
  fixture.instances.set(direct.id, { profile: { proxyServer: '', proxyBypassList: '' } });

  const first = await fixture.controller.applyClashMiniBrowserProxy(true);
  assert.deepEqual({ ok: first.ok, updated: first.updated, total: first.total }, { ok: true, updated: 2, total: 2 });
  assert.deepEqual(fixture.restarts, ['magic', 'direct']);
  assert.equal(magic.networkMagicApplied, true);
  assert.equal(direct.networkMagicApplied, true);
  assert.equal(fixture.profileLookups(), 0);

  const second = await fixture.controller.applyClashMiniBrowserProxy(true);
  assert.equal(second.updated, 0);
  assert.deepEqual(fixture.restarts, ['magic', 'direct']);
  assert.equal(fixture.updates(), 2);
});

test('proxy changes preserve BrowserProfile without any exit IP lookup', async () => {
  const fixture = createFixture();
  const tab = { id: 'one', browserSettings: { proxy: { mode: 'default' } }, browserProfile: { region: 'US' } };
  fixture.tabs.set(tab.id, tab);
  fixture.instances.set(tab.id, { profile: { proxyServer: '', proxyBypassList: '', locale: 'en-US' } });
  const result = await fixture.controller.applyClashMiniBrowserProxy(true, { forceProfileRefresh: true });
  assert.equal(result.updated, 1);
  assert.equal(tab.browserProfile.region, 'US');
  assert.equal(fixture.profileLookups(), 0);
  assert.equal(fixture.loggerMessages.length, 0);
});

test('proxy restart failures remain diagnostic without starting a profile lookup', async () => {
  const fixture = createFixture({
    browserRuntimeManager: {
      chromium: { instances: new Map() },
      restart: async () => { throw new Error('restart failed'); },
    },
  });
  const tab = { id: 'broken', browserSettings: { proxy: { mode: 'default' } } };
  fixture.tabs.set(tab.id, tab);
  fixture.controller = createBrowserNetworkController({
    browserRuntimeManager: {
      chromium: { instances: fixture.instances },
      restart: async () => { throw new Error('restart failed'); },
    },
    logger: { warn: (...args) => fixture.loggerMessages.push(args.join(' ')) },
    resolveTabs: () => fixture.tabs,
    updateTabs() {},
  });
  fixture.instances.set(tab.id, { profile: { proxyServer: '', proxyBypassList: '' } });

  const result = await fixture.controller.applyClashMiniBrowserProxy(true);

  assert.equal(result.ok, false);
  assert.equal(result.updated, 0);
  assert.deepEqual(result.failures, [{ tabId: 'broken', message: 'restart failed' }]);
  assert.equal(tab.networkMagicApplied, false);
  assert.match(fixture.loggerMessages[0], /restart failed/);
});

test('shutdown and missing runtime instances are safe no-op paths', async () => {
  const fixture = createFixture();
  const tab = { id: 'one', browserSettings: { proxy: { mode: 'default' } } };
  fixture.tabs.set(tab.id, tab);
  shuttingDown = true;
  const shutdown = await fixture.controller.applyClashMiniBrowserProxy(true);
  assert.equal(shutdown.skipped, true);
  shuttingDown = false;
  const missing = await fixture.controller.applyClashMiniBrowserProxy(true);
  assert.equal(missing.updated, 0);
  assert.equal(tab.networkMagicApplied, false);
});

test('disabling global magic restores each browser configured proxy', async () => {
  const fixture = createFixture();
  const tab = {
    id: 'one',
    browserSettings: { proxy: { mode: 'custom', protocol: 'http', host: '10.0.0.2', port: 8888 } },
    networkMagicApplied: true,
  };
  fixture.tabs.set(tab.id, tab);
  fixture.instances.set(tab.id, { profile: {
    proxyServer: 'http://127.0.0.2:17890',
    proxyBypassList: '<local>;127.0.0.1;localhost;::1',
  } });
  const disabled = await fixture.controller.applyClashMiniBrowserProxy(false);
  assert.equal(disabled.ok, true);
  assert.equal(fixture.instances.get(tab.id).profile.proxyServer, 'http://10.0.0.2:8888');
  assert.equal(tab.networkMagicApplied, false);
  assert.deepEqual(fixture.restarts, ['one']);
});
