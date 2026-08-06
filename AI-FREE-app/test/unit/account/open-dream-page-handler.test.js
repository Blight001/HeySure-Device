'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOpenDreamPageHandler,
} = require('../../../src/app/main/features/account/open-dream-page-handler');
const {
  resolveRuntimeConnectionConfig,
} = require('../../../src/app/main/features/account/dream-platform-support');

function fixture(overrides = {}) {
  const events = [];
  const importedSessions = [];
  const openedSubTabs = [];
  const addedTabs = [];
  const account = {
    id: 'Dream::alice',
    accountName: 'alice',
    platform: 'Dream',
    currentUrl: 'https://dream.example',
  };
  const support = {
    buildAccountCleanupOptions: () => ({}),
    findOpenDreamTab: () => null,
    hasPersistedDreamProfile: () => false,
    importServerFetchedDreamAccount: (data) => ({
      account,
      accountId: account.id,
      cookies: data.cookies,
      browserStorage: data.browserStorage,
    }),
    isPermanentDreamAccount: () => false,
    navigateDreamTab: async () => {},
    resolveDreamWindowTitle: () => 'Dream',
    resolveHistoricalDreamAccount: () => null,
    ...overrides.support,
  };
  const deps = {
    accountStorage: {
      updateAccount: () => ({ ok: true, account }),
      updateLastUsedTime() {},
    },
    auth: {
      fetchCookieFromServerForDream: async () => ({
        account: 'alice',
        platform: 'Dream',
        currentUrl: 'https://dream.example',
        subUrls: ['https://dream.example/video', 'https://dream.example/image'],
        cookies: [{ name: 'sid', value: 'redacted' }],
        browserStorage: [],
      }),
    },
    isUsageExhaustedFetchError: () => false,
    resolveDreamTargetUrl: () => 'https://dream.example',
    support,
    ui: {
      addTab: async (url, options) => { addedTabs.push({ url, options }); return 'tab-1'; },
      browserRuntimeManager: {
        importSession: async (tabId, session) => importedSessions.push({ tabId, session }),
        openTabs: async (tabId, type, urls) => openedSubTabs.push({ tabId, type, urls }),
        reload: async () => {},
      },
      sendToSide: (channel, payload) => events.push({ channel, payload }),
    },
    updateAccountRecycleTimer() {},
    ...overrides.deps,
  };
  return {
    account,
    addedTabs,
    deps,
    events,
    handler: createOpenDreamPageHandler(deps),
    importedSessions,
    openedSubTabs,
    support,
  };
}

test('新服务器账号先持久化再创建 Profile、导航并注入会话', async () => {
  const data = fixture();
  const result = await data.handler(null, { key: 'key', deviceId: 'device' });

  assert.deepEqual(result, { ok: true, tabId: 'tab-1' });
  assert.equal(data.addedTabs[0].options.accountId, 'Dream::alice');
  assert.equal(data.addedTabs[0].options.restoreLastSession, false);
  assert.equal(data.addedTabs[0].options.hideBrowserToolbar, true);
  assert.equal(data.importedSessions.length, 1);
  assert.equal(data.importedSessions[0].session.navigateAfterImport, false);
  assert.deepEqual(data.openedSubTabs, [{
    tabId: 'tab-1',
    type: 'chromium',
    urls: ['https://dream.example/video', 'https://dream.example/image'],
  }]);
  assert.equal(data.events.some((event) => event.channel === 'account-list-updated'), true);
  assert.equal(data.events.some((event) => event.channel === 'browser-history-changed'), true);
});

test('命中已持久化 Profile 时恢复本地会话且不覆盖 Cookie 和 Storage', async () => {
  const data = fixture({
    support: {
      resolveHistoricalDreamAccount: () => ({
        id: 'Dream::alice', accountName: 'alice', platform: 'Dream', currentUrl: 'https://dream.example',
      }),
      hasPersistedDreamProfile: () => true,
    },
  });
  const result = await data.handler(null, { key: 'key', deviceId: 'device' });

  assert.equal(result.ok, true);
  assert.equal(result.restored, true);
  assert.equal(data.addedTabs[0].options.restoreLastSession, true);
  assert.equal(data.importedSessions.length, 0);
});

