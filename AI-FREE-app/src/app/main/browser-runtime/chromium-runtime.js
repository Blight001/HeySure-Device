const crypto = require('crypto');
const { BrowserRuntime } = require('./browser-runtime');
const { ChromiumCommandClient, createPipeName } = require('./chromium-command-client');
const { ChromiumHealthMonitor } = require('./chromium-health');
const { launchChromium } = require('./chromium-launcher');
const { prepareSessionImport } = require('./session-import');
const { assertActiveChromiumLaunch, normalizeBounds, RUNTIME_STATUS, RUNTIME_TYPES } = require('./runtime-types');
const { cleanupFailedChromiumLaunch, stopChromiumProfile } = require('./chromium-runtime-process');
const { bindChromiumProcessFailure } = require('./chromium-process-diagnostics');
const { snapshotAppliedChromiumProfile } = require('./chromium-profile-snapshot');
const { attachChildWindowWithRetry } = require('./chromium-window-attachment');
const { groupCookiesByOrigin } = require('./chromium-cookie-groups');
const { dispatchRuntimeInput, dispatchRuntimeInputByProcessId } = require('./runtime-input');
const { dispatchRuntimeAutomationByProcessId } = require('./runtime-automation');
const { openChromiumTabs } = require('./chromium-tab-actions');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ChromiumRuntime extends BrowserRuntime {
  constructor(options = {}) {
    super(options);
    this.store = options.store;
    this.windowBridge = options.windowBridge;
    this.getParentWindow = options.getParentWindow;
    this.launchOptions = { resourcesPath: options.resourcesPath, chromiumLogPath: options.chromiumLogPath, chromiumDiagnosticDir: options.chromiumDiagnosticDir, chromiumUserDataDir: options.chromiumUserDataDir, appVersion: options.appVersion };
    this.instances = new Map();
    // 同一 Profile 的重启、导航、会话注入和刷新必须排队，避免误判运行状态。
    this.profileOperationQueues = new Map();
  }

  enqueueProfileOperation(profileId, operation) {
    const id = String(profileId || '').trim();
    const previous = this.profileOperationQueues.get(id) || Promise.resolve();
    const queued = previous.catch(() => {}).then(operation);
    let tracked = null;
    tracked = queued.finally(() => {
      if (this.profileOperationQueues.get(id) === tracked) {
        this.profileOperationQueues.delete(id);
      }
    });
    this.profileOperationQueues.set(id, tracked);
    return tracked;
  }

  /** @param {Record<string, any>} [rawProfile] */
  async launchProfile(rawProfile = {}, rawBounds = {}) {
    const profileId = String(rawProfile.profileId || rawProfile.id || '').trim();
    if (!profileId) throw new Error('缺少 Profile ID');
    if (this.isProfileVisible(profileId)) {
      await this.resize(profileId, rawBounds);
      await this.show(profileId);
      return this.getState(profileId);
    }
    const context = this.prepareProfileLaunch(profileId, rawProfile, rawBounds);
    try {
      const instance = await this.createProfileInstance(context);
      await this.completeProfileLaunch(profileId, instance, context.bounds);
      return this.getState(profileId);
    } catch (error) {
      const state = this.store.getState(profileId);
      const stopOwnsCleanup = error?.code === 'CHROMIUM_LAUNCH_CANCELLED'
        && [RUNTIME_STATUS.STOPPING, RUNTIME_STATUS.STOPPED].includes(state?.status);
      if (!stopOwnsCleanup) {
        await cleanupFailedChromiumLaunch(this, profileId, {
          hostHwnd: context.hostHwnd,
          commandClient: context.commandClient,
          error,
        });
      }
      throw error;
    }
  }

  isProfileVisible(profileId) {
    return ['ready', 'hidden'].includes(this.store.getState(profileId)?.status);
  }

  prepareProfileLaunch(profileId, rawProfile, rawBounds) {
    const existing = this.instances.get(profileId);
    if (existing?.child?.exitCode === null) {
      const error = /** @type {Error & {code?: string}} */ (new Error(`Chromium Profile ${profileId} 仍在运行`));
      error.code = 'CHROMIUM_PROFILE_ALREADY_RUNNING';
      throw error;
    }
    const bounds = normalizeBounds(rawBounds);
    const paths = this.store.ensureProfile({ ...rawProfile, profileId, runtimeType: RUNTIME_TYPES.CHROMIUM });
    const runtimeProfileId = String(paths.id || '').trim();
    this.store.acquireLock(profileId, { runtimeType: RUNTIME_TYPES.CHROMIUM });
    this.store.createState(profileId, RUNTIME_TYPES.CHROMIUM, { bounds, status: RUNTIME_STATUS.STARTING, startedAt: Date.now() });
    return {
      profileId,
      profile: { ...rawProfile, profileId },
      paths,
      runtimeProfileId,
      bounds,
      hostHwnd: null,
      commandClient: null,
    };
  }

  async createProfileInstance(context) {
    const parentWindow = this.getParentWindow?.();
    if (!parentWindow || parentWindow.isDestroyed?.()) throw new Error('Electron 主窗口不可用');
    const hostHwnd = this.windowBridge.createHostWindow({
      parentHwnd: parentWindow.getNativeWindowHandle(),
      ...context.bounds,
    });
    context.hostHwnd = hostHwnd;
    this.windowBridge.hideHostWindow(hostHwnd);
    const pipeName = createPipeName(context.profileId);
    const launchToken = crypto.randomBytes(32).toString('hex');
    const commandClient = new ChromiumCommandClient({
      profileId: context.runtimeProfileId, pipeName, launchToken, logger: this.logger,
    });
    context.commandClient = commandClient;
    await commandClient.listen();
    this.store.transition(context.profileId, RUNTIME_STATUS.WAITING_PIPE, { hostHwnd, pipeName });
    const launched = launchChromium({
      ...context,
      hostHwnd,
      pipeName,
      launchToken,
      ...this.launchOptions,
      executablePath: context.profile.executablePath,
      logger: this.logger,
    });
    const instance = this.recordProfileInstance(context, parentWindow, commandClient, launched);
    this.bindInstance(context.profileId, instance);
    return instance;
  }

  recordProfileInstance(context, parentWindow, commandClient, launched) {
    const { child } = launched;
    commandClient.setExpectedPid(child.pid);
    const instance = {
      profile: context.profile,
      appliedProfile: snapshotAppliedChromiumProfile(context.profile, launched.args),
      paths: context.paths,
      child,
      commandClient,
      hostHwnd: context.hostHwnd,
      parentWindow,
      runtimeProfileId: context.runtimeProfileId,
      expectedExit: false,
      launchFailure: null,
      diagnostics: launched.diagnostics,
      monitor: null,
      parentFocusHandler: null,
      parentFocusRaiseTimers: new Set(),
    };
    this.instances.set(context.profileId, instance);
    this.store.patchState(context.profileId, { pid: child.pid });
    return instance;
  }

  async completeProfileLaunch(profileId, instance, bounds) {
    const browserHwnd = await this.waitForBrowserWindow(profileId, instance);
    assertActiveChromiumLaunch(this.instances.get(String(profileId)) === instance, this.store.getState(profileId)?.status);
    this.assertCompleteHandshake(profileId, browserHwnd);
    await this.attachProfileWindow(profileId, instance, browserHwnd, bounds);
    instance.monitor = new ChromiumHealthMonitor({
      isWindowAlive: (hwnd) => this.windowBridge.isWindowAlive(hwnd),
      onFailure: (error) => this.markCrashed(profileId, error),
    });
    instance.monitor.start(() => this.store.getState(profileId));
    this.bindParentWindowFocus(profileId, instance);
    this.emit('state-changed', this.getState(profileId));
  }

  assertCompleteHandshake(profileId, browserHwnd) {
    const prototypeMode = String(process.env.AI_FREE_CHROMIUM_HANDSHAKE || '').toLowerCase() === 'prototype';
    const state = this.store.getState(profileId);
    if (prototypeMode || (state?.bridgeConnected && state?.sessionId && browserHwnd)) return;
    const error = /** @type {Error & {code?: string}} */ (new Error('AI-FREE Chromium Fork 握手状态不完整'));
    error.code = 'CHROMIUM_HANDSHAKE_INCOMPLETE';
    throw error;
  }

  async attachProfileWindow(profileId, instance, browserHwnd, bounds) {
    assertActiveChromiumLaunch(this.instances.get(String(profileId)) === instance, this.store.getState(profileId)?.status);
    this.store.transition(profileId, RUNTIME_STATUS.ATTACHING, { browserHwnd });
    const attached = await attachChildWindowWithRetry(this.windowBridge, {
      hostHwnd: instance.hostHwnd,
      childHwnd: browserHwnd,
      childPid: instance.child.pid,
      title: 'AI-FREE',
    }, { logger: this.logger });
    if (!attached) {
      const error = /** @type {Error & {code?: string}} */ (new Error('外部浏览器未能嵌入 AI-FREE 软件窗口'));
      error.code = 'CHROMIUM_HWND_ATTACH_FAILED';
      throw error;
    }
    this.windowBridge.setChildWindowTitle(browserHwnd, 'AI-FREE');
    this.windowBridge.setHostBounds(instance.hostHwnd, bounds);
    this.windowBridge.showHostWindow(instance.hostHwnd);
    this.store.transition(profileId, RUNTIME_STATUS.READY, {
      productName: 'AI-FREE', embedded: true, lastHeartbeatAt: Date.now(),
    });
  }

  bindInstance(profileId, instance) {
    instance.commandClient.on('hello', (message) => {
      this.store.patchState(profileId, { bridgeConnected: true, sessionId: message.sessionId, lastHeartbeatAt: Date.now() });
    });
    instance.commandClient.on('heartbeat', () => this.store.patchState(profileId, { lastHeartbeatAt: Date.now() }));
    // Keep the transport-only ASCII ID out of application-facing runtime events.
    instance.commandClient.on('event', (message) => this.emit('runtime-event', { ...message, profileId }));
    bindChromiumProcessFailure(instance, (error) => this.markCrashed(profileId, error));
  }

  bindParentWindowFocus(profileId, instance) {
    const parentWindow = instance?.parentWindow;
    if (!parentWindow?.on || instance.parentFocusHandler) return;
    if (!(instance.parentFocusRaiseTimers instanceof Set)) {
      instance.parentFocusRaiseTimers = new Set();
    }
    const raiseEmbeddedHost = () => {
        const state = this.store.getState(profileId);
        if (state?.status !== RUNTIME_STATUS.READY || !state.hostHwnd) return;
        try {
          // This only repairs sibling Z-order. It deliberately avoids bounds
          // changes, redraws and activation, so Chromium keeps its current
          // pixels and keyboard focus without flashing.
          this.windowBridge.raiseHostWindow(state.hostHwnd);
        } catch (error) {
          this.logger?.warn?.(`[ChromiumRuntime] 恢复嵌入窗口 Z-order 失败: ${error.message}`);
        }
    };
    const restoreEmbeddedHostZOrder = () => {
      this.clearParentFocusRaiseTimers(instance);
      // Electron can raise its renderer sibling once more during the first
      // compositor/layout frames after a background -> foreground switch.
      // Raise Chromium immediately for the first click, then reassert only
      // Z-order at two bounded checkpoints after Electron has settled.
      raiseEmbeddedHost();
      for (const delayMs of [32, 160]) {
        const timer = setTimeout(() => {
          instance.parentFocusRaiseTimers?.delete(timer);
          raiseEmbeddedHost();
        }, delayMs);
        timer.unref?.();
        instance.parentFocusRaiseTimers.add(timer);
      }
    };
    instance.parentFocusHandler = restoreEmbeddedHostZOrder;
    parentWindow.on('focus', restoreEmbeddedHostZOrder);
  }

  clearParentFocusRaiseTimers(instance) {
    if (!instance?.parentFocusRaiseTimers) return;
    for (const timer of instance.parentFocusRaiseTimers) clearTimeout(timer);
    instance.parentFocusRaiseTimers.clear();
  }

  unbindParentWindowFocus(instance) {
    if (!instance?.parentFocusHandler) return;
    try { instance.parentWindow?.off?.('focus', instance.parentFocusHandler); } catch (_) {}
    instance.parentFocusHandler = null;
    this.clearParentFocusRaiseTimers(instance);
  }

  async waitForBrowserWindow(profileId, instance) {
    const allowPrototype = String(process.env.AI_FREE_CHROMIUM_HANDSHAKE || '').toLowerCase() === 'prototype';
    const timeoutMs = Math.max(3000, Number(instance.profile.launchTimeoutMs) || 30000);
    let helloWindow = String(instance.commandClient.lastHello?.browserHwnd || '');
    instance.commandClient.once('hello', (message) => { helloWindow = String(message.browserHwnd || ''); });
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (instance.launchFailure) throw instance.launchFailure;
      assertActiveChromiumLaunch(this.instances.get(String(profileId)) === instance, this.store.getState(profileId)?.status);
      if (helloWindow) return helloWindow;
      if (allowPrototype) {
        const found = this.windowBridge.findMainWindowByProcessId(instance.child.pid);
        if (found) return found;
      }
      if (instance.child.exitCode !== null) throw new Error('Chromium 在创建窗口前退出');
      await delay(100);
    }
    /** @type {Error & {code?: string}} */
    const error = new Error(allowPrototype ? '等待 Chromium 主窗口超时' : '等待 Chromium Fork 命名管道握手超时');
    error.code = 'CHROMIUM_WINDOW_TIMEOUT';
    throw error;
  }

  async attach(profileId) { return this.getState(profileId); }
  async show(profileId) {
    const state = this.store.getState(profileId);
    if (!state?.hostHwnd) return state;
    this.windowBridge.setHostBounds(state.hostHwnd, state.bounds);
    this.windowBridge.showHostWindow(state.hostHwnd);
    if (state.status === RUNTIME_STATUS.HIDDEN) this.store.transition(profileId, RUNTIME_STATUS.READY);
    return this.getState(profileId);
  }
  async hide(profileId) {
    const state = this.store.getState(profileId);
    if (!state?.hostHwnd) return state;
    this.windowBridge.hideHostWindow(state.hostHwnd);
    if (state.status === RUNTIME_STATUS.READY) this.store.transition(profileId, RUNTIME_STATUS.HIDDEN);
    return this.getState(profileId);
  }
  async resize(profileId, rawBounds) {
    const state = this.store.getState(profileId);
    if (!state) return null;
    const bounds = normalizeBounds(rawBounds);
    if (state.hostHwnd) this.windowBridge.setHostBounds(state.hostHwnd, bounds);
    this.store.patchState(profileId, { bounds });
    return this.getState(profileId);
  }
  async focus(profileId) {
    const state = this.store.getState(profileId);
    return state?.browserHwnd ? this.windowBridge.focusChildWindow(state.browserHwnd) : false;
  }
  releaseFocus(profileId) { const state = this.store.getState(profileId); return state?.browserHwnd ? this.windowBridge.releaseChildWindowFocus(state.browserHwnd) : false; }
  async getState(profileId) { const state = this.store.getState(profileId); return state ? { ...state } : null; }
  getReadyInstance(profileId) {
    const id = String(profileId || '').trim();
    const state = this.store.getState(id);
    const instance = this.instances.get(id);
    if (!instance || !state || ![RUNTIME_STATUS.READY, RUNTIME_STATUS.HIDDEN].includes(state.status)) {
      /** @type {Error & {code?: string}} */
      const error = new Error(`Chromium Profile ${id || '<empty>'} 尚未就绪`);
      error.code = 'CHROMIUM_RUNTIME_NOT_READY';
      throw error;
    }
    return instance;
  }

  async reload(profileId) {
    return this.enqueueProfileOperation(profileId, () => this.reloadNow(profileId));
  }

  async reloadNow(profileId) {
    try {
      return await this.getReadyInstance(profileId).commandClient.send('reload');
    } catch (error) {
      if (error?.code !== 'RUNTIME_COMMAND_TIMEOUT') throw error;
      // The reload command has already reached Chromium. Its response is sent
      // only after the page finishes loading, so a slow site can exceed the
      // bridge deadline even though the refresh itself is proceeding normally.
      this.logger?.warn?.(
        `[ChromiumRuntime] reload ${profileId}: 页面仍在加载，忽略 Runtime Bridge 回包超时`,
      );
      return {
        ok: true,
        result: {
          pending: true,
          timedOut: true,
          message: '页面仍在加载',
        },
      };
    }
  }
  async navigate(profileId, url) {
    return this.enqueueProfileOperation(profileId, () => (
      this.getReadyInstance(profileId).commandClient.send('navigate', { url: String(url || '') }, { timeoutMs: 30000 })
    ));
  }

  async openTabs(profileId, urls = []) { return openChromiumTabs(this, profileId, urls); }

  async dispatchInput(profileId, source) { return dispatchRuntimeInput(this, profileId, source); }

  async dispatchInputByProcessId(processId, source) {
    return dispatchRuntimeInputByProcessId(this, processId, source);
  }

  async dispatchAutomationByProcessId(processId, command, source) {
    return dispatchRuntimeAutomationByProcessId(this, processId, command, source);
  }

  async importSession(profileId, rawSession = {}) {
    return this.enqueueProfileOperation(profileId, () => this.importSessionNow(profileId, rawSession));
  }

  async importSessionNow(profileId, rawSession = {}) {
    const instance = this.getReadyInstance(profileId);
    const prepared = prepareSessionImport(rawSession);
    const commandClient = instance.commandClient;
    this.logSkippedSessionData(profileId, prepared);
    const clearResult = await this.clearImportedSession(profileId, commandClient);
    const cookieResult = await this.importPreparedCookies(profileId, commandClient, prepared);
    const storageResults = await this.importPreparedStorage(profileId, commandClient, prepared);
    const navigation = rawSession.navigateAfterImport === false
      ? { result: { skipped: true } }
      : await this.navigateAfterSessionImport(profileId, commandClient, prepared.targetUrl);
    return this.createSessionImportResult(profileId, prepared, clearResult, cookieResult, storageResults, navigation);
  }

  logSkippedSessionData(profileId, prepared) {
    if (prepared.skippedCookies > 0 || prepared.skippedStorageOrigins > 0) {
      this.logger?.warn?.(
        `[ChromiumRuntime] importSession ${profileId}: 跳过与目标站点无关的数据 `
        + `(Cookie ${prepared.skippedCookies} 个, Storage ${prepared.skippedStorageOrigins} 个)`,
      );
    }
  }

  async clearImportedSession(profileId, commandClient) {
    this.logger?.info?.(`[ChromiumRuntime] importSession ${profileId}: clear-session`);
    return commandClient.send('clear-session', {}, { timeoutMs: 30000 });
  }

  async importPreparedCookies(profileId, commandClient, prepared) {
    if (!prepared.cookies.length) return { result: { imported: 0 } };
    this.logger?.info?.(`[ChromiumRuntime] importSession ${profileId}: set-cookies (${prepared.cookies.length})`);
    return commandClient.send('set-cookies', {
      cookies: prepared.cookies,
      targetUrl: prepared.targetUrl,
    }, { timeoutMs: 30000 });
  }

  async importPreparedStorage(profileId, commandClient, prepared) {
    const storageResults = [];
    for (const entry of prepared.browserStorage) {
      this.logger?.info?.(`[ChromiumRuntime] importSession ${profileId}: set-storage ${entry.origin}`);
      storageResults.push(await commandClient.send('set-storage', {
        ...entry,
        targetUrl: prepared.targetUrl,
      }, { timeoutMs: 30000 }));
    }
    return storageResults;
  }

  async navigateAfterSessionImport(profileId, commandClient, targetUrl) {
    this.logger?.info?.(`[ChromiumRuntime] importSession ${profileId}: navigate ${targetUrl}`);
    try {
      return await commandClient.send('navigate', { url: targetUrl }, { timeoutMs: 30000 });
    } catch (error) {
      return this.normalizeImportNavigationError(profileId, error);
    }
  }

  normalizeImportNavigationError(profileId, error) {
    const message = String(error?.message || '');
    const timedOut = ['NAVIGATION_TIMEOUT', 'RUNTIME_COMMAND_TIMEOUT'].includes(error?.code);
    const interrupted = error?.code === 'NAVIGATION_FAILED'
      && (/页面加载失败:\s*-3(?:\s|$)/.test(message) || /ERR_ABORTED/i.test(message));
    if (!timedOut && !interrupted) throw error;
    this.logger?.warn?.(
      interrupted
        ? `[ChromiumRuntime] importSession ${profileId}: 页面导航被站点重定向，保留浏览器并等待最终页面`
        : `[ChromiumRuntime] importSession ${profileId}: 页面加载超过等待时间，保留浏览器并继续加载`,
    );
    return {
      result: {
        pending: true,
        timedOut,
        interrupted,
        message: interrupted ? '页面正在重定向，已保留浏览器窗口' : '页面仍在加载，已保留浏览器窗口',
      },
    };
  }

  createSessionImportResult(profileId, prepared, clearResult, cookieResult, storageResults, navigation) {
    return {
      ok: true,
      profileId: String(profileId),
      targetUrl: prepared.targetUrl,
      cookiesImported: Number(cookieResult?.result?.imported || 0),
      cookiesSkipped: prepared.skippedCookies,
      storageOriginsImported: storageResults.length,
      storageOriginsSkipped: prepared.skippedStorageOrigins,
      storageResults: storageResults.map((item) => item.result || {}),
      clearResult: clearResult.result || {},
      navigation: navigation.result || {},
    };
  }

  async setCookies(profileId, rawCookies = []) {
    return this.enqueueProfileOperation(profileId, () => this.setCookiesNow(profileId, rawCookies));
  }

  async setCookiesNow(profileId, rawCookies = []) {
    const instance = this.getReadyInstance(profileId);
    const groups = groupCookiesByOrigin(rawCookies);
    let imported = 0;
    let skipped = 0;
    for (const [targetUrl, cookies] of groups) {
      const prepared = prepareSessionImport({ targetUrl, cookies });
      skipped += prepared.skippedCookies;
      if (!prepared.cookies.length) continue;
      const response = await instance.commandClient.send('set-cookies', {
        cookies: prepared.cookies,
        targetUrl: prepared.targetUrl,
      }, { timeoutMs: 30000 });
      imported += Number(response?.result?.imported || 0);
    }
    return { ok: true, imported, skipped };
  }

  async restart(profileId, options = {}) {
    return this.enqueueProfileOperation(profileId, () => this.restartNow(profileId, options));
  }

  async clearData(profileId) {
    return this.enqueueProfileOperation(profileId, () => this.clearDataNow(profileId));
  }

  async clearDataNow(profileId) {
    const id = String(profileId);
    const instance = this.instances.get(id);
    const state = this.store.getState(id);
    if (!instance || !state) throw new Error(`Chromium Profile ${id} 不存在`);
    if (typeof this.store.clearBrowserData !== 'function') {
      throw new Error('Chromium Profile 存储不支持清空浏览器数据');
    }
    const profile = {
      ...instance.profile,
      initialUrl: String(instance.profile.initialUrl || instance.profile.restoreFallbackUrl || ''),
      restoreLastSession: false,
    };
    const bounds = { ...state.bounds };
    await this.stop(id, { timeoutMs: 5000, preserveSession: false });
    this.store.clearBrowserData(id);
    return this.launchProfile(profile, bounds);
  }

  async restartNow(profileId, options = {}) {
    const id = String(profileId);
    const instance = this.instances.get(id);
    const state = this.store.getState(id);
    if (!instance || !state) throw new Error(`Chromium Profile ${id} 不存在`);
    const profile = { ...instance.profile };
    const rememberedInitialUrl = String(profile.initialUrl || '');
    const rememberedRestoreLastSession = profile.restoreLastSession === true;
    // 内部重启（插件开关、指纹参数更新）必须只恢复现有会话。若再次把
    // initialUrl 作为命令行参数传给 Chromium，Chrome 会在恢复旧标签后
    // 额外新建同一网址，表现为“记忆页面 + 重复打开”。
    if (options.reopenInitialUrl !== true) {
      profile.initialUrl = '';
      profile.restoreLastSession = true;
    }
    const bounds = { ...state.bounds };
    await this.stop(id, { timeoutMs: 3000 });
    const runtimeState = await this.launchProfile(profile, bounds);
    const restartedInstance = this.instances.get(id);
    if (restartedInstance?.profile) {
      restartedInstance.profile.initialUrl = rememberedInitialUrl;
      restartedInstance.profile.restoreLastSession = rememberedRestoreLastSession;
    }
    return runtimeState;
  }

  async stop(profileId, options = {}) {
    return stopChromiumProfile(this, profileId, options);
  }

  async stopAll(options = {}) { return Promise.all(this.store.listStates().filter((s) => s.runtimeType === RUNTIME_TYPES.CHROMIUM).map((s) => this.stop(s.profileId, options))); }

  markCrashed(profileId, error) {
    const state = this.store.getState(profileId);
    if (!state || [RUNTIME_STATUS.STOPPED, RUNTIME_STATUS.STOPPING, RUNTIME_STATUS.CRASHED].includes(state.status)) return;
    try { this.windowBridge.hideHostWindow(state.hostHwnd); } catch (_) {}
    this.store.patchState(profileId, { status: RUNTIME_STATUS.CRASHED, browserHwnd: null, bridgeConnected: false, embedded: false, lastError: error, crashCount: Number(state.crashCount || 0) + 1 });
    this.emit('crashed', this.getState(profileId));
  }
}

module.exports = { ChromiumRuntime };
