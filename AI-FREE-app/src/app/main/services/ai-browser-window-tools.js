// 软件端 AI 默认自带的"外层"浏览器窗口控制工具。
//
// 与 Chromium 原生页面工具配合，这组工具负责软件外层的浏览器窗口生命周期，
// 始终注入 AI 控制对话，直接操作软件自身的独立浏览器窗口：
// 通过 windows_tab 的 action 子选项列出、打开、新建、编辑和关闭栏目。
// 底层复用 ipc/register/settings 的浏览器历史（browserHistory）读写逻辑，
// 保证 AI 操作与设置页/标签栏手工操作看到的是同一份数据。

const {
  DEFAULT_BROWSER_WINDOW_NAME,
  DEFAULT_BROWSER_WINDOW_URL,
  createBrowserHistoryId,
  editBrowserHistoryRecord,
  makeUniqueBrowserName,
  openBrowserHistoryRecord,
  readBrowserHistorySafe,
  serializeBrowserHistory,
  syncOpenTabsToBrowserHistory,
  writeBrowserHistorySafe,
} = require('../features/browser/browser-history-service');
const { readStoreConfigSafe } = require('../ipc/register/store-utils');
const { normalizeAiFreeBrowserSettings } = require('../utils/ai-free-browser-settings');
const { FREE_BROWSER_WINDOW_LIMIT, resolveVipAccess } = require('../utils/vip-access');
const {
  BROWSER_ENVIRONMENT_INPUT_SCHEMA,
  BROWSER_SETTINGS_PATCH_SCHEMA,
  WINDOWS_TAB_INPUT_SCHEMA,
} = require('./ai-browser-window-tool-schema');

const WINDOWS_TAB_TOOL_NAME = 'windows_tab';
const BROWSER_ENVIRONMENT_TOOL_NAME = 'browser_environment';
const LEGACY_TOOL_NAME = 'software_window';
const SETTING_KEYS = new Set(Object.keys(BROWSER_SETTINGS_PATCH_SCHEMA.properties));

function text(value) {
  return String(value || '').trim();
}

function optionalField(value, key) {
  const normalized = text(value);
  return normalized ? { [key]: normalized } : {};
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function publicBrowserSettings(value) {
  const normalized = normalizeAiFreeBrowserSettings(value || {});
  const settings = {};
  for (const key of SETTING_KEYS) {
    if (normalized[key] !== undefined) settings[key] = cloneJson(normalized[key]);
  }
  if (settings.proxy) {
    settings.proxy.username = settings.proxy.username ? '[REDACTED]' : '';
    settings.proxy.password = settings.proxy.password ? '[REDACTED]' : '';
    settings.proxy.apiUrl = settings.proxy.apiUrl ? '[CONFIGURED]' : '';
  }
  if (settings.launchArgs?.value) settings.launchArgs.value = '[CONFIGURED]';
  return settings;
}

function slimHistoryItem(item = {}, includeSettings = false) {
  const result = {
    history_id: text(item.id),
    name: text(item.name),
    url: text(item.url),
    is_open: item?.isOpen === true,
    is_active: item?.isActive === true,
    tab_id: text(item.tabId),
    ...optionalField(item.kind, 'kind'),
    ...optionalField(item.accountId, 'account_id'),
    ...optionalField(item.lastError, 'last_error'),
    created_at: Number(item.createdAt) || 0,
    last_opened_at: Number(item.lastOpenedAt) || 0,
  };
  return {
    ...result,
    ...(includeSettings ? { settings: publicBrowserSettings(item.settings) } : {}),
  };
}

function windowSummary(items) {
  const windows = items.map((item) => slimHistoryItem(item));
  const active = windows.find((item) => item.is_active) || null;
  return {
    browser_total: windows.length,
    browser_open_count: windows.filter((item) => item.is_open).length,
    browser_names: windows.map((item) => item.name),
    open_browser_names: windows.filter((item) => item.is_open).map((item) => item.name),
    active_browser: active ? { history_id: active.history_id, name: active.name, tab_id: active.tab_id } : null,
  };
}

function createToolDefinitions() {
  return [
    {
      name: WINDOWS_TAB_TOOL_NAME,
      destructive: true,
      description: `【外部软件栏目】控制 AI-FREE 外部软件栏目的显示与记录。通过 action=list/open/create/edit/close 查询、显示、新建、编辑或关闭栏目；新建名称默认「${DEFAULT_BROWSER_WINDOW_NAME}」。`,
      input_schema: WINDOWS_TAB_INPUT_SCHEMA,
    },
    {
      name: BROWSER_ENVIRONMENT_TOOL_NAME,
      destructive: true,
      description: '按需读取或修改 AI-FREE 外部软件栏目的浏览器环境与指纹配置。',
      input_schema: BROWSER_ENVIRONMENT_INPUT_SCHEMA,
    },
  ];
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergeSettings(base, patch) {
  const result = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`环境配置字段不安全: ${key}`);
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? mergeSettings(result[key], value)
      : value;
  }
  return result;
}

