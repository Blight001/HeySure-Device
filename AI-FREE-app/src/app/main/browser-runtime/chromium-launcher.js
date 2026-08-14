const fs = require('fs'); const path = require('path');
const { spawn } = require('child_process');
const { prepareChromiumPreflight } = require('./chromium-launch-preflight');
const { ensureChromiumSandboxAccess } = require('./chromium-sandbox-access');
const { enforceLocalModelDisabled } = require('./chromium-local-model-policy');
const { buildChromiumProfileArgs } = require('./chromium-profile-args');
const { attachChromiumLaunchLogging } = require('./chromium-launch-log');
const { createChromiumPerformanceSpan } = require('./chromium-performance');
const { waitForChromiumPreflightWarmup } = require('./chromium-preflight-warmup');
const { callOptional, firstText } = require('../../shared/safe-values');

const SESSION_FILE_PATTERN = /^(Session|Tabs)_(\d+)$/;

const FORBIDDEN_SWITCHES = new Set([
  '--no-sandbox',
  '--single-process',
  '--disable-web-security',
  '--disable-site-isolation-trials',
  '--allow-running-insecure-content',
]);

const GOOGLE_CREDENTIAL_ENV_MAP = Object.freeze({
  AI_FREE_GOOGLE_API_KEY: 'GOOGLE_API_KEY',
  AI_FREE_GOOGLE_CLIENT_ID: 'GOOGLE_DEFAULT_CLIENT_ID',
  AI_FREE_GOOGLE_CLIENT_SECRET: 'GOOGLE_DEFAULT_CLIENT_SECRET',
});

function text(...values) {
  return firstText(...values).trim();
}

function buildChromiumEnvironment(baseEnv = process.env, overrides = {}) {
  const environment = { ...baseEnv, ...overrides };
  for (const [aiFreeName, chromiumName] of Object.entries(GOOGLE_CREDENTIAL_ENV_MAP)) {
    const chromiumValue = String(environment[chromiumName] || '').trim();
    const aiFreeValue = String(environment[aiFreeName] || '').trim();
    if (!chromiumValue && aiFreeValue) environment[chromiumName] = aiFreeValue;
  }
  return environment;
}

function normalizeExecutableCandidate(value) {
  const candidate = String(value || '').trim().replace(/^"|"$/g, '');
  return candidate ? path.resolve(candidate) : '';
}

