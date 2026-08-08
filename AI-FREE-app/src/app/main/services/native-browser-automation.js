'use strict';

const { NATIVE_BROWSER_TOOL_DEFINITIONS } = require('./native-browser-tool-definitions');

const CONNECTION_PREFIX = 'native:';
const READY_STATUSES = new Set(['ready', 'hidden']);
const RETRYABLE_WAIT_ERRORS = new Set(['INPUT_TARGET_UNAVAILABLE', 'WEB_CONTENTS_UNAVAILABLE']);

function text(value) { return String(value == null ? '' : value).trim(); }

function normalizeToolName(value) {
  return value === 'browser_download' ? 'browser_file' : value;
}

function boundedWaitTimeout(args) {
  return Math.min(120000, Math.max(100, Number(args.timeout_ms ?? args.ms) || 10000));
}

function retryDelay(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(100, timeoutMs)));
}

function waitTimeoutResult(selector, timeoutMs, result = {}) {
  return {
    ...result, success: false, action: 'wait', selector,
    error: `等待元素超时: ${selector}`, errorCode: 'WAIT_TIMEOUT', timeout_ms: timeoutMs,
  };
}

function normalizeUrl(value) {
  const raw = text(value);
  if (!raw) throw new Error('缺少要打开的网址');
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('浏览器导航只支持 HTTP/HTTPS 地址');
  return parsed.href;
}

function tabItems(getTabs) {
  const tabs = typeof getTabs === 'function' ? getTabs() : [];
  return tabs instanceof Map ? Array.from(tabs.values()) : (Array.isArray(tabs) ? tabs : []);
}

function findTab(getTabs, profileId) {
  return tabItems(getTabs).find((tab) => text(tab?.id) === text(profileId)) || null;
}

function publicConnection(state, tab) {
  const profileId = text(state.profileId);
  const name = text(tab?.fixedTitle || tab?.tabTitle || tab?.runtimeTitle || profileId || 'AI-FREE 浏览器');
  return {
    id: `${CONNECTION_PREFIX}${profileId}`,
    instanceId: profileId,
    profileId,
    browserProcessId: Number(state.pid) || 0,
    name,
    platform: 'ai-free-chromium-native',
    version: '1',
    toolCount: NATIVE_BROWSER_TOOL_DEFINITIONS.length,
    capabilities: NATIVE_BROWSER_TOOL_DEFINITIONS.map((tool) => tool.name),
    connectedAt: Number(state.startedAt) || 0,
    lastSeenAt: Number(state.lastHeartbeatAt) || Date.now(),
    online: state.bridgeConnected === true && READY_STATUSES.has(text(state.status)),
  };
}

class NativeBrowserAutomation {
  constructor(options = {}) {
    this.runtime = options.browserRuntimeManager;
    this.getTabs = options.getTabs;
    this.downloadService = options.browserDownloadService;
    this.cardService = options.cardService || null;
    this.observeSelectors = new Map();
  }

  listConnections() {
    const states = this.runtime?.listStates?.() || [];
    return states.filter((state) => (
      state?.bridgeConnected === true && READY_STATUSES.has(text(state.status)) && text(state.profileId)
    )).map((state) => publicConnection(state, findTab(this.getTabs, state.profileId)));
  }

  getConnection(id) {
    const connection = this.listConnections().find((item) => item.id === text(id));
    return connection ? { ...connection, tools: NATIVE_BROWSER_TOOL_DEFINITIONS } : null;
  }

  requireConnection(id) {
    const connection = this.getConnection(id);
    if (connection) return connection;
    const error = /** @type {Error & {errorCode?: string, phase?: string}} */ (
      new Error('所选 AI-FREE Chromium 原生控制连接已离线，请刷新连接列表')
    );
    error.errorCode = 'BROWSER_CONNECTION_NOT_FOUND';
    error.phase = 'native_connection';
    throw error;
  }

  async runtimeCommand(connection, command, input = {}) {
    const response = await this.runtime.dispatchAutomationByProcessId(connection.browserProcessId, command, input);
    return response?.result || response || {};
  }

  async browserTab(connection, args) {
    const action = text(args.action).toLowerCase();
    const profileId = connection.profileId;
    if (action === 'list') return this.runtimeCommand(connection, 'list-tabs');
    if (action === 'switch') {
      const index = Number(args.index ?? args.tab_index ?? args.id ?? args.tab_id);
      const target = {
        url: text(args.url),
        index: Number.isInteger(index) && index >= 0 ? index : -1,
      };
      const switched = target.url || target.index >= 0
        ? await this.runtimeCommand(connection, 'activate-tab', target)
        : (await this.runtimeCommand(connection, 'list-tabs')).activeTab;
      await this.runtime.focus(profileId, 'chromium');
      return { success: true, action, ...switched };
    }
    if (action === 'reload') {
      await this.runtime.reload(profileId, 'chromium');
      return { success: true, action, id: profileId };
    }
    const url = normalizeUrl(args.url);
    if (action === 'replace') await this.runtime.navigate(profileId, 'chromium', url);
    else if (action === 'navigate') await this.runtime.openTabs(profileId, 'chromium', [url]);
    else throw new Error(`browser_tab 不支持的原生操作: ${action || '(空)'}`);
    return { success: true, action, id: profileId, url, cardStep: { name: `打开 ${new URL(url).hostname}`, type: 'navigate', url } };
  }

