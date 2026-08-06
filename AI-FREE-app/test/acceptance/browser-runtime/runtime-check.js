// @ts-nocheck -- acceptance fixture exercises intentionally broad runtime doubles.
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const projectRoot = path.resolve(__dirname, '../../..');
const {
  applyChromiumSessionStartupPolicy,
  assertSafeChromiumArgs,
  buildChromiumArgs,
  buildChromiumEnvironment,
  captureChromiumSessionFiles,
  getSystemChromiumCandidates,
  persistStableChromiumSession,
  prepareChromiumSessionRecovery,
  repairBlankLatestSession,
  resolveChromiumExecutable,
  restoreChromiumSessionFiles,
  shouldIgnoreChromiumDiagnostic,
  snapshotHasRestorableSession,
} = require('../../../src/app/main/browser-runtime/chromium-launcher');
const { encodeFrame, MAX_MESSAGE_BYTES, PROTOCOL_VERSION } = require('../../../src/app/main/browser-runtime/chromium-command-client');
const {
  legacySafeProfileId,
  ProfileRuntimeStore,
  safeProfileId,
} = require('../../../src/app/main/browser-runtime/profile-runtime-store');
const { RUNTIME_STATUS } = require('../../../src/app/main/browser-runtime/runtime-types');
const { prepareSessionImport } = require('../../../src/app/main/browser-runtime/session-import');
const { ChromiumRuntime } = require('../../../src/app/main/browser-runtime/chromium-runtime');
const { createTabManager, resolveChromiumExtensionPaths } = require('../../../src/app/main/services/tab-manager');
const { createBrowserPartitionCleaner } = require('../../../src/app/main/services/browser-partitions');
const { cleanupAccountProfile } = require('../../../src/app/main/services/account-profile-cleanup');
const { initializeAccountCleanup } = require('../../../src/app/main/utils/accountCleanup');

function buildSnssSession({ url = 'https://example.com/work', closed = false } = {}) {
  const command = (id, payload) => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
    const result = Buffer.alloc(3 + data.length);
    result.writeUInt16LE(1 + data.length, 0);
    result[2] = id;
    data.copy(result, 3);
    return result;
  };
  const pair = Buffer.alloc(8);
  pair.writeInt32LE(101, 0);
  pair.writeInt32LE(102, 4);
  const windowType = Buffer.alloc(8);
  windowType.writeInt32LE(101, 0);
  const closedPayload = Buffer.alloc(12);
  closedPayload.writeInt32LE(102, 0);
  const header = Buffer.alloc(8);
  header.write('SNSS', 0, 'ascii');
  header.writeInt32LE(3, 4);
  return Buffer.concat([
    header,
    command(9, windowType),
    command(0, pair),
    command(6, Buffer.from(url, 'utf8')),
    ...(closed ? [command(16, closedPayload)] : []),
  ]);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-runtime-test-'));