function normalizeSettingsPatch(base, patch) {
  if (!isPlainObject(patch)) throw new Error('settings 必须是环境配置对象');
  const unknown = Object.keys(patch).filter((key) => !SETTING_KEYS.has(key));
  if (unknown.length) throw new Error(`不支持的环境配置字段: ${unknown.join(', ')}`);
  const normalized = normalizeAiFreeBrowserSettings(mergeSettings(base, patch));
  if (normalized.homepage?.mode === 'custom') {
    let parsed;
    try { parsed = new URL(normalized.homepage.url); } catch (_) { throw new Error('自定义主页必须是有效的 HTTP/HTTPS 地址'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('自定义主页只支持 HTTP/HTTPS 地址');
  }
  return normalized;
}

function resolveEditRequest(record, args) {
  const newName = text(args.new_name);
  const settingsProvided = Object.prototype.hasOwnProperty.call(args, 'settings');
  if (!newName && !settingsProvided) throw new Error('edit 至少需要 new_name 或 settings');
  const settings = settingsProvided ? normalizeSettingsPatch(record.settings || {}, args.settings) : null;
  return {
    newName,
    settings,
    settingsProvided,
    changes: {
      ...(newName ? { name: newName } : {}),
      ...(settingsProvided ? { settings } : {}),
    },
  };
}

async function applyEditedRuntimeSettings(ui, edited, request, restart) {
  if (!request.settingsProvided || !edited.tabId || typeof ui.setTabBrowserSettings !== 'function') return null;
  return ui.setTabBrowserSettings(edited.tabId, request.settings, { restartChromium: restart });
}

class AiBrowserWindowTools {
  constructor(deps) {
    this.ui = deps.ui;
    this.licenseCache = deps.licenseCache || null;
    this.logger = deps.logger || console;
    this.waitForBrowserConnection = typeof deps.waitForBrowserConnection === 'function'
      ? deps.waitForBrowserConnection
      : null;
    if (!this.ui || typeof this.ui.getTabs !== 'function') {
      throw new Error('AI 窗口工具缺少 ui 桥接（getTabs 等）');
    }
  }

  async withMcpReady(result) {
    if (!this.waitForBrowserConnection) return result;
    let connection = null;
    try {
      connection = await this.waitForBrowserConnection({
        historyId: result.history_id, tabId: result.tab_id, name: result.name,
      });
    } catch (error) {
      this.logger.warn?.('[AI窗口工具] 等待浏览器 MCP 连接失败:', error?.message || error);
    }
    if (!connection?.id) {
      return {
        ...result,
        success: false,
        mcp_connected: false,
        error: `窗口“${result.name}”已打开，但 Chromium 原生控制通道未在等待时间内就绪，暂时无法控制该窗口`,
      };
    }
    return {
      ...result,
      mcp_connected: true,
      control_browser_id: text(connection.id),
      control_browser_name: text(connection.name || result.name),
    };
  }

  listSerialized() {
    const history = syncOpenTabsToBrowserHistory(this.ui);
    return serializeBrowserHistory(history, this.ui);
  }

  resolveRecord(args = {}, serialized = this.listSerialized()) {
    const historyId = text(args.history_id);
    if (historyId) {
      const byId = serialized.find((item) => text(item?.id) === historyId);
      if (!byId) throw new Error(`外部软件栏目记录不存在: ${historyId}，请先调用 ${WINDOWS_TAB_TOOL_NAME} 的 list 操作查看`);
      return byId;
    }
    const name = text(args.name);
    if (!name) throw new Error('请提供 history_id 或 name 来定位浏览器窗口');
    const matches = serialized.filter((item) => text(item?.name).toLocaleLowerCase() === name.toLocaleLowerCase());
    if (!matches.length) throw new Error(`没有名为「${name}」的外部软件栏目记录，请先调用 ${WINDOWS_TAB_TOOL_NAME} 的 list 操作查看`);
    if (matches.length > 1) {
      const ids = matches.map((item) => text(item?.id)).join(', ');
      throw new Error(`有 ${matches.length} 个窗口都叫「${name}」（${ids}），请改用 history_id 指定`);
    }
    return matches[0];
  }

  findOpenTab(record) {
    const historyId = text(record?.id);
    return Array.from(this.ui.getTabs()?.values?.() || []).find((tab) => (
      text(tab?.browserHistoryId) === historyId
      || (record.profileId && text(tab?.id) === text(record.profileId))
      || (record.accountId && text(tab?.accountId) === text(record.accountId))
    )) || null;
  }

  async list(args = {}) {
    const includeSettings = args.include_settings === true;
    const items = this.listSerialized().map((item) => slimHistoryItem(item, includeSettings));
    return { success: true, total: items.length, open_count: items.filter((item) => item.is_open).length, items };
  }

  async environment(args = {}) {
    const action = text(args.action).toLowerCase();
    const record = this.resolveRecord(args);
    if (action === 'get') return { success: true, item: slimHistoryItem(record, true) };
    if (action === 'update') return this.edit({ ...args, action: 'edit' });
    throw new Error(`未知的浏览器环境操作: ${action || '未提供 action'}`);
  }

  async open(args = {}) {
    const record = this.resolveRecord(args);
    const opened = await openBrowserHistoryRecord(this.ui, record.id);
    return this.withMcpReady({
      success: true, history_id: text(opened.historyId || record.id), tab_id: text(opened.tabId),
      name: text(opened.name || record.name), already_open: opened.alreadyOpen === true,
      control_browser_requested: true,
      ...windowSummary(this.listSerialized()),
    });
  }

  assertCanCreate(requestedUrl) {
    const isVip = resolveVipAccess(this.licenseCache?.getSnapshot?.() || {}).isVip;
    if (!isVip && Number(this.ui.getTabs()?.size || 0) >= FREE_BROWSER_WINDOW_LIMIT) {
      throw new Error(`普通用户最多同时打开 ${FREE_BROWSER_WINDOW_LIMIT} 个独立浏览器窗口，请开通 VIP 后再试`);
    }
    if (typeof this.ui.addTab !== 'function') throw new Error('新建浏览器窗口功能不可用');
    if (requestedUrl && !/^https?:\/\//i.test(requestedUrl)) throw new Error('url 只支持 http/https 网址；留空则使用默认起始页');
  }

  resolveStartUrl(requestedUrl, settings) {
    if (requestedUrl) return requestedUrl;
    return settings.homepage?.mode === 'custom' && settings.homepage?.url
      ? settings.homepage.url
      : DEFAULT_BROWSER_WINDOW_URL;
  }

  async create(args = {}) {
    const requestedUrl = text(args.url);
    this.assertCanCreate(requestedUrl);
    const history = syncOpenTabsToBrowserHistory(this.ui);
    const defaults = normalizeAiFreeBrowserSettings(readStoreConfigSafe()?.aiFreeBrowserSettings || {});
    const settings = args.settings === undefined ? defaults : normalizeSettingsPatch(defaults, args.settings);
    const id = createBrowserHistoryId();
    const name = makeUniqueBrowserName(args.name || DEFAULT_BROWSER_WINDOW_NAME, history);
    const url = this.resolveStartUrl(requestedUrl, settings);
    const record = { id, name, url, runtimeType: 'chromium', settings, createdAt: Date.now(), lastOpenedAt: Date.now() };
    history.push(record);
    if (!writeBrowserHistorySafe(history)) throw new Error('浏览器历史未能写入本地配置');
    try {
      const tabId = await this.ui.addTab(record.url, {
        tabId: `browser-tab-${id.replace(/[^a-z0-9_-]/gi, '_')}`, fixedTitle: record.name,
        browserHistoryId: record.id, runtimeType: 'chromium', browserSettings: record.settings,
        resolveProfileInBackground: true, showLoadingPage: true, focusBrowser: false, restoreSideFocus: true,
      });
      if (!tabId) throw new Error('新建浏览器窗口失败');
      this.ui.sendToSide?.('browser-history-changed');
      return this.withMcpReady({
        success: true, history_id: id, tab_id: String(tabId), name, url,
        control_browser_requested: true,
        ...windowSummary(this.listSerialized()),
      });
    } catch (error) {
      writeBrowserHistorySafe(readBrowserHistorySafe().filter((item) => item.id !== id));
      this.ui.sendToSide?.('browser-history-changed');
      throw error;
    }
  }

  async edit(args = {}) {
    const record = this.resolveRecord(args);
    const request = resolveEditRequest(record, args);
    const edited = editBrowserHistoryRecord(this.ui, record.id, request.changes);
    const runtimeResult = await applyEditedRuntimeSettings(this.ui, edited, request, args.restart !== false);
    return {
      success: true,
      history_id: text(edited.historyId || record.id),
      name: text(edited.name || record.name),
      previous_name: text(edited.previousName || record.name),
      tab_id: text(edited.tabId),
      settings_saved: request.settingsProvided,
      changed_settings: request.settingsProvided ? Object.keys(args.settings) : [],
      runtime_result: runtimeResult,
      applies_on_next_open: request.settingsProvided && !edited.tabId,
      ...windowSummary(this.listSerialized()),
    };
  }

  async close(args = {}) {
    const record = this.resolveRecord(args);
    const openTab = this.findOpenTab(record);
    if (!openTab?.id) {
      return {
        success: true, closed: false, history_id: text(record.id), name: text(record.name),
        note: '该窗口当前没有打开，记录保持不变', ...windowSummary(this.listSerialized()),
      };
    }
    if (typeof this.ui.closeTab !== 'function') throw new Error('当前浏览器窗口无法关闭');
    await this.ui.closeTab(openTab.id);
    this.ui.sendToSide?.('browser-history-changed');
    return {
      success: true, closed: true, history_id: text(record.id), name: text(record.name),
      tab_id: text(openTab.id), ...windowSummary(this.listSerialized()),
    };
  }

  createApi() {
    const tools = createToolDefinitions();
    const handlers = {
      list: this.list.bind(this),
      open: this.open.bind(this),
      create: this.create.bind(this),
      edit: this.edit.bind(this),
      close: this.close.bind(this),
    };
    return {
      tools,
      has: (name) => [WINDOWS_TAB_TOOL_NAME, BROWSER_ENVIRONMENT_TOOL_NAME, LEGACY_TOOL_NAME].includes(text(name)),
      execute: async (name, args = {}) => {
        const toolName = text(name);
        if (toolName === BROWSER_ENVIRONMENT_TOOL_NAME) {
          this.logger.log?.(`[浏览器环境工具] 执行 ${toolName}.${text(args?.action).toLowerCase()}`);
          return this.environment(args && typeof args === 'object' ? args : {});
        }
        if (![WINDOWS_TAB_TOOL_NAME, LEGACY_TOOL_NAME].includes(toolName)) throw new Error(`未知的外部软件栏目工具: ${toolName}`);
        const action = text(args?.action).toLowerCase();
        const handler = handlers[action];
        if (!handler) throw new Error(`未知的软件窗口操作: ${action || '未提供 action'}`);
        this.logger.log?.(`[AI窗口工具] 执行 ${toolName}.${action}`);
        return handler(args && typeof args === 'object' ? args : {});
      },
    };
  }
}

function createAiBrowserWindowTools(deps = {}) {
  return new AiBrowserWindowTools(deps).createApi();
}

module.exports = {
  BROWSER_ENVIRONMENT_TOOL_NAME,
  WINDOWS_TAB_TOOL_NAME,
  createAiBrowserWindowTools,
};
