const path = require('path');
const { ChromiumRuntime } = require('./chromium-runtime');
const { ChromiumWindowBridge } = require('./chromium-window-bridge');
const { ProfileRuntimeStore } = require('./profile-runtime-store');
const { cleanupLocalModels } = require('./chromium-local-model-policy');
const { RUNTIME_TYPES } = require('./runtime-types');
const { selectRuntimeFilesByProcessId } = require('./runtime-file-selection');

class BrowserRuntimeManager {
  constructor(options = {}) {
    const userDataDir = options.userDataDir;
    this.logger = options.logger || console;
    this.sandboxDir = options.sandboxDir ? path.resolve(String(options.sandboxDir)) : '';
    this.store = options.store || new ProfileRuntimeStore({
      rootDir: path.join(userDataDir, 'chromium-profiles'),
      downloadsDir: this.sandboxDir,
      logger: this.logger,
    });
    this.localModelCleanup = cleanupLocalModels(this.store.rootDir, this.logger);
    this.windowBridge = options.windowBridge || new ChromiumWindowBridge({
      logger: this.logger,
      resourcesPath: options.resourcesPath,
    });
    this.chromium = options.chromiumRuntime || new ChromiumRuntime({
      logger: this.logger,
      store: this.store,
      windowBridge: this.windowBridge,
      getParentWindow: options.getParentWindow,
      resourcesPath: options.resourcesPath,
      chromiumLogPath: options.chromiumLogPath || path.join(userDataDir, 'logs', 'chromium-runtime.log'),
      chromiumDiagnosticDir: options.chromiumDiagnosticDir || path.join(userDataDir, 'diagnostics'),
      chromiumUserDataDir: userDataDir,
      appVersion: options.appVersion,
    });
  }

  resolveType(profile = {}) {
    // 网页窗口统一使用项目内置的 AI-FREE Chromium Fork。Electron 只承载
    // 应用外壳与侧栏，不能再被选作网页浏览运行时。
    return RUNTIME_TYPES.CHROMIUM;
  }
  runtimeFor(_type) { return this.chromium; }
  async launchProfile(profile, bounds) { return this.runtimeFor(this.resolveType(profile)).launchProfile(profile, bounds); }
  async show(profileId, type) { return this.runtimeFor(type).show(profileId); }
  async hide(profileId, type) { return this.runtimeFor(type).hide(profileId); }
  async resize(profileId, type, bounds) { return this.runtimeFor(type).resize(profileId, bounds); }
  async focus(profileId, type) { return this.runtimeFor(type).focus(profileId); }
  releaseFocus(profileId, type) { return this.runtimeFor(type).releaseFocus(profileId); }
  async reload(profileId, type) { return this.runtimeFor(type).reload(profileId); }
  async navigate(profileId, type, url) { return this.runtimeFor(type).navigate?.(profileId, url); }
  async openTabs(profileId, type, urls) { return this.runtimeFor(type).openTabs?.(profileId, urls); }
  async dispatchInput(profileId, input) { return this.chromium.dispatchInput(profileId, input); }
  async dispatchInputByProcessId(processId, input) {
    return this.chromium.dispatchInputByProcessId(processId, input);
  }
  async dispatchAutomationByProcessId(processId, command, input) {
    return this.chromium.dispatchAutomationByProcessId(processId, command, input);
  }
  async selectFilesByProcessId(processId, selection) {
    return selectRuntimeFilesByProcessId(this.chromium, processId, selection, { sandboxDir: this.sandboxDir });
  }
  async importSession(profileId, sessionData) { return this.chromium.importSession(profileId, sessionData); }
  async setCookies(profileId, cookies) { return this.chromium.setCookies(profileId, cookies); }
  async restart(profileId, options) { return this.chromium.restart(profileId, options); }
  async clearData(profileId) { return this.chromium.clearData(profileId); }
  async stop(profileId, type, options) { return this.runtimeFor(type).stop(profileId, options); }
  async stopAll(options) { return this.chromium.stopAll(options); }
  getState(profileId) { return this.store.getState(profileId); }
  listStates() { return this.store.listStates(); }
  isManagedBrowserProcess(processId) {
    const pid = Number(processId || 0) || 0;
    if (!pid) return false;
    for (const instance of this.chromium.instances.values()) {
      if (Number(instance?.child?.pid || 0) === pid && instance.child.exitCode === null) {
        return true;
      }
    }
    return false;
  }
  deleteProfile(profileId) { return this.store.deleteProfile(profileId); }
  async deleteProfileAsync(profileId) {
    if (typeof this.store.deleteProfileAsync === 'function') {
      return this.store.deleteProfileAsync(profileId);
    }
    return this.store.deleteProfile(profileId);
  }
  async waitForLocalModelCleanup() { return this.localModelCleanup; }
  isChromiumAvailable() { return this.windowBridge.isAvailable(); }
}

function createBrowserRuntimeManager(options) { return new BrowserRuntimeManager(options); }

module.exports = { BrowserRuntimeManager, createBrowserRuntimeManager, RUNTIME_TYPES };