(async () => {
try {
  assert.equal(shouldIgnoreChromiumDiagnostic('WSALookupServiceBegin failed with: 10108'), true);
  assert.equal(shouldIgnoreChromiumDiagnostic('WSALookupServiceBegin failed with: 10022'), false);
  const store = new ProfileRuntimeStore({ rootDir: root, logger: { warn() {} } });
  const paths = store.ensureProfile({ profileId: 'profile_001', runtimeType: 'chromium' });
  assert(fs.existsSync(paths.chromiumData));
  assert(fs.existsSync(paths.downloads));
  store.createState('profile_001', 'chromium');
  store.transition('profile_001', RUNTIME_STATUS.STARTING);
  store.transition('profile_001', RUNTIME_STATUS.WAITING_PIPE);
  assert.throws(() => store.transition('profile_001', RUNTIME_STATUS.READY), /非法运行时状态迁移/);
  store.acquireLock('profile_001');
  assert.throws(() => new ProfileRuntimeStore({ rootDir: root }).acquireLock('profile_001'), /已被进程/);
  assert.throws(() => store.clearBrowserData('profile_001'), /仍在运行/);
  store.releaseLock('profile_001');
  fs.writeFileSync(path.join(paths.chromiumData, 'Cookies'), 'cookie-data');
  fs.writeFileSync(path.join(paths.downloads, 'keep.txt'), 'download-data');
  fs.mkdirSync(path.join(paths.root, 'session-recovery-stable'), { recursive: true });
  fs.writeFileSync(path.join(paths.root, 'session-recovery-stable', 'Session_1'), 'session-data');
  assert.equal(store.clearBrowserData('profile_001'), true);
  assert.equal(fs.existsSync(path.join(paths.chromiumData, 'Cookies')), false);
  assert.equal(fs.existsSync(path.join(paths.downloads, 'keep.txt')), true, '清空浏览器数据必须保留下载文件');
  assert.equal(fs.existsSync(paths.config), true, '清空浏览器数据必须保留 Profile 配置');
  assert.equal(fs.existsSync(path.join(paths.root, 'session-recovery-stable')), false);
  assert.equal(store.deleteProfile('profile_001'), true);
  assert.equal(fs.existsSync(paths.root), false);

  const asyncDeletePaths = store.ensureProfile({ profileId: 'profile_async_delete', runtimeType: 'chromium' });
  fs.mkdirSync(path.join(asyncDeletePaths.chromiumData, 'Cache', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(asyncDeletePaths.chromiumData, 'Cache', 'nested', 'entry'), 'cache-data');
  assert.equal(await store.deleteProfileAsync('profile_async_delete'), true);
  assert.equal(fs.existsSync(asyncDeletePaths.root), false, '后台删除必须清理完整 Chromium Profile');

  const legacyElectronUserData = path.join(root, 'electron-user-data');
  const legacyPartitionRoot = path.join(legacyElectronUserData, 'Partitions');
  fs.mkdirSync(path.join(legacyPartitionRoot, 'tab-account@example.com'), { recursive: true });
  fs.writeFileSync(path.join(legacyPartitionRoot, 'tab-account@example.com', 'Cookies'), 'legacy');
  const partitionCleaner = createBrowserPartitionCleaner({
    app: { getPath: () => legacyElectronUserData },
    fs,
    path,
    BrowserWindow: { getAllWindows: () => [] },
    logger: { log() {}, warn() {} },
  });
  assert.equal(partitionCleaner.isPersistentManagedTabPartitionName('tab-account@example.com'), false);
  const partitionCleanup = await partitionCleaner.cleanupBrowserPartitionsRootDir();
  assert.equal(partitionCleanup.removed, true);
  assert.equal(partitionCleanup.keptPersistentCount, 0);
  assert.equal(fs.existsSync(legacyPartitionRoot), false, '旧 Electron Partitions 必须整体回收');

  const sharedPaths = store.ensureProfile({ profileId: 'shared-account', runtimeType: 'chromium' });
  const configPath = path.join(root, 'store.json');
  fs.writeFileSync(configPath, JSON.stringify({
    browserHistory: [
      { id: 'account-history', accountId: 'shared-account' },
      { id: 'independent-history', accountId: '' },
    ],
  }), 'utf8');
  let closedTabId = '';
  const cleanupResult = await cleanupAccountProfile('shared-account', {
    browserRuntimeManager: {
      getState: () => null,
      deleteProfile: (profileId) => store.deleteProfile(profileId),
    },
    getTabs: () => new Map([['shared-account', { id: 'shared-account', accountId: 'shared-account' }]]),
    closeTab: async (tabId) => { closedTabId = tabId; },
    fs,
    getStorePath: () => configPath,
    logger: { log() {}, warn() {} },
  });
  assert.equal(cleanupResult.ok, true);
  assert.equal(closedTabId, 'shared-account');
  assert.equal(fs.existsSync(sharedPaths.root), false, '循环账号清理必须删除整个 Chromium Profile');
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).browserHistory, [
    { id: 'independent-history', accountId: '' },
  ]);

  const expiredPaths = store.ensureProfile({ profileId: 'expired-shared-account', runtimeType: 'chromium' });
  let deletedExpiredMetadata = false;
  const cleanupSummary = await initializeAccountCleanup({
    getAllAccounts: () => [{
      id: 'expired-shared-account',
      currentAccountType: 'shared',
      serverRecycleTimeTs: Date.now() - 1000,
    }],
    deleteAccount: (accountId) => {
      deletedExpiredMetadata = accountId === 'expired-shared-account';
      return { ok: true };
    },
  }, {
    cleanupAccountArtifacts: (accountId) => cleanupAccountProfile(accountId, {
      browserRuntimeManager: {
        getState: () => null,
        deleteProfile: (profileId) => store.deleteProfile(profileId),
      },
      getTabs: () => new Map(),
      closeTab: async () => {},
      fs,
      getStorePath: () => configPath,
      logger: { log() {}, warn() {} },
    }),
  });
  assert.equal(cleanupSummary.removed, 1);
  assert.equal(deletedExpiredMetadata, true);
  assert.equal(fs.existsSync(expiredPaths.root), false, '到期循环账号必须先删除 Profile 再删除元数据');

  const rebuiltPaths = store.ensureProfile({ profileId: 'profile_001', runtimeType: 'chromium' });

  const args = buildChromiumArgs({
    profile: { profileId: 'profile_001', initialUrl: 'https://example.com' }, paths: rebuiltPaths,
    pipeName: '\\\\.\\pipe\\test', launchToken: 'one-time', hostHwnd: '123', bounds: { width: 800, height: 600 },
  });
  assert(args.some((arg) => arg.startsWith('--user-data-dir=')));
  assert(args.includes('--hs-profile-id=profile_001'));
  assert(args.includes('https://example.com'));
  assert(args.includes('--window-position=-32000,-32000'));
  const localizedArgs = buildChromiumArgs({
    profile: {
      profileId: 'localized-profile',
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
    },
    paths: rebuiltPaths,
    pipeName: '\\\\.\\pipe\\localized-profile-test',
    launchToken: 'one-time',
  });
  assert(localizedArgs.includes('--lang=ja-JP'));
  assert(localizedArgs.includes('--hs-timezone-id=Asia/Tokyo'));
  const unicodeProfilePaths = store.ensureProfile({ profileId: '豆包::account@example.com', runtimeType: 'chromium' });
  assert.match(unicodeProfilePaths.id, /^[\x21-\x7e]+$/, '握手 Profile ID 必须是可见 ASCII');
  assert.notEqual(
    safeProfileId('豆包::same@example.com'),
    safeProfileId('本地::same@example.com'),
    '不同业务账号不能再映射到同一个 Chromium Profile 目录',
  );
  assert.equal(
    legacySafeProfileId('豆包::same@example.com'),
    legacySafeProfileId('本地::same@example.com'),
    '测试数据必须能够复现旧版有损目录名碰撞',
  );
  store.createState('豆包::account@example.com', 'chromium');
  assert.equal(store.getState('豆包::account@example.com').profileId, '豆包::account@example.com');
  store.clearState('豆包::account@example.com');

  const legacyBusinessId = '豆包::legacy@example.com';
  const legacyProfileRoot = path.join(root, legacySafeProfileId(legacyBusinessId));
  fs.mkdirSync(path.join(legacyProfileRoot, 'chromium-data'), { recursive: true });
  fs.writeFileSync(path.join(legacyProfileRoot, 'migration-marker'), 'preserved');
  fs.writeFileSync(path.join(legacyProfileRoot, 'profile.json'), JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z' }));
  const migratedPaths = store.ensureProfile({ profileId: legacyBusinessId, displayName: '迁移测试' });
  assert.notEqual(migratedPaths.root, legacyProfileRoot);
  assert.equal(fs.existsSync(legacyProfileRoot), false);
  assert.equal(fs.readFileSync(path.join(migratedPaths.root, 'migration-marker'), 'utf8'), 'preserved');
  assert.equal(JSON.parse(fs.readFileSync(migratedPaths.config, 'utf8')).profileId, legacyBusinessId);
  const profileAudit = store.auditProfiles(['豆包::account@example.com', legacyBusinessId]);
  assert(!profileAudit.orphanProfiles.some((profile) => profile.storageId === unicodeProfilePaths.id));
  assert(!profileAudit.orphanProfiles.some((profile) => profile.storageId === migratedPaths.id));
  const unicodeProfileArgs = buildChromiumArgs({
    profile: { profileId: '豆包::account@example.com' },
    runtimeProfileId: unicodeProfilePaths.id,
    paths: unicodeProfilePaths,
    pipeName: '\\\\.\\pipe\\unicode-profile-test',
    launchToken: 'one-time',
    hostHwnd: '123',
  });
  assert(unicodeProfileArgs.includes(`--hs-profile-id=${unicodeProfilePaths.id}`));
  assert(!unicodeProfileArgs.includes('--hs-profile-id=豆包::account@example.com'));
  const restoreArgs = buildChromiumArgs({
    profile: { profileId: 'profile_001', initialUrl: '', restoreLastSession: true },
    paths: rebuiltPaths,
    pipeName: '\\\\.\\pipe\\test',
    launchToken: 'one-time',
  });
  assert(restoreArgs.includes('--restore-last-session'));
  assert(!restoreArgs.includes('https://example.com'));
  const preferencesPath = path.join(rebuiltPaths.chromiumData, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
  fs.writeFileSync(preferencesPath, JSON.stringify({ session: { restore_on_startup: 1 }, preserved: { value: true } }));
  assert.equal(applyChromiumSessionStartupPolicy(rebuiltPaths, { warn() {} }, {
    locale: 'en-SG',
    acceptLanguage: 'en-SG,en;q=0.9,en-US;q=0.8',
  }), true);
  const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
  assert.equal(preferences.session.restore_on_startup, 5);
  assert.deepEqual(preferences.session.startup_urls, []);
  assert.equal(preferences.profile.exit_type, 'Normal');
  assert.equal(preferences.profile.exited_cleanly, true);
  assert.equal(preferences.intl.accept_languages, 'en-SG,en,en-US');
  assert.equal(preferences.intl.selected_languages, 'en-SG,en,en-US');
  assert.equal(preferences.preserved.value, true);
  assert.equal(applyChromiumSessionStartupPolicy(rebuiltPaths, { warn() {} }, {
    restoreLastSession: true,
  }), true);
  const restorePreferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
  assert.equal(restorePreferences.session.restore_on_startup, 1);

  const sessionRecoveryPaths = {
    root: path.join(root, 'session-recovery-profile'),
    chromiumData: path.join(root, 'session-recovery-profile', 'chromium-data'),
  };
  const sessionsDir = path.join(sessionRecoveryPaths.chromiumData, 'Default', 'Sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const validSession = buildSnssSession();
  const closedSession = buildSnssSession({ closed: true });
  fs.writeFileSync(path.join(sessionsDir, 'Session_100'), validSession);
  fs.writeFileSync(path.join(sessionsDir, 'Tabs_101'), validSession);
  fs.writeFileSync(path.join(sessionsDir, 'Session_200'), closedSession);
  fs.writeFileSync(path.join(sessionsDir, 'Tabs_201'), closedSession);
  const repairResult = repairBlankLatestSession(sessionRecoveryPaths, { warn() {} });
  assert.equal(repairResult.repaired, true, '最新空白会话应回退至上一组有效网页会话');
  assert.deepEqual(repairResult.removed.sort(), ['Session_200', 'Tabs_201']);
  assert.equal(fs.existsSync(path.join(sessionsDir, 'Session_100')), true);
  assert.equal(fs.existsSync(path.join(sessionsDir, 'Session_200')), false);

  const preCloseSnapshot = captureChromiumSessionFiles(sessionRecoveryPaths, { warn() {} });
  assert.equal(preCloseSnapshot.files.length, 2);
  assert.equal(snapshotHasRestorableSession(preCloseSnapshot), true);
  assert.equal(persistStableChromiumSession(sessionRecoveryPaths, preCloseSnapshot, { warn() {} }), true);
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'Session_300'), closedSession);
  fs.writeFileSync(path.join(sessionsDir, 'Tabs_301'), closedSession);
  const stableRecovery = prepareChromiumSessionRecovery(sessionRecoveryPaths, { warn() {} });
  assert.deepEqual(stableRecovery, { restorable: true, source: 'stable-backup' });
  assert.equal(Buffer.compare(fs.readFileSync(path.join(sessionsDir, 'Session_100')), validSession), 0);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(sessionsDir, 'Tabs_101')), validSession), 0);
  assert.equal(fs.existsSync(path.join(sessionsDir, 'Session_300')), false);

  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'Session_400'), closedSession);
  assert.equal(restoreChromiumSessionFiles(preCloseSnapshot, { warn() {} }), true);
  assert.equal(fs.existsSync(path.join(sessionsDir, 'Session_400')), false);

  const nativeRuntimeBridge = fs.readFileSync(path.join(
    projectRoot,
    'native',
    'chromium-fork',
    'overlay',
    'chrome',
    'browser',
    'ui',
    'views',
    'frame',
    'ai_free_runtime_bridge_win.cc',
  ), 'utf8');
  assert(nativeRuntimeBridge.includes('chrome::CloseAllBrowsersAndQuit()'));
  assert(!nativeRuntimeBridge.includes('browser->window()->Close()'));
  const managedExtension = path.join(root, 'managed-extension');
  const configuredExtension = path.join(root, 'configured-extension');
  fs.mkdirSync(managedExtension);
  fs.mkdirSync(configuredExtension);
  const extensionPaths = resolveChromiumExtensionPaths({
    chromiumExtensionPaths: [configuredExtension, managedExtension, ''],
  }, {
    getEnabledExtensionPaths: () => [managedExtension],
  });
  assert.deepEqual(extensionPaths, [managedExtension, configuredExtension]);
  const extensionArgs = buildChromiumArgs({
    profile: { profileId: 'profile_001', extensionPaths },
    paths: rebuiltPaths,
    pipeName: '\\\\.\\pipe\\test',
    launchToken: 'one-time',
  });
  assert(extensionArgs.includes(`--load-extension=${managedExtension},${configuredExtension}`));
  const googleEnvironment = buildChromiumEnvironment({}, {
    AI_FREE_GOOGLE_API_KEY: 'ai-free-api-key',
    AI_FREE_GOOGLE_CLIENT_ID: 'ai-free-client-id',
    AI_FREE_GOOGLE_CLIENT_SECRET: 'ai-free-client-secret',
  });
  assert.equal(googleEnvironment.GOOGLE_API_KEY, 'ai-free-api-key');
  assert.equal(googleEnvironment.GOOGLE_DEFAULT_CLIENT_ID, 'ai-free-client-id');
  assert.equal(googleEnvironment.GOOGLE_DEFAULT_CLIENT_SECRET, 'ai-free-client-secret');
  assert.equal(buildChromiumEnvironment({
    GOOGLE_API_KEY: 'native-key',
    AI_FREE_GOOGLE_API_KEY: 'branded-key',
  }).GOOGLE_API_KEY, 'native-key');
  assert.equal(buildChromiumEnvironment({}, { TZ: 'Asia/Tokyo' }).TZ, 'Asia/Tokyo');
  assert(getSystemChromiumCandidates({
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  }).some((candidate) => candidate.endsWith('Google\\Chrome\\Application\\chrome.exe')));
  assert.throws(() => assertSafeChromiumArgs(['--no-sandbox']), /禁止使用/);
  assert.throws(() => assertSafeChromiumArgs(['--remote-debugging-address=0.0.0.0']), /回环/);
  const packagedRoot = path.join(root, 'packaged-resources');
  const packagedBrowser = path.join(packagedRoot, 'chromium', 'ai-free-browser.exe');
  fs.mkdirSync(path.dirname(packagedBrowser), { recursive: true });
  fs.writeFileSync(packagedBrowser, 'test');
  assert.equal(resolveChromiumExecutable({ resourcesPath: packagedRoot, profile: {} }), packagedBrowser);
  // Development bootstrap must pass the application's resources directory,
  // not Electron's own node_modules/electron/dist/resources directory.
  const developmentResources = path.join(projectRoot, 'resources');
  if (fs.existsSync(path.join(developmentResources, 'chromium', 'ai-free-browser.exe'))) {
    assert.equal(
      resolveChromiumExecutable({ resourcesPath: developmentResources, profile: {} }),
      path.join(developmentResources, 'chromium', 'ai-free-browser.exe'),
    );
  }
  const legacyRoot = path.join(root, 'legacy-resources');
  const legacyChrome = path.join(legacyRoot, 'chromium', 'chrome.exe');
  fs.mkdirSync(path.dirname(legacyChrome), { recursive: true });
  fs.writeFileSync(legacyChrome, 'test');
  assert.throws(() => resolveChromiumExecutable({ resourcesPath: legacyRoot, profile: {} }), /正式模式禁止/);
  const previousHandshakeMode = process.env.AI_FREE_CHROMIUM_HANDSHAKE;
  process.env.AI_FREE_CHROMIUM_HANDSHAKE = 'prototype';
  assert.equal(resolveChromiumExecutable({
    resourcesPath: path.join(root, 'missing-resources'),
    executablePath: packagedBrowser,
    profile: {},
  }), packagedBrowser);
  if (previousHandshakeMode === undefined) delete process.env.AI_FREE_CHROMIUM_HANDSHAKE;
  else process.env.AI_FREE_CHROMIUM_HANDSHAKE = previousHandshakeMode;
  assert.throws(() => resolveChromiumExecutable({
    resourcesPath: path.join(root, 'missing-resources'),
    executablePath: packagedBrowser,
    profile: {},
  }), /正式模式禁止/);
  const frame = encodeFrame({ type: 'heartbeat', protocolVersion: PROTOCOL_VERSION });
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  assert.equal(JSON.parse(frame.subarray(4).toString('utf8')).type, 'heartbeat');
  assert.throws(() => encodeFrame({ payload: 'x'.repeat(MAX_MESSAGE_BYTES + 1) }), /消息过大/);
  const sessionImport = prepareSessionImport({
    targetUrl: 'https://app.example.com/work',
    cookies: [{
      name: 'auth', value: 'token', domain: '.example.com', path: '/work',
      secure: true, httpOnly: true, sameSite: 'None', expirationDate: 2_000_000_000,
    }],
    browserStorage: [{
      origin: 'https://app.example.com',
      localStorage: { local_key: 'local_value' },
      sessionStorage: { session_key: 'session_value' },
    }],
  });
  assert.deepEqual(sessionImport.cookies[0], {
    name: 'auth', value: 'token', url: 'https://app.example.com/work',
    domain: '.example.com', path: '/work', secure: true, httpOnly: true,
    sameSite: 'no_restriction', expires: 2_000_000_000,
  });
  assert.equal(sessionImport.browserStorage[0].origin, 'https://app.example.com');
  const mixedDomainImport = prepareSessionImport({
    targetUrl: 'https://app.example.com/',
    cookies: [
      { name: 'auth', value: 'valid', domain: '.example.com' },
      { name: 'NID', value: 'unrelated', url: 'https://www.google.com/', domain: '.google.com' },
    ],
    browserStorage: [
      { origin: 'https://app.example.com', localStorage: { valid: '1' } },
      { origin: 'https://unrelated.test', localStorage: { ignored: '1' } },
    ],
  });
  assert.deepEqual(mixedDomainImport.cookies.map((cookie) => cookie.name), ['auth']);
  assert.deepEqual(mixedDomainImport.browserStorage.map((entry) => entry.origin), ['https://app.example.com']);
  assert.equal(mixedDomainImport.skippedCookies, 1);
  assert.equal(mixedDomainImport.skippedStorageOrigins, 1);
  assert.throws(() => prepareSessionImport({
    targetUrl: 'https://app.example.com/',
    browserStorage: [{
      origin: 'https://app.example.com',
      localStorage: { huge: 'x'.repeat(3 * 1024 * 1024) },
    }],
  }), (error) => ['SESSION_STORAGE_LIMIT', 'SESSION_IMPORT_TOO_LARGE'].includes(error.code));
  const navigationTimeoutRuntime = new ChromiumRuntime({
    logger: { info() {}, warn() {} },
  });
  const navigationTimeoutCodes = ['NAVIGATION_TIMEOUT', 'RUNTIME_COMMAND_TIMEOUT', 'NAVIGATION_FAILED'];
  navigationTimeoutRuntime.getReadyInstance = () => ({
    commandClient: {
      async send(command) {
        if (command === 'navigate') {
          const errorCode = navigationTimeoutCodes.shift();
          const error = new Error(errorCode === 'NAVIGATION_FAILED'
            ? '页面加载失败: -3 https://www.dola.com/chat/'
            : 'Runtime Bridge 命令超时: navigate');
          error.code = errorCode;
          throw error;
        }
        return { result: { imported: 0 } };
      },
    },
  });
  const pendingNavigationImport = await navigationTimeoutRuntime.importSession('slow-profile', {
    targetUrl: 'https://slow.example.com/',
  });
  assert.equal(pendingNavigationImport.ok, true);
  assert.equal(pendingNavigationImport.navigation.pending, true);
  assert.equal(pendingNavigationImport.navigation.timedOut, true);
  const bridgeTimeoutImport = await navigationTimeoutRuntime.importSession('bridge-timeout-profile', {
    targetUrl: 'https://slow.example.com/',
  });
  assert.equal(bridgeTimeoutImport.ok, true);
  assert.equal(bridgeTimeoutImport.navigation.pending, true);
  assert.equal(bridgeTimeoutImport.navigation.timedOut, true);
  const redirectedNavigationImport = await navigationTimeoutRuntime.importSession('redirected-profile', {
    targetUrl: 'https://www.dola.com/chat/',
  });
  assert.equal(redirectedNavigationImport.ok, true);
  assert.equal(redirectedNavigationImport.navigation.pending, true);
  assert.equal(redirectedNavigationImport.navigation.interrupted, true);
  assert.equal(redirectedNavigationImport.navigation.timedOut, false);
  const injectionOnlyCommands = [];
  const injectionOnlyRuntime = new ChromiumRuntime({ logger: { info() {}, warn() {} } });
  injectionOnlyRuntime.getReadyInstance = () => ({
    commandClient: {
      async send(command) {
        injectionOnlyCommands.push(command);
        return { result: { imported: command === 'set-cookies' ? 1 : 0 } };
      },
    },
  });
  const injectionOnlyResult = await injectionOnlyRuntime.importSession('account-profile', {
    targetUrl: 'https://app.example.com/work',
    cookies: [{ name: 'auth', value: 'token', domain: '.example.com' }],
    navigateAfterImport: false,
  });
  assert.deepEqual(injectionOnlyCommands, ['clear-session', 'set-cookies']);
  assert.equal(injectionOnlyResult.cookiesImported, 1);
  assert.equal(injectionOnlyResult.navigation.skipped, true);
  const reloadWarnings = [];
  const slowReloadRuntime = new ChromiumRuntime({
    logger: { warn(message) { reloadWarnings.push(message); } },
  });
  slowReloadRuntime.getReadyInstance = () => ({
    commandClient: {
      async send(command) {
        assert.equal(command, 'reload');
        const error = new Error('Runtime Bridge 命令超时: reload');
        error.code = 'RUNTIME_COMMAND_TIMEOUT';
        throw error;
      },
    },
  });
  const slowReloadResult = await slowReloadRuntime.reload('slow-reload-profile');
  assert.equal(slowReloadResult.ok, true);
  assert.equal(slowReloadResult.result.pending, true);
  assert.equal(slowReloadResult.result.timedOut, true);
  assert.equal(reloadWarnings.length, 1);
  const failedReloadRuntime = new ChromiumRuntime({ logger: { warn() {} } });
  failedReloadRuntime.getReadyInstance = () => ({
    commandClient: {
      async send() {
        const error = new Error('Runtime Bridge 连接已关闭');
        error.code = 'RUNTIME_BRIDGE_DISCONNECTED';
        throw error;
      },
    },
  });
  await assert.rejects(
    failedReloadRuntime.reload('failed-reload-profile'),
    (error) => error.code === 'RUNTIME_BRIDGE_DISCONNECTED',
  );
  const restartRuntime = new ChromiumRuntime({ logger: { info() {}, warn() {} } });
  const originalProfile = { profileId: 'restart-profile', initialUrl: 'https://example.com/work', extensionPaths: ['extension-a'] };
  restartRuntime.store = { getState: () => ({ bounds: { x: 0, y: 0, width: 800, height: 600 } }) };
  restartRuntime.instances.set('restart-profile', { profile: originalProfile });
  restartRuntime.stop = async () => {};
  let relaunchedProfile = null;
  restartRuntime.launchProfile = async (profile) => {
    relaunchedProfile = { ...profile };
    restartRuntime.instances.set('restart-profile', { profile: { ...profile } });
    return { status: 'ready' };
  };
  await restartRuntime.restart('restart-profile');
  assert.equal(relaunchedProfile.initialUrl, '');
  assert.equal(relaunchedProfile.restoreLastSession, true);
  assert.equal(restartRuntime.instances.get('restart-profile').profile.initialUrl, 'https://example.com/work');
  assert.equal(restartRuntime.instances.get('restart-profile').profile.restoreLastSession, false);

  const clearRuntime = new ChromiumRuntime({ logger: { info() {}, warn() {} } });
  const clearProfile = { profileId: 'clear-profile', initialUrl: 'https://example.com/start', restoreLastSession: true };
  let clearCalled = false;
  let clearStopOptions = null;
  let clearedRelaunch = null;
  clearRuntime.store = {
    getState: () => ({ bounds: { x: 2, y: 3, width: 900, height: 700 } }),
    clearBrowserData(profileId) {
      assert.equal(profileId, 'clear-profile');
      clearCalled = true;
    },
  };
  clearRuntime.instances.set('clear-profile', { profile: clearProfile });
  clearRuntime.stop = async (_id, options) => { clearStopOptions = options; };
  clearRuntime.launchProfile = async (profile, bounds) => {
    clearedRelaunch = { profile: { ...profile }, bounds: { ...bounds } };
    return { status: 'ready' };
  };
  await clearRuntime.clearData('clear-profile');
  assert.equal(clearStopOptions.preserveSession, false);
  assert.equal(clearCalled, true);
  assert.equal(clearedRelaunch.profile.initialUrl, 'https://example.com/start');
  assert.equal(clearedRelaunch.profile.restoreLastSession, false);
  assert.deepEqual(clearedRelaunch.bounds, { x: 2, y: 3, width: 900, height: 700 });

  // 代理启停触发的 Profile 重启必须等正在执行的导航结束；导航完成后才提交
  // 的会话导入又必须排在重启之后，不能在 stopping/starting 状态中失败。
  const serializedRuntime = new ChromiumRuntime({ logger: { info() {}, warn() {} } });
  const serializedOrder = [];
  let finishNavigation;
  const navigationGate = new Promise((resolve) => { finishNavigation = resolve; });
  serializedRuntime.store = { getState: () => ({ status: RUNTIME_STATUS.READY, bounds: { x: 0, y: 0, width: 800, height: 600 } }) };
  serializedRuntime.instances.set('serialized-profile', {
    profile: { profileId: 'serialized-profile', initialUrl: 'about:blank' },
    commandClient: {
      async send(command) {
        serializedOrder.push(`${command}:start`);
        if (command === 'navigate') await navigationGate;
        serializedOrder.push(`${command}:end`);
        return { result: { imported: 0 } };
      },
    },
  });
  serializedRuntime.stop = async () => { serializedOrder.push('restart:stop'); };
  serializedRuntime.launchProfile = async (profile) => {
    serializedOrder.push('restart:launch');
    serializedRuntime.instances.set('serialized-profile', {
      profile: { ...profile },
      commandClient: {
        async send(command) {
          serializedOrder.push(command);
          return { result: { imported: 0 } };
        },
      },
    });
    return { status: 'ready' };
  };
  const serializedNavigation = serializedRuntime.navigate('serialized-profile', 'https://example.com/work');
  await new Promise((resolve) => setImmediate(resolve));
  const serializedRestart = serializedRuntime.restart('serialized-profile');
  finishNavigation();
  await serializedNavigation;
  const serializedImport = serializedRuntime.importSession('serialized-profile', {
    targetUrl: 'https://example.com/work',
    navigateAfterImport: false,
  });
  await Promise.all([serializedRestart, serializedImport]);
  assert.deepEqual(serializedOrder, [
    'navigate:start',
    'navigate:end',
    'restart:stop',
    'restart:launch',
    'clear-session',
  ]);

  const tutorialStorePath = path.join(root, 'tutorial-store.json');
  fs.writeFileSync(tutorialStorePath, JSON.stringify({
    browserHistory: [{
      id: 'tutorial-history',
      name: '使用教程[AI-FREE]',
      url: 'https://history.example.com/tutorial',
      partition: 'persist:tutorial-history',
      settings: {},
      lastOpenedAt: 10,
    }],
  }));
  const tutorialTabs = new Map();
  let tutorialActiveTabId = null;
  const tutorialLaunches = [];
  const tutorialNavigations = [];
  let tutorialFocusCalls = 0;
  let tutorialSideFocused = false;
  let tutorialSideFocusCalls = 0;
  const tutorialRuntimeManager = {
    store: {
      readProfile(profileId) {
        return profileId === 'browser-tab-tutorial-history'
          ? { profileId, createdAt: '2026-01-01T00:00:00.000Z' }
          : {};
      },
    },
    chromium: { on() {} },
    async launchProfile(profile) {
      tutorialLaunches.push(profile);
      return { status: 'ready' };
    },
    async navigate(profileId, _type, url) { tutorialNavigations.push({ profileId, url }); },
    async show() {},
    async hide() {},
    async focus() { tutorialFocusCalls += 1; },
    async stop() {},
  };
  const tutorialTabManager = createTabManager({
    browserRuntimeManager: tutorialRuntimeManager,
    fs,
    getStorePath: () => tutorialStorePath,
    getTabs: () => tutorialTabs,
    getMainWindow: () => ({ isDestroyed: () => false, getContentSize: () => [1200, 800], emit() {} }),
    getSideView: () => ({
      webContents: {
        isDestroyed: () => false,
        isFocused: () => tutorialSideFocused,
        focus: () => {
          tutorialSideFocused = true;
          tutorialSideFocusCalls += 1;
        },
      },
    }),
    getActiveTabId: () => tutorialActiveTabId,
    setActiveTabId: (tabId) => { tutorialActiveTabId = tabId; },
    getIsSidebarVisible: () => true,
    updateTabs() {},
    sendToSide() {},
    logger: { warn() {}, error() {} },
  });
  const [firstTutorialId, duplicateTutorialId] = await Promise.all([
    tutorialTabManager.openTutorialTab('https://server.example.com/tutorial', {
      auto: true,
      focusBrowser: false,
      restoreSideFocus: true,
    }),
    tutorialTabManager.openTutorialTab('https://server.example.com/tutorial', {
      focusBrowser: false,
      restoreSideFocus: true,
    }),
  ]);
  assert.equal(firstTutorialId, duplicateTutorialId);
  assert.equal(tutorialTabs.size, 1);
  assert.equal(tutorialLaunches.length, 1);
  assert.equal(tutorialLaunches[0].profileId, 'browser-tab-tutorial-history');
  assert.equal(tutorialLaunches[0].initialUrl, 'https://server.example.com/tutorial');
  assert.equal(tutorialLaunches[0].restoreLastSession, false);
  assert.equal(tutorialTabs.get(firstTutorialId).browserHistoryId, 'tutorial-history');
  assert.equal(tutorialTabs.get(firstTutorialId).isTutorialTab, true);
  assert.equal(tutorialFocusCalls, 0);
  assert.ok(tutorialSideFocusCalls >= 1);
  const reopenedTutorialId = await tutorialTabManager.openTutorialTab(
    'https://server.example.com/tutorial-v2',
    { focusBrowser: false },
  );
  assert.equal(reopenedTutorialId, firstTutorialId);
  assert.deepEqual(tutorialNavigations.at(-1), {
    profileId: firstTutorialId,
    url: 'https://server.example.com/tutorial-v2',
  });
  assert.equal(tutorialFocusCalls, 0);
  tutorialTabManager.switchTab(firstTutorialId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tutorialFocusCalls, 0, '切换/显示浏览器不得默认抢走侧栏键盘焦点');
  tutorialTabManager.switchTab(firstTutorialId, { focusBrowser: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tutorialFocusCalls, 1);

  const minimumTabs = new Map([['last-browser', {
    id: 'last-browser',
    runtimeType: 'chromium',
    runtimeStatus: 'ready',
  }]]);
  let minimumActiveTabId = 'last-browser';
  const minimumLaunches = [];
  const minimumStops = [];
  const minimumTabManager = createTabManager({
    browserRuntimeManager: {
      store: { readProfile: () => ({}) },
      chromium: { on() {} },
      async launchProfile(profile) {
        minimumLaunches.push(profile);
        return { status: 'ready' };
      },
      async show() {},
      async hide() {},
      async stop(profileId) { minimumStops.push(profileId); },
    },
    fs,
    getStorePath: () => path.join(root, 'minimum-browser-store.json'),
    getTabs: () => minimumTabs,
    getMainWindow: () => ({
      isDestroyed: () => false,
      getContentSize: () => [1200, 800],
      emit() {},
    }),
    getActiveTabId: () => minimumActiveTabId,
    setActiveTabId: (tabId) => { minimumActiveTabId = tabId; },
    getIsSidebarVisible: () => true,
    updateTabs() {},
    sendToSide() {},
    logger: { warn() {}, error() {} },
  });
  await Promise.all([
    minimumTabManager.closeTab('last-browser'),
    minimumTabManager.closeTab('last-browser'),
  ]);
  assert.deepEqual(minimumStops, ['last-browser']);
  assert.equal(minimumTabs.size, 0, '关闭最后一个浏览器后必须显示内置首页');
  assert.equal(minimumActiveTabId, null);
  assert.equal(minimumLaunches.length, 0, '显示内置首页不得启动 Chromium');

  const browserClickHandlers = new Map();
  const browserClickTabs = new Map([['active-browser', {
    id: 'active-browser',
    runtimeType: 'chromium',
    runtimeStatus: 'ready',
  }]]);
  createTabManager({
    browserRuntimeManager: {
      chromium: {
        on(name, handler) { browserClickHandlers.set(name, handler); },
      },
    },
    getTabs: () => browserClickTabs,
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send() {} },
      emit() {},
    }),
    getActiveTabId: () => 'active-browser',
    getIsSidebarVisible: () => true,
    setIsSidebarVisible() {},
    getSideView: () => null,
    updateTabs() {},
    logger: { warn() {}, error() {} },
  });
  assert.equal(browserClickHandlers.has('browser-clicked'), false, '浏览器点击不得注册侧栏回收链路');

  // 网络魔法是应用级覆盖层：开启时接管全部浏览器，关闭时恢复各自代理设置。
  const magicTabs = new Map([
    ['magic-selected', {
      id: 'magic-selected',
      browserSettings: { proxy: { mode: 'default' } },
    }],
    ['magic-custom', {
      id: 'magic-custom',
      browserSettings: { proxy: { mode: 'custom', protocol: 'http', host: '10.0.0.2', port: 8888 } },
    }],
  ]);
  const magicInstances = new Map(Array.from(magicTabs.keys()).map((id) => [id, { profile: {} }]));
  let magicProfileLookups = 0;
  const magicRestarts = [];
  const magicManager = createTabManager({
    browserRuntimeManager: {
      chromium: { instances: magicInstances, on() {} },
      async restart(id) {
        magicRestarts.push({ id, proxyServer: magicInstances.get(id).profile.proxyServer });
        return { status: 'ready' };
      },
    },
    getTabs: () => magicTabs,
    updateTabs() {},
    resolveTabBrowserProfile: async () => { magicProfileLookups += 1; },
    logger: { warn() {}, error() {} },
  });
  const magicEnabled = await magicManager.applyClashMiniBrowserProxy(true);
  assert.equal(magicEnabled.updated, 2, '开启魔法应更新所有浏览器');
  const magicSelectedProxy = magicInstances.get('magic-selected').profile.proxyServer;
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(magicSelectedProxy));
  assert.equal(magicInstances.get('magic-custom').profile.proxyServer, magicSelectedProxy, '自定义代理浏览器也应被全局魔法临时接管');
  assert.equal(magicProfileLookups, 0, '代理切换不得触发出口 IP Profile 探测');
  const magicDisabled = await magicManager.applyClashMiniBrowserProxy(false);
  assert.equal(magicDisabled.updated, 2);
  assert.equal(magicInstances.get('magic-selected').profile.proxyServer, '');
  assert.equal(magicInstances.get('magic-custom').profile.proxyServer, 'http://10.0.0.2:8888');
  assert.deepEqual(
    magicRestarts.map((item) => item.id),
    ['magic-selected', 'magic-custom', 'magic-selected', 'magic-custom'],
  );
  assert.deepEqual(
    magicRestarts.map((item) => item.proxyServer),
    [magicSelectedProxy, magicSelectedProxy, '', 'http://10.0.0.2:8888'],
  );
  console.log('browser runtime checks passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