function getSystemChromiumCandidates(env = process.env) {
  const programFiles = String(env.ProgramFiles || '').trim();
  const programFilesX86 = String(env['ProgramFiles(x86)'] || '').trim();
  const localAppData = String(env.LOCALAPPDATA || '').trim();
  const joinIfRoot = (root, ...parts) => root ? path.join(root, ...parts) : '';
  return [
    joinIfRoot(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    joinIfRoot(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    joinIfRoot(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    joinIfRoot(programFiles, 'Chromium', 'Application', 'chrome.exe'),
    joinIfRoot(programFilesX86, 'Chromium', 'Application', 'chrome.exe'),
    joinIfRoot(localAppData, 'Chromium', 'Application', 'chrome.exe'),
    joinIfRoot(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    joinIfRoot(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
}

function resolveChromiumExecutable(options = {}) {
  const explicitResourcesPath = String(options.resourcesPath || '').trim();
  const resourcesPath = explicitResourcesPath || process.resourcesPath || '';
  const profile = options.profile || {};
  const prototypeMode = String(process.env.AI_FREE_CHROMIUM_HANDSHAKE || '').trim().toLowerCase() === 'prototype';
  const formalCandidates = [
    resourcesPath && path.join(resourcesPath, 'chromium', 'ai-free-browser.exe'),
    !explicitResourcesPath && (!process.resourcesPath || process.resourcesPath === resourcesPath)
      ? path.join(process.cwd(), 'resources', 'chromium', 'ai-free-browser.exe')
      : '',
  ];
  const candidates = [
    ...formalCandidates,
    ...(prototypeMode ? [
      resourcesPath && path.join(resourcesPath, 'chromium', 'chrome.exe'),
      options.executablePath,
      process.env.AI_FREE_CHROMIUM_PATH,
      ...getSystemChromiumCandidates(),
    ] : []),
  ].map(normalizeExecutableCandidate).filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  const error = /** @type {Error & {code?: string, candidates?: string[]}} */ (new Error(prototypeMode
    ? '未找到可用于原型验证的 Chromium/Chrome/Edge'
    : '未找到打包的 AI-FREE Chromium Fork：resources/chromium/ai-free-browser.exe（正式模式禁止使用系统 Chrome 或外部路径）'));
  error.code = 'CHROMIUM_EXECUTABLE_NOT_FOUND';
  error.candidates = candidates;
  throw error;
}

function assertSafeChromiumArgs(args = []) {
  for (const rawArg of args) {
    const arg = String(rawArg || '').trim().toLowerCase();
    const switchName = arg.split('=')[0];
    if (FORBIDDEN_SWITCHES.has(switchName)) {
      const error = /** @type {Error & {code?: string}} */ (new Error(`禁止使用不安全的 Chromium 参数: ${switchName}`));
      error.code = 'FORBIDDEN_CHROMIUM_SWITCH';
      throw error;
    }
    if (switchName === '--remote-debugging-address' && !/=(127\.0\.0\.1|localhost|::1)$/.test(arg)) {
      const error = /** @type {Error & {code?: string}} */ (new Error('Chromium 调试地址只能绑定回环接口'));
      error.code = 'UNSAFE_DEBUG_ADDRESS';
      throw error;
    }
  }
}

function readChromiumPreferences(preferencesPath, logger) {
  try {
    if (!fs.existsSync(preferencesPath)) return {};
    const value = JSON.parse(fs.readFileSync(preferencesPath, 'utf8') || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    callOptional(logger, 'warn', '[ChromiumRuntime] Preferences 无法解析，保留原文件并跳过会话启动策略:', text(error && error.message, error));
    return null;
  }
}

function ensurePreferenceSection(preferences, key) {
  const current = preferences[key];
  const section = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  preferences[key] = section;
  return section;
}

function acceptedProfileLanguages(profile) {
  return text(profile.acceptLanguage, profile.locale)
    .split(',')
    .map((item) => item.split(';')[0].trim())
    .filter(Boolean)
    .join(',');
}

function writeChromiumPreferences(preferencesPath, preferences, logger) {
  try {
    fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
    fs.writeFileSync(preferencesPath, JSON.stringify(preferences), 'utf8');
    return true;
  } catch (error) {
    callOptional(logger, 'warn', '[ChromiumRuntime] 写入单页启动策略失败:', text(error && error.message, error));
    return false;
  }
}

/** @param {Record<string, any>} [profile] */
function applyChromiumSessionStartupPolicy(paths = {}, logger = console, profile = {}) {
  const userDataDir = text(paths.chromiumData);
  if (!userDataDir) return false;
  const preferencesPath = path.join(userDataDir, 'Default', 'Preferences');
  const preferences = readChromiumPreferences(preferencesPath, logger);
  if (!preferences) return false;
  const session = ensurePreferenceSection(preferences, 'session');
  // 与本次启动意图保持一致。旧逻辑无条件写 5（新标签页），同时又传
  // --restore-last-session，两套策略相互冲突，可能最终得到空白页。
  session.restore_on_startup = profile.restoreLastSession === true ? 1 : 5;
  session.startup_urls = [];
  const profileSection = ensurePreferenceSection(preferences, 'profile');
  profileSection.exit_type = 'Normal';
  profileSection.exited_cleanly = true;
  const acceptedLanguages = acceptedProfileLanguages(profile);
  if (acceptedLanguages) {
    const intl = ensurePreferenceSection(preferences, 'intl');
    intl.accept_languages = acceptedLanguages;
    intl.selected_languages = acceptedLanguages;
  }
  return writeChromiumPreferences(preferencesPath, preferences, logger);
}

function getChromiumSessionsDir(paths = {}) {
  return path.join(String(paths.chromiumData || ''), 'Default', 'Sessions');
}

function sessionFileTimestamp(name) {
  const match = SESSION_FILE_PATTERN.exec(String(name || ''));
  try { return match ? BigInt(match[2]) : 0n; } catch (_) { return 0n; }
}

function containsRestorableWebUrl(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  return buffer.includes(Buffer.from('https://', 'ascii'))
    || buffer.includes(Buffer.from('http://', 'ascii'))
    || buffer.includes(Buffer.from('https://', 'utf16le'))
    || buffer.includes(Buffer.from('http://', 'utf16le'));
}

// Chromium 150 的 Session 文件由 SNSS 头和一串 SessionCommand 组成：
// uint16 commandSize + uint8 commandId + payload。只搜索 URL 会把已经追加
// TabClosed(16) 的旧导航误判成可恢复页面，因此这里按 Chromium 的命令顺序
// 还原“当前仍属于窗口的标签”集合。
function applyChromiumSessionCommand(state, commandId, buffer, offset, payloadSize) {
  if (commandId === 9 && payloadSize >= 4) {
    state.windows.add(buffer.readInt32LE(offset));
    return;
  }
  if (commandId === 0 && payloadSize >= 8) {
    state.tabs.set(buffer.readInt32LE(offset + 4), buffer.readInt32LE(offset));
    return;
  }
  if (commandId === 16 && payloadSize >= 4) {
    state.tabs.delete(buffer.readInt32LE(offset));
    return;
  }
  if (commandId !== 17 || payloadSize < 4) return;
  const windowId = buffer.readInt32LE(offset);
  state.windows.delete(windowId);
  for (const [tabId, tabWindowId] of state.tabs) {
    if (tabWindowId === windowId) state.tabs.delete(tabId);
  }
}

function analyzeChromiumSession(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.subarray(0, 4).toString('ascii') !== 'SNSS') {
    return { valid: false, liveTabCount: 0, hasWebUrl: false };
  }
  const state = { windows: new Set(), tabs: new Map() };
  let offset = 8;
  let valid = true;
  while (offset + 3 <= buffer.length) {
    const commandSize = buffer.readUInt16LE(offset);
    const commandEnd = offset + 2 + commandSize;
    if (commandSize < 1 || commandEnd > buffer.length) {
      valid = false;
      break;
    }
    const commandId = buffer[offset + 2];
    const payloadOffset = offset + 3;
    const payloadSize = commandSize - 1;
    applyChromiumSessionCommand(state, commandId, buffer, payloadOffset, payloadSize);
    offset = commandEnd;
  }
  const liveTabCount = Array.from(state.tabs.values())
    .filter((windowId) => state.windows.has(windowId)).length;
  return {
    valid,
    liveTabCount,
    hasWebUrl: containsRestorableWebUrl(buffer),
  };
}

function hasRestorableSessionBuffer(buffer) {
  const analysis = analyzeChromiumSession(buffer);
  return analysis.valid && analysis.liveTabCount > 0 && analysis.hasWebUrl;
}

function snapshotHasRestorableSession(snapshot) {
  return Boolean(snapshot?.files?.some((file) => (
    String(file?.name || '').startsWith('Session_')
    && hasRestorableSessionBuffer(file.data)
  )));
}

function getStableSessionDir(paths = {}) {
  return path.join(String(paths.root || path.dirname(paths.chromiumData || '')), 'session-recovery-stable');
}

function persistStableChromiumSession(paths = {}, snapshot, logger = console) {
  if (!snapshotHasRestorableSession(snapshot)) return false;
  const stableDir = getStableSessionDir(paths);
  const temporaryDir = `${stableDir}.tmp`;
  try {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
    fs.mkdirSync(temporaryDir, { recursive: true });
    for (const file of snapshot.files) {
      if (SESSION_FILE_PATTERN.test(String(file?.name || '')) && Buffer.isBuffer(file.data)) {
        fs.writeFileSync(path.join(temporaryDir, file.name), file.data);
      }
    }
    fs.rmSync(stableDir, { recursive: true, force: true });
    fs.renameSync(temporaryDir, stableDir);
    return true;
  } catch (error) {
    logger?.warn?.('[ChromiumRuntime] 保存稳定 Session 备份失败:', error?.message || error);
    try { fs.rmSync(temporaryDir, { recursive: true, force: true }); } catch (_) {}
    return false;
  }
}

function loadStableChromiumSession(paths = {}, logger = console) {
  const stableDir = getStableSessionDir(paths);
  try {
    const files = fs.readdirSync(stableDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_FILE_PATTERN.test(entry.name))
      .map((entry) => ({ name: entry.name, data: fs.readFileSync(path.join(stableDir, entry.name)) }));
    const snapshot = { sessionsDir: getChromiumSessionsDir(paths), files };
    return snapshotHasRestorableSession(snapshot) ? snapshot : null;
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.('[ChromiumRuntime] 读取稳定 Session 备份失败:', error?.message || error);
    return null;
  }
}

// 旧版 close-browser 会先关闭最后一个窗口，再正常退出 Chromium，导致最新
// Session 被写成 0 窗口。若上一组 Session 仍包含网页，则隔离空白的最新组，
// 让 Chromium 自动回退读取上一组有效会话。
function readChromiumSessionEntries(sessionsDir) {
  try {
    return fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_FILE_PATTERN.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        path: path.join(sessionsDir, entry.name),
        type: entry.name.startsWith('Session_') ? 'Session' : 'Tabs',
        timestamp: sessionFileTimestamp(entry.name),
      }));
  } catch (_) {
    return [];
  }
}

function entryHasRestorableSession(entry) {
  try {
    return hasRestorableSessionBuffer(fs.readFileSync(entry.path));
  } catch (_) {
    return false;
  }
}

function sessionTimestampDistance(entry, target) {
  return entry.timestamp > target.timestamp
    ? entry.timestamp - target.timestamp
    : target.timestamp - entry.timestamp;
}

function discardBlankSessionFiles(paths, sessionsDir, entries, logger) {
  const recoveryRoot = text(paths.root, path.dirname(paths.chromiumData || sessionsDir));
  const recoveryDir = path.join(recoveryRoot, 'session-recovery-discarded');
  const removed = [];
  try {
    fs.mkdirSync(recoveryDir, { recursive: true });
    for (const entry of entries.filter(Boolean)) {
      fs.renameSync(entry.path, path.join(recoveryDir, `${Date.now()}-${entry.name}`));
      removed.push(entry.name);
    }
    callOptional(logger, 'warn', '[ChromiumRuntime] 已隔离空白的最新 Session，回退到上一组有效网页会话:', removed);
    return { repaired: true, removed };
  } catch (error) {
    callOptional(logger, 'warn', '[ChromiumRuntime] 修复空白 Session 失败:', text(error && error.message, error));
    return { repaired: false, removed };
  }
}

function repairBlankLatestSession(paths = {}, logger = console) {
  const sessionsDir = getChromiumSessionsDir(paths);
  const entries = readChromiumSessionEntries(sessionsDir);
  const sessionEntries = entries.filter((entry) => entry.type === 'Session')
    .sort((left, right) => left.timestamp > right.timestamp ? -1 : 1);
  if (sessionEntries.length < 2) return { repaired: false, removed: [] };
  if (entryHasRestorableSession(sessionEntries[0])) return { repaired: false, removed: [] };
  const previousValid = sessionEntries.slice(1).find(entryHasRestorableSession);
  if (!previousValid) return { repaired: false, removed: [] };
  const latestSession = sessionEntries[0];
  const closestTabs = entries.filter((entry) => entry.type === 'Tabs')
    .sort((left, right) => sessionTimestampDistance(left, latestSession) < sessionTimestampDistance(right, latestSession) ? -1 : 1)[0];
  return discardBlankSessionFiles(paths, sessionsDir, [latestSession, closestTabs], logger);
}

function captureChromiumSessionFiles(paths = {}, logger = console) {
  const sessionsDir = getChromiumSessionsDir(paths);
  try {
    const files = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_FILE_PATTERN.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        data: fs.readFileSync(path.join(sessionsDir, entry.name)),
      }));
    return files.length ? { sessionsDir, files } : null;
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.('[ChromiumRuntime] 捕获 Session 快照失败:', error?.message || error);
    return null;
  }
}

