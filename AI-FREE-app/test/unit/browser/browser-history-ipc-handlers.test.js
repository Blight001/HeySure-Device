'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBrowserHistoryIpcHandlers,
} = require('../../../src/app/main/features/browser/browser-history-ipc-handlers');

function fixture(overrides = {}) {
  const events = [];
  const writes = [];
  const tabs = new Map();
  let history = [];
  const deps = {
    auditBrowserProfiles: () => null,
    cleanupOrphanBrowserProfiles: () => null,
    createBrowserHistoryId: () => 'browser-1',
    createVipRequiredResult: () => ({ ok: false, code: 'VIP_REQUIRED' }),
    DEFAULT_BROWSER_WINDOW_NAME: '新建窗口',
    DEFAULT_BROWSER_WINDOW_URL: 'chrome://newtab/',
    FREE_BROWSER_WINDOW_LIMIT: 2,
    licenseCache: { getSnapshot: () => ({ isVip: true }) },
    makeUniqueBrowserName: (name) => name || '新建窗口',
    normalizeAiFreeBrowserSettings: (settings) => ({
      homepage: { mode: 'default', url: '' },
      ...settings,
    }),
    openBrowserHistoryRecord: async () => ({ ok: true }),
    popup: { show: () => ({ ok: true }), close() {}, updateSelection() {} },
    readBrowserHistorySafe: () => history.map((item) => ({ ...item })),
    readStoreConfigSafe: () => ({}),
    renameBrowserHistoryRecord: () => ({ ok: true }),
    resolveVipAccess: (snapshot) => ({ isVip: snapshot.isVip === true }),
    serializeBrowserHistory: (items) => items,
    syncOpenTabsToBrowserHistory: () => history,
    ui: {
      addTab: async () => 'tab-1',
      browserRuntimeManager: { deleteProfile: () => true },
      closeTab: async () => {},
      getActiveTabId: () => '',
      getMainWindow: () => null,
      getTabs: () => tabs,
      sendToSide: (channel, payload) => events.push({ channel, payload }),
    },
    writeBrowserHistorySafe: (next) => {
      history = next.map((item) => ({ ...item }));
      writes.push(history);
      return true;
    },
    ...overrides,
  };
  return {
    deps,
    events,
    getHistory: () => history,
    handlers: createBrowserHistoryIpcHandlers(deps),
    setHistory: (next) => { history = next; },
    tabs,
    writes,
  };
}

test('独立浏览器并发创建复用同一挂起响应且完成后允许再次创建', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const data = fixture();
  data.deps.ui.addTab = () => { calls += 1; return pending; };
  const first = await data.handlers.createIndependentBrowser(null, { name: '窗口 A' });
  const second = await data.handlers.createIndependentBrowser(null, { name: '窗口 A' });

  assert.equal(first.pending, true);
  assert.equal(second.deduplicated, true);
  assert.equal(calls, 1);
  release('tab-1');
  await new Promise((resolve) => setImmediate(resolve));
  data.deps.ui.addTab = async () => { calls += 1; return 'tab-2'; };
  const third = await data.handlers.createIndependentBrowser(null, { name: '窗口 B' });
  assert.equal(third.pending, true);
  assert.equal(calls, 2);
});

test('批量重命名预先拒绝与未选记录冲突且不产生部分写入', async () => {
  const data = fixture();
  data.setHistory([
    { id: 'one', name: 'A' },
    { id: 'two', name: 'B[1]' },
  ]);
  const result = await data.handlers.renameBrowserHistoryBatch(null, {
    historyIds: ['one'], baseName: 'B[1]',
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /已存在/);
  assert.equal(data.writes.length, 0);
  assert.equal(data.getHistory()[0].name, 'A');
});

test('Profile 删除失败时恢复已删除的历史索引并返回明确错误', async () => {
  const data = fixture();
  data.setHistory([{ id: 'history-1', name: '窗口', profileId: 'profile-1' }]);
  data.deps.ui.browserRuntimeManager.deleteProfile = () => { throw new Error('profile busy'); };
  const result = await data.handlers.deleteBrowserHistory(null, { historyId: 'history-1' });

  assert.equal(result.ok, false);
  assert.match(result.error, /profile busy/);
  assert.equal(data.getHistory().length, 1);
});
