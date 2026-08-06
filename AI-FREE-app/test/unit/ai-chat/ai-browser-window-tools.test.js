'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const target = require.resolve('../../../src/app/main/services/ai-browser-window-tools');
const historyDependency = require.resolve('../../../src/app/main/features/browser/browser-history-service');
const storeDependency = require.resolve('../../../src/app/main/ipc/register/store-utils');
const settingsDependency = require.resolve('../../../src/app/main/utils/ai-free-browser-settings');
const vipDependency = require.resolve('../../../src/app/main/utils/vip-access');

let history;
let nextId;
let writes;

function installDependencies({ vip = true } = {}) {
  history = [
    {
      id: 'history-1', name: 'Primary', url: 'https://one.test', tabId: 'tab-1', isOpen: true,
      settings: {
        proxy: { mode: 'default', host: 'proxy.test', username: 'user', password: 'secret', apiUrl: 'https://proxy.test/token' },
        cookies: '[{"name":"sid","value":"secret"}]',
        launchArgs: { mode: 'custom', value: '--fixture-secret' },
      },
    },
    { id: 'history-2', name: 'Duplicate', url: 'https://two.test' },
    { id: 'history-3', name: 'Duplicate', url: 'https://three.test' },
  ];
  nextId = 10;
  writes = [];
  require.cache[historyDependency] = { exports: {
    DEFAULT_BROWSER_WINDOW_NAME: 'New window',
    DEFAULT_BROWSER_WINDOW_URL: 'chrome://newtab/',
    createBrowserHistoryId: () => `history-${nextId++}`,
    makeUniqueBrowserName: (name, records) => {
      const base = String(name || 'New window').trim();
      return records.some((item) => item.name === base) ? `${base} (2)` : base;
    },
    openBrowserHistoryRecord: async (_ui, id) => ({ historyId: id, tabId: 'opened-tab', name: history.find((item) => item.id === id)?.name }),
    readBrowserHistorySafe: () => history.map((item) => ({ ...item })),
    editBrowserHistoryRecord: (_ui, id, changes) => {
      const item = history.find((record) => record.id === id);
      const previousName = item.name;
      if (changes.name) item.name = changes.name;
      if (changes.settings) item.settings = changes.settings;
      return { historyId: id, name: item.name, previousName, settings: item.settings, tabId: item.tabId || '' };
    },
    serializeBrowserHistory: (records) => records.map((item) => ({ ...item })),
    syncOpenTabsToBrowserHistory: () => history,
    writeBrowserHistorySafe: (records) => {
      history = records.map((item) => ({ ...item }));
      writes.push(history);
      return true;
    },
  } };
  require.cache[storeDependency] = { exports: { readStoreConfigSafe: () => ({ aiFreeBrowserSettings: { homepage: { mode: 'custom', url: 'https://home.test' } } }) } };
  require.cache[settingsDependency] = { exports: { normalizeAiFreeBrowserSettings: (value) => value } };
  require.cache[vipDependency] = { exports: { FREE_BROWSER_WINDOW_LIMIT: 2, resolveVipAccess: () => ({ isVip: vip }) } };
  delete require.cache[target];
  return require(target);
}

test('window tool registry lists records and validates lookup arguments', async () => {
  const { createAiBrowserWindowTools } = installDependencies();
  assert.throws(() => createAiBrowserWindowTools({}), /缺少 ui 桥接/);
  const logLines = [];
  const tools = createAiBrowserWindowTools({
    ui: { getTabs: () => new Map([['tab-1', { id: 'tab-1', browserHistoryId: 'history-1' }]]) },
    logger: { log: (line) => logLines.push(line) },
  });
  assert.equal(tools.tools.length, 1);
  assert.equal(tools.tools[0].input_schema.properties.action.enum.includes('edit'), true);
  assert.equal(tools.has('software_window'), true);
  assert.equal(tools.has(' unknown '), false);
  const listed = await tools.execute('software_window', { action: 'list', include_settings: true });
  assert.equal(listed.total, 3);
  assert.equal(listed.open_count, 1);
  assert.equal(listed.items[0].history_id, 'history-1');
  assert.equal(listed.items[0].settings.proxy.mode, 'default');
  assert.equal(listed.items[0].settings.proxy.username, '[REDACTED]');
  assert.equal(listed.items[0].settings.proxy.password, '[REDACTED]');
  assert.equal(listed.items[0].settings.proxy.apiUrl, '[CONFIGURED]');
  assert.equal(listed.items[0].settings.launchArgs.value, '[CONFIGURED]');
  assert.equal('cookies' in listed.items[0].settings, false);
  assert.match(logLines[0], /software_window\.list/);
  await assert.rejects(tools.execute('missing'), /未知的软件窗口工具/);
  await assert.rejects(tools.execute('software_window', {}), /未提供 action/);
  await assert.rejects(tools.execute('software_window', { action: 'open' }), /history_id 或 name/);
  await assert.rejects(tools.execute('software_window', { action: 'open', history_id: 'missing' }), /记录不存在/);
  await assert.rejects(tools.execute('software_window', { action: 'open', name: 'Duplicate' }), /2 个窗口/);
  const opened = await tools.execute('software_window', { action: 'open', name: 'primary' });
  assert.equal(opened.history_id, 'history-1');
  assert.equal(opened.tab_id, 'opened-tab');
  assert.equal(opened.browser_total, 3);
  assert.deepEqual(opened.browser_names, ['Primary', 'Duplicate', 'Duplicate']);
  assert.equal(opened.control_browser_requested, true);
});