function prepareChromiumSessionRecovery(paths = {}, logger = console) {
  repairBlankLatestSession(paths, logger);
  let snapshot = captureChromiumSessionFiles(paths, logger);
  if (snapshotHasRestorableSession(snapshot)) {
    persistStableChromiumSession(paths, snapshot, logger);
    return { restorable: true, source: 'profile' };
  }
  snapshot = loadStableChromiumSession(paths, logger);
  if (snapshot && restoreChromiumSessionFiles(snapshot, logger)) {
    logger?.warn?.('[ChromiumRuntime] 当前 Session 无活动标签，已恢复启动前的稳定备份');
    return { restorable: true, source: 'stable-backup' };
  }
  return { restorable: false, source: 'none' };
}

function restoreChromiumSessionFiles(snapshot, logger = console) {
  if (!snapshot?.sessionsDir || !Array.isArray(snapshot.files) || snapshot.files.length === 0) return false;
  try {
    fs.mkdirSync(snapshot.sessionsDir, { recursive: true });
    for (const entry of fs.readdirSync(snapshot.sessionsDir, { withFileTypes: true })) {
      if (entry.isFile() && SESSION_FILE_PATTERN.test(entry.name)) {
        fs.rmSync(path.join(snapshot.sessionsDir, entry.name), { force: true });
      }
    }
    for (const file of snapshot.files) {
      const target = path.join(snapshot.sessionsDir, file.name);
      const temporary = `${target}.ai-free-tmp`;
      fs.writeFileSync(temporary, file.data);
      fs.renameSync(temporary, target);
    }
    return true;
  } catch (error) {
    logger?.warn?.('[ChromiumRuntime] 恢复退出前 Session 快照失败:', error?.message || error);
    return false;
  }
}

