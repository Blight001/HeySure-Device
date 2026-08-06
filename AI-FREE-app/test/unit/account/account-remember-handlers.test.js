'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAccountRememberHandlers,
} = require('../../../src/app/main/features/account/account-remember-handlers');

function createFixture(overrides = {}) {
  const deleted = [];
  const events = [];
  const account = {
    id: 'account-1',
    accountName: 'Account One',
    currentUrl: 'https://dream.example',
  };
  const deps = {
    accountStorage: {
      addAccount: () => ({ ok: true, account }),
      deleteAccount: (id) => { deleted.push(id); return { ok: true }; },
      getAccount: () => ({ ok: true, account }),
      getAllAccounts: () => [account],
      updateLastUsedTime() {},
    },
    auth: { fetchCookieFromServerForDream: async () => ({ cookies: [{ name: 'sid' }] }) },
    cleanupAccountProfile: async () => ({ ok: true }),
    computeDeviceId: async () => 'device-1',
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    DREAM_TARGET_URL: 'https://dream.example',
    fs: { readFileSync: () => '{}' },
    getDreamTargetUrl: () => 'https://dream.example',
    getStorePath: () => 'store',
    httpClient: {},
    inferImportedTargetUrl: () => 'https://dream.example',
    ipcMain: {},
    isPlaceholderTargetUrl: () => false,
    licenseCache: {
      getSnapshot: () => ({ key: 'license-key', deviceId: 'device-1' }),
      getRuntimeConfig: () => ({ platformName: 'Dream' }),
      setCredentials() {},
    },
    parseImportedAccountContent: () => ({ cookies: [], browserStorage: [] }),
    path: { basename: () => 'imported', extname: () => '.json' },
    resolveConfiguredDreamTargetUrl: (readTarget, fallback) => readTarget() || fallback,
    showImportedPlatformPrompt: async () => ({ confirmed: true, cancelled: false }),
    ui: {
      addTab: async () => 'tab-1',
      browserRuntimeManager: {
        importSession: async () => {},
        reload: async () => {},
        store: { readProfile: () => ({ createdAt: '2026-01-01' }) },
      },
      sendToSide: (channel, payload) => events.push({ channel, payload }),
    },
    updateAccountRecycleTimer() {},
    ...overrides,
  };
  return { account, deleted, deps, events, handlers: createAccountRememberHandlers(deps) };
}

test('账号保存后的 Chromium 注入失败会清理 Profile 并回滚账号记录', async () => {
  const fixture = createFixture();
  fixture.deps.ui.browserRuntimeManager.importSession = async () => { throw new Error('import failed'); };
  const result = await fixture.handlers.saveAccount(null, {
    accountName: 'Account One',
    cookies: [{ name: 'sid', value: 'redacted' }],
  });

  assert.deepEqual(result, { ok: false, error: 'import failed' });
  assert.deepEqual(fixture.deleted, ['account-1']);
});

test('批量删除报告部分失败且只删除清理成功的账号', async () => {
  const fixture = createFixture({
    cleanupAccountProfile: async (id) => id === 'bad'
      ? { ok: false, error: 'profile busy' }
      : { ok: true },
  });
  const result = await fixture.handlers.deleteAccounts(null, {
    accountIds: ['good', 'bad', 'good', ''],
  });

  assert.equal(result.ok, false);
  assert.equal(result.removedCount, 1);
  assert.deepEqual(result.failed, [{ accountId: 'bad', error: 'profile busy' }]);
  assert.deepEqual(fixture.deleted, ['good']);
  assert.equal(fixture.events.at(-1).channel, 'account-list-updated');
});

test('导入文件选择被取消时不读取文件或写入账号', async () => {
  let reads = 0;
  const fixture = createFixture({
    fs: { readFileSync: () => { reads += 1; return '{}'; } },
  });
  const result = await fixture.handlers.importCookieFile();

  assert.deepEqual(result, { ok: false, cancelled: true, error: '已取消导入' });
  assert.equal(reads, 0);
});

test('切换历史账号只恢复已有 Profile，不重新注入会话', async () => {
  const opened = [];
  const fixture = createFixture();
  fixture.deps.ui.addTab = async (url, options) => { opened.push({ url, options }); return 'tab-history'; };
  fixture.deps.ui.browserRuntimeManager.importSession = async () => {
    throw new Error('历史账号不应重新注入');
  };
  const result = await fixture.handlers.switchAccount(null, { accountId: ' account-1 ' });

  assert.deepEqual(result, { ok: true, tabId: 'tab-history', accountId: 'account-1' });
  assert.equal(opened[0].url, 'https://dream.example');
  assert.equal(opened[0].options.restoreLastSession, true);
});