test('永久账号次数耗尽时只允许恢复匹配的本地 Profile', async () => {
  const historical = {
    id: 'Dream::saved', key: 'saved-key', deviceId: 'saved-device', accountName: 'saved', platform: 'Dream',
  };
  const data = fixture({
    support: {
      isPermanentDreamAccount: () => true,
      resolveHistoricalDreamAccount: () => historical,
      hasPersistedDreamProfile: () => true,
    },
    deps: {
      auth: { fetchCookieFromServerForDream: async () => { throw new Error('usage exhausted'); } },
      isUsageExhaustedFetchError: () => true,
    },
  });
  const result = await data.handler(null, {
    key: 'key', deviceId: 'device', accountId: 'Dream::saved',
  });

  assert.equal(result.ok, true);
  assert.equal(result.accountId, 'Dream::saved');
  assert.equal(result.restored, true);
  assert.equal(data.importedSessions.length, 0);
});

test('已打开账号窗口被切换并导航，不重复创建 Chromium 标签', async () => {
  const switched = [];
  const navigated = [];
  const data = fixture({
    support: {
      resolveHistoricalDreamAccount: () => ({ id: 'Dream::alice', accountName: 'alice' }),
      findOpenDreamTab: () => ({ id: 'tab-open', accountId: 'Dream::alice' }),
      navigateDreamTab: async (tabId, url) => navigated.push({ tabId, url }),
    },
    deps: { ui: {
      addTab: async () => { throw new Error('不应创建新标签'); },
      browserRuntimeManager: {},
      sendToSide() {},
      switchTab: (tabId) => switched.push(tabId),
    } },
  });
  const result = await data.handler(null, { key: 'key', deviceId: 'device' });

  assert.deepEqual(result, {
    ok: true,
    tabId: 'tab-open',
    alreadyOpen: true,
    accountId: 'Dream::alice',
  });
  assert.deepEqual(switched, ['tab-open']);
  assert.equal(navigated[0].url, 'https://dream.example');
});

test('入口拒绝缺少登录状态，运行连接配置兼容 HTTP 与 TCP 字段别名', async () => {
  const data = fixture();
  assert.deepEqual(await data.handler(null, {}), { ok: false, message: '缺少登录状态' });
  assert.deepEqual(resolveRuntimeConnectionConfig({
    address_HTTP: ' https://account.example ',
    address_TCP: 'tcp://127.0.0.1:9443',
  }), {
    serverBase: 'https://account.example',
    tcp: { host: '127.0.0.1', port: 9443 },
  });
});

test('仅链接平台跳过账号与 Cookie 获取并打开全部配置网址', async () => {
  let fetchCount = 0;
  const navigated = [];
  const data = fixture({
    support: {
      navigateDreamTab: async (tabId, url) => navigated.push({ tabId, url }),
    },
    deps: {
      auth: { fetchCookieFromServerForDream: async () => { fetchCount += 1; } },
    },
  });
  const result = await data.handler(null, {
    key: 'key',
    deviceId: 'device',
    platform: '工具导航',
    targetUrl: 'https://one.example',
    subUrls: ['https://two.example', 'https://three.example'],
    launchOnly: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.launchOnly, true);
  assert.equal(fetchCount, 0);
  assert.equal(data.importedSessions.length, 0);
  assert.equal(data.addedTabs[0].url, 'https://one.example');
  assert.equal(data.addedTabs.length, 1);
  assert.equal(data.addedTabs[0].options.hideBrowserToolbar, true);
  assert.deepEqual(navigated, []);
  assert.deepEqual(data.openedSubTabs[0].urls, [
    'https://two.example',
    'https://three.example',
  ]);
  assert.deepEqual(result.openedUrls, [
    'https://one.example',
    'https://two.example',
    'https://three.example',
  ]);
  assert.equal(result.openedWindowCount, 1);
});

test('仅链接平台批量创建标签失败时返回明确错误', async () => {
  const data = fixture({
    deps: {
      ui: {
        addTab: async () => 'tab-1',
        browserRuntimeManager: {
          openTabs: async () => {
            throw new Error('open-tabs unavailable');
          },
        },
        sendToSide() {},
      },
    },
  });
  const result = await data.handler(null, {
    key: 'key',
    platform: '工具导航',
    targetUrl: 'https://one.example',
    subUrls: ['https://two.example'],
    launchOnly: true,
  });

  assert.deepEqual(result, {
    ok: false,
    message: '子网址打开失败：open-tabs unavailable',
  });
});