function buildChromiumArgs(options = {}) {
  const profile = options.profile || {};
  const paths = options.paths || {};
  const bounds = options.bounds || {};
  const runtimeProfileId = String(options.runtimeProfileId || profile.profileId || '').trim();
  const args = [
    `--user-data-dir=${paths.chromiumData}`,
    `--download-default-directory=${paths.downloads}`,
    `--hs-profile-id=${runtimeProfileId}`,
    `--hs-runtime-pipe=${options.pipeName}`,
    `--hs-runtime-token=${options.launchToken}`,
    '--hs-embed-mode=child-window',
    '--no-first-run',
    '--no-default-browser-check',
    // The embedded runtime is updated by AI-FREE itself. Chromium's own
    // component/model updater can otherwise download hundreds of megabytes
    // through the currently selected proxy while every page is idle.
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-session-crashed-bubble',
  ];
  if (profile.lowSpecMode !== true) args.push('--disable-backgrounding-occluded-windows');
  args.push(...buildChromiumProfileArgs(options, profile, bounds));
  args.push(...(Array.isArray(profile.extraArgs) ? profile.extraArgs : []));
  const modelSafeArgs = enforceLocalModelDisabled(args);
  modelSafeArgs.push('--enable-logging=stderr');
  // Chromium 在握手完成前还是独立顶层窗口。强制放到虚拟屏幕外，且放在
  // 自定义参数之后，避免用户参数覆盖；嵌入后 native host 会重新定位。
  modelSafeArgs.push('--window-position=-32000,-32000');
  if (profile.initialUrl) modelSafeArgs.push(String(profile.initialUrl));
  assertSafeChromiumArgs(modelSafeArgs);
  return modelSafeArgs;
}