  async browserAction(connection, args) {
    const input = this.resolveObservedTarget(connection, args);
    if (text(input.action) === 'upload_file') throw new Error('文件上传请使用 browser_file action=upload');
    return this.runtimeCommand(connection, 'perform-action', input);
  }

  async browserUpload(connection, args) {
    const input = this.resolveObservedTarget(connection, { ...args, action: 'upload_file' });
    if (!this.downloadService?.resolveUploadPaths) throw new Error('AI 工作区文件服务不可用');
    const requested = Array.isArray(args.paths) ? args.paths : [args.path].filter(Boolean);
    const paths = this.downloadService.resolveUploadPaths(requested);
    const mode = text(args.mode) || (paths.length > 1 ? 'open-multiple' : 'open');
    const session = text(args.page_url || args.pageUrl)
      ? null
      : await this.runtimeCommand(connection, 'get-session-data', {});
    await this.runtime.selectFilesByProcessId(connection.browserProcessId, {
      pageUrl: text(args.page_url || args.pageUrl || session?.url), paths, mode, ttlMs: 5000,
    });
    return this.runtimeCommand(connection, 'perform-action', input);
  }

  resolveObservedTarget(connection, args) {
    if (text(args.selector) || !text(args.ref)) return args;
    const selector = this.observeSelectors.get(connection.id)?.get(text(args.ref));
    return selector ? { ...args, selector } : args;
  }

  async browserObserve(connection, input) {
    const result = await this.runtimeCommand(connection, 'observe-page', input);
    const selectors = new Map((Array.isArray(result?.items) ? result.items : [])
      .map((item) => [text(item?.id), text(item?.selector)]).filter(([id, selector]) => id && selector));
    this.observeSelectors.set(connection.id, selectors);
    return result;
  }

  async browserWait(connection, args) {
    const input = this.resolveObservedTarget(connection, args);
    const selector = text(input.selector);
    if (selector) {
      const timeoutMs = boundedWaitTimeout(input);
      const deadline = Date.now() + timeoutMs;
      let result = null;
      do {
        const remaining = Math.max(100, deadline - Date.now());
        let retryableFailure = false;
        try {
          result = await this.runtimeCommand(connection, 'perform-action', {
            ...input, selector, action: 'wait', timeout_ms: Math.min(750, remaining),
          });
          retryableFailure = result?.success === false && result?.errorCode === 'WAIT_TIMEOUT';
        } catch (error) {
          if (!RETRYABLE_WAIT_ERRORS.has(String(error?.code || ''))) throw error;
          result = null;
          retryableFailure = true;
        }
        if (!retryableFailure) return result;
        if (Date.now() < deadline) await retryDelay(deadline - Date.now());
      } while (Date.now() < deadline);
      return waitTimeoutResult(selector, timeoutMs, result || {});
    }
    const waitedMs = Math.min(120000, Math.max(0, Number(args.ms) || 1000));
    await new Promise((resolve) => setTimeout(resolve, waitedMs));
    return { success: true, waitedMs, cardStep: { name: `等待 ${waitedMs}ms`, type: 'wait', timeout: waitedMs } };
  }

  async browserFile(connection, args) {
    const action = text(args.action).toLowerCase();
    if (action === 'upload') {
      const result = await this.browserUpload(connection, args);
      return { ...result, action: 'upload' };
    }
    if (!this.downloadService?.execute) throw new Error('AI 工作区下载服务不可用');
    if (action !== 'save_session') return this.downloadService.execute(args);
    const response = await this.runtimeCommand(connection, 'get-session-data', {});
    return this.downloadService.execute({ ...args, session: response?.result || response });
  }

  async dispatch(connectionId, tool, args = {}, options = {}) {
    const connection = this.requireConnection(connectionId);
    const input = args && typeof args === 'object' ? args : {};
    const toolName = normalizeToolName(tool);
    if (toolName === 'browser_observe') return this.browserObserve(connection, input);
    if (toolName === 'browser_screenshot') return this.runtimeCommand(connection, 'capture-screenshot', input);
    if (toolName === 'browser_action') return this.browserAction(connection, input);
    if (toolName === 'browser_wait') return this.browserWait(connection, input);
    if (toolName === 'browser_tab') return this.browserTab(connection, input);
    if (toolName === 'browser_file') return this.browserFile(connection, input);
    if (toolName === 'manage_card' && this.cardService?.execute) {
      return this.cardService.execute(input, {
        timeoutMs: options.timeoutMs,
        dispatch: (nextTool, nextArgs) => this.dispatch(connectionId, nextTool, nextArgs, options),
      });
    }
    throw new Error(`未知的 Chromium 原生自动化工具: ${text(toolName) || '(空)'}`);
  }
}

function createNativeBrowserAutomation(options) { return new NativeBrowserAutomation(options); }

module.exports = { CONNECTION_PREFIX, createNativeBrowserAutomation, normalizeUrl, publicConnection };