test('create validates access and URL, persists before opening, and rolls back failures', async () => {
  let addShouldFail = false;
  const { createAiBrowserWindowTools } = installDependencies();
  const tabs = new Map();
  const changes = [];
  const tools = createAiBrowserWindowTools({
    licenseCache: { getSnapshot: () => ({}) },
    ui: {
      addTab: async (url) => {
        if (addShouldFail) throw new Error('runtime failed');
        assert.equal(url, 'https://home.test');
        return 'new-tab';
      },
      getTabs: () => tabs,
      sendToSide: (channel) => changes.push(channel),
    },
  });
  await assert.rejects(tools.execute('software_window', { action: 'create', url: 'file:///secret' }), /http\/https/);
  const created = await tools.execute('software_window', {
    action: 'create', name: 'Primary', settings: { timezone: { mode: 'custom', value: 'UTC' } },
  });
  assert.equal(created.name, 'Primary (2)');
  assert.equal(created.url, 'https://home.test');
  assert.equal(created.control_browser_requested, true);
  assert.equal(created.browser_total, 4);
  assert.equal(history.some((item) => item.id === created.history_id), true);
  assert.equal(history.find((item) => item.id === created.history_id).settings.timezone.value, 'UTC');
  assert.deepEqual(changes, ['browser-history-changed']);
  assert.equal(writes.length, 1);

  addShouldFail = true;
  await assert.rejects(tools.execute('software_window', { action: 'create', name: 'Failure' }), /runtime failed/);
  assert.equal(history.some((item) => item.name === 'Failure'), false);
  assert.equal(writes.length, 3);

  const freeModule = installDependencies({ vip: false });
  const limited = freeModule.createAiBrowserWindowTools({
    licenseCache: { getSnapshot: () => ({}) },
    ui: { getTabs: () => new Map([['a', {}], ['b', {}]]), addTab: async () => 'x' },
  });
  await assert.rejects(limited.execute('software_window', { action: 'create' }), /普通用户最多/);
});

test('open waits for the matching native connection and reports timeout as partial failure', async () => {
  const { createAiBrowserWindowTools } = installDependencies();
  const base = {
    ui: { getTabs: () => new Map([['tab-1', { id: 'tab-1', browserHistoryId: 'history-1' }]]) },
  };
  const ready = createAiBrowserWindowTools({
    ...base,
    waitForBrowserConnection: async (target) => ({ id: 'mcp-primary', name: target.name }),
  });
  const connected = await ready.execute('software_window', { action: 'open', name: 'Primary' });
  assert.equal(connected.success, true);
  assert.equal(connected.mcp_connected, true);
  assert.equal(connected.control_browser_id, 'mcp-primary');

  const unavailable = createAiBrowserWindowTools({
    ...base,
    waitForBrowserConnection: async () => null,
  });
  const timedOut = await unavailable.execute('software_window', { action: 'open', name: 'Primary' });
  assert.equal(timedOut.success, false);
  assert.equal(timedOut.mcp_connected, false);
  assert.match(timedOut.error, /窗口.*已打开.*原生控制通道未在等待时间内就绪/);
});

test('edit updates name and per-browser settings while close preserves records', async () => {
  const { createAiBrowserWindowTools } = installDependencies();
  const closed = [];
  const applied = [];
  const tabs = new Map([['tab-1', { id: 'tab-1', browserHistoryId: 'history-1' }]]);
  const tools = createAiBrowserWindowTools({
    ui: {
      closeTab: async (id) => closed.push(id),
      getTabs: () => tabs,
      setTabBrowserSettings: async (...args) => { applied.push(args); return { ok: true, restarted: true }; },
      sendToSide() {},
    },
  });
  await assert.rejects(tools.execute('software_window', { action: 'edit', history_id: 'history-1' }), /至少需要/);
  await assert.rejects(tools.execute('software_window', {
    action: 'edit', history_id: 'history-1', settings: { cookies: '[]' },
  }), /不支持的环境配置字段/);
  const edited = await tools.execute('software_window', {
    action: 'edit', history_id: 'history-1', new_name: 'Renamed',
    settings: { proxy: { mode: 'none' }, timezone: { mode: 'custom', value: 'Asia/Shanghai' } },
  });
  assert.equal(edited.previous_name, 'Primary');
  assert.equal(edited.name, 'Renamed');
  assert.deepEqual(edited.changed_settings, ['proxy', 'timezone']);
  assert.equal(history[0].settings.proxy.mode, 'none');
  assert.equal(history[0].settings.proxy.host, 'proxy.test');
  assert.equal(applied[0][0], 'tab-1');
  assert.equal(applied[0][2].restartChromium, true);
  const openClosed = await tools.execute('software_window', { action: 'close', history_id: 'history-1' });
  assert.equal(openClosed.closed, true);
  assert.equal(openClosed.browser_total, 3);
  assert.deepEqual(openClosed.browser_names, ['Renamed', 'Duplicate', 'Duplicate']);
  assert.deepEqual(closed, ['tab-1']);
  const alreadyClosed = await tools.execute('software_window', { action: 'close', history_id: 'history-2' });
  assert.equal(alreadyClosed.closed, false);
});