function resolveChromiumLaunchOptions(options) {
  const profile = options.profile && typeof options.profile === 'object' ? options.profile : {};
  if (profile.restoreLastSession !== true) return options;
  const recovery = prepareChromiumSessionRecovery(options.paths, options.logger);
  const fallbackUrl = text(profile.restoreFallbackUrl);
  if (recovery.restorable || !/^https?:\/\//i.test(fallbackUrl)) return options;
  callOptional(options.logger, 'warn', '[ChromiumRuntime] 未找到可恢复的活动标签，回退打开浏览器记录网址:', fallbackUrl);
  return {
    ...options,
    profile: { ...profile, initialUrl: fallbackUrl, restoreLastSession: false },
  };
}

function chromiumSpawnEnvironment(options) {
  const profile = options.profile && typeof options.profile === 'object' ? options.profile : {};
  const overrides = { ...(options.env || {}) };
  if (profile.timezoneId) overrides.TZ = String(profile.timezoneId);
  return buildChromiumEnvironment(process.env, overrides);
}

async function launchChromium(options = {}) {
  const span = createChromiumPerformanceSpan(options.logger, 'process-launch');
  try {
    const executablePath = resolveChromiumExecutable(options); span.mark('resolveExecutable');
    await waitForChromiumPreflightWarmup(executablePath); span.mark('preflightWarmupWait');
    const profileRoot = String(options.paths?.root || '').trim();
    const cacheFile = profileRoot
      ? path.join(path.dirname(profileRoot), '.chromium-sandbox-access.json')
      : '';
    const sandboxAccess = ensureChromiumSandboxAccess(executablePath, options.logger, { cacheFile });
    span.mark('sandboxAccess');
    const preflight = prepareChromiumPreflight(options, executablePath, sandboxAccess);
    span.mark('preflight');
    const launchOptions = resolveChromiumLaunchOptions(options);
    applyChromiumSessionStartupPolicy(launchOptions.paths, launchOptions.logger, launchOptions.profile); span.mark('sessionPolicy');
    const args = buildChromiumArgs(launchOptions); span.mark('arguments');
    const child = spawn(executablePath, args, {
      cwd: path.dirname(executablePath),
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: chromiumSpawnEnvironment(options),
    });
    span.mark('spawn');
    const diagnostics = attachChromiumLaunchLogging({
      child, executablePath, args, logger: options.logger,
      logFilePath: options.chromiumLogPath,
      diagnosticDir: options.chromiumDiagnosticDir,
      userDataDir: options.chromiumUserDataDir,
      appVersion: options.appVersion,
      sandboxAccess,
      preflight,
      forwardOutput: forwardChromiumOutput,
      shouldIgnore: shouldIgnoreChromiumDiagnostic,
    });
    span.mark('diagnostics');
    span.finish();
    return { child, executablePath, args, diagnostics };
  } catch (error) {
    span.fail(error);
    throw error;
  }
}

// Windows 未安装特定 Winsock 服务提供程序时 Chromium 会反复输出该诊断，
// 但它不会影响 DNS、页面加载或 Runtime Bridge，避免将它淹没有效日志。
function shouldIgnoreChromiumDiagnostic(line) {
  return /WSALookupServiceBegin failed with:\s*10108\b/.test(String(line || ''));
}

/**
 * @param {any} stream
 * @param {(text: string) => void} emit
 * @param {(text: string) => boolean} [shouldIgnore]
 */
function forwardChromiumOutput(stream, emit, shouldIgnore = () => false) {
  if (!stream || typeof stream.on !== 'function') return;
  let pending = '';

  const flushLine = (line) => {
    const text = String(line || '').trimEnd();
    if (!text || shouldIgnore(text)) return;
    emit(text);
  };

  stream.on('data', (chunk) => {
    pending += String(chunk || '');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) flushLine(line);
  });
  stream.on('end', () => {
    flushLine(pending);
    pending = '';
  });
}

module.exports = {
  FORBIDDEN_SWITCHES,
  applyChromiumSessionStartupPolicy,
  assertSafeChromiumArgs,
  buildChromiumArgs,
  buildChromiumEnvironment,
  captureChromiumSessionFiles,
  ensureChromiumSandboxAccess,
  forwardChromiumOutput,
  getSystemChromiumCandidates,
  launchChromium,
  loadStableChromiumSession,
  persistStableChromiumSession,
  prepareChromiumSessionRecovery,
  resolveChromiumExecutable,
  repairBlankLatestSession,
  restoreChromiumSessionFiles,
  snapshotHasRestorableSession,
  shouldIgnoreChromiumDiagnostic,
};
