'use strict';

const os = require('os');
const {
  normalizeToolError,
  normalizeToolSchema,
} = require('../../services/automation-tool-contract');

const DEFAULT_HEYSURE_SERVER = 'http://49.234.181.190:3000';
const REGISTER_INTERVAL_MS = 3000;
const LOGIN_TIMEOUT_MS = 10000;
const MAX_COMPLETED_TASKS = 200;

function defaultSocketFactory(url, options) {
  return require('socket.io-client').io(url, options);
}

function normalizeServerUrl(value) {
  const raw = String(value || DEFAULT_HEYSURE_SERVER).trim().replace(/\/+$/, '');
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('HeySure 地址仅支持 HTTP 或 HTTPS');
  return parsed.toString().replace(/\/$/, '');
}

function requiredText(value, label, maxLength) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`请输入${label}`);
  if (text.length > maxLength) throw new Error(`${label}长度不能超过 ${maxLength} 个字符`);
  return text;
}

function normalizeLoginConfig(input = {}) {
  return {
    server: normalizeServerUrl(input.server),
    account: requiredText(input.account, '账号', 200),
    password: requiredText(input.password, '密码', 4096),
    serviceName: String(input.serviceName || 'AI-FREE').trim().slice(0, 80) || 'AI-FREE',
  };
}

function protocolToolName(sourceName) {
  const action = String(sourceName || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return action ? `aifree.${action}` : '';
}

function normalizeToolCatalog(listed = {}) {
  const tools = [];
  const routes = new Map();
  for (const source of listed.tools || []) {
    const sourceName = String(source?.name || '').trim();
    const name = protocolToolName(sourceName);
    if (!name || routes.has(name)) continue;
    routes.set(name, sourceName);
    tools.push({
      name,
      description: String(source.description || `调用 AI-FREE 的 ${sourceName} MCP 工具`).trim(),
      input_schema: normalizeToolSchema(source),
      destructive: source.destructive === true,
    });
  }
  return { tools, routes };
}

function catalogSignature(tools) {
  return JSON.stringify(tools);
}

function publicMessage(error, fallback) {
  return String(error?.message || error || fallback || '').trim();
}

function responsePayload(data) {
  return data && typeof data.data === 'object' && !data.access_token ? data.data : data;
}

async function parseLoginResponse(response) {
  let data = {};
  try { data = await response.json(); } catch (_) {}
  data = responsePayload(data || {});
  if (!response.ok) throw new Error(data?.message || data?.detail || `登录失败（HTTP ${response.status}）`);
  if (!data?.access_token) throw new Error('登录响应缺少 access_token');
  return data;
}

function stableServiceId(raw) {
  const normalized = String(raw || os.hostname() || 'device')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return `ai-free-${normalized || 'device'}`;
}

function taskSummary(tool, result) {
  const explicit = result && typeof result === 'object' ? String(result.summary || '').trim() : '';
  return explicit || `AI-FREE 工具 ${tool} 执行完成`;
}

class AiServerDeviceService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.createSocket = options.createSocket || defaultSocketFactory;
    this.computeDeviceId = options.computeDeviceId || (() => 'device');
    this.getTools = options.getTools || (() => ({ tools: [] }));
    this.callTool = options.callTool || (() => { throw new Error('MCP 执行器尚未就绪'); });
    this.credentialStore = options.credentialStore || null;
    this.hasVipAccess = options.hasVipAccess || (() => false);
    this.onStatus = options.onStatus || (() => {});
    this.logger = options.logger || console;
    this.version = String(options.version || '1.0.0');
    this.socket = null;
    this.credentials = null;
    this.token = '';
    this.socketUrl = '';
    this.serviceId = '';
    this.registered = false;
    this.registerTimer = null;
    this.registering = false;
    this.reauthenticating = false;
    this.routes = new Map();
    this.lastCatalogSignature = '';
    this.inFlightTasks = new Set();
    this.completedTasks = new Map();
    this.state = {
      phase: 'idle', server: DEFAULT_HEYSURE_SERVER, account: '', serviceId: '', serviceName: 'AI-FREE',
      connected: false, registered: false, remembered: this.credentialStore?.has?.() === true,
      aiConfigId: null, toolCount: 0, message: '尚未连接 AI 服务器',
    };
  }

  status() {
    return { ...this.state };
  }

  publishStatus(patch = {}) {
    this.state = { ...this.state, ...patch };
    try { this.onStatus(this.status()); } catch (_) {}
  }

  async resolveServiceId() {
    if (this.serviceId) return this.serviceId;
    const explicit = String(process.env.HEYSURE_SERVICE_ID || '').trim();
    const identity = explicit || await this.computeDeviceId();
    this.serviceId = explicit || stableServiceId(identity);
    return this.serviceId;
  }

  async requestLogin(config) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
    try {
      const response = await this.fetch(`${config.server}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: config.account, password: config.password }),
        signal: controller.signal,
      });
      return await parseLoginResponse(response);
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('登录 AI 服务器超时');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  persistCredentials(config, remember) {
    if (!remember || !this.credentialStore) {
      return { remembered: this.credentialStore?.has?.() === true, warning: '' };
    }
    try {
      this.credentialStore.save(config);
      return { remembered: true, warning: '' };
    } catch (error) {
      const warning = publicMessage(error, '无法保存自动登录凭据');
      this.logger.warn?.('[AIServerDevice] 无法保存自动登录凭据:', warning);
      return { remembered: false, warning };
    }
  }

  vipRequiredResult() {
    const message = '连接 HeySure 服务器仅限当前有效会员';
    this.publishStatus({ phase: 'idle', connected: false, registered: false, message });
    return { ok: false, vipRequired: true, error: message, status: this.status() };
  }

  async login(input = {}, options = {}) {
    if (this.hasVipAccess() !== true) return this.vipRequiredResult();
    const config = normalizeLoginConfig(input);
    this.disconnectSocket();
    this.credentials = config;
    this.publishStatus({
      phase: 'authenticating', server: config.server, account: config.account,
      serviceName: config.serviceName, connected: false, registered: false, message: '正在登录 AI 服务器…',
    });
    try {
      const data = await this.requestLogin(config);
      const persistence = this.persistCredentials(config, options.remember !== false);
      this.token = String(data.access_token);
      this.socketUrl = normalizeServerUrl(data.agent_socket_url || config.server);
      await this.resolveServiceId();
      this.publishStatus({
        serviceId: this.serviceId, phase: 'connecting', remembered: persistence.remembered,
        message: '登录成功，正在注册设备…',
      });
      this.connectSocket();
      return { ok: true, warning: persistence.warning, status: this.status() };
    } catch (error) {
      const message = publicMessage(error, '登录 AI 服务器失败');
      this.publishStatus({ phase: 'error', connected: false, registered: false, message });
      return { ok: false, error: message, status: this.status() };
    }
  }

  connectSocket() {
    this.disconnectSocket();
    const socket = this.createSocket(this.socketUrl, {
      reconnection: true,
      reconnectionDelay: 2000,
      autoConnect: false,
    });
    this.socket = socket;
    socket.on('connect', () => this.handleConnect());
    socket.on('disconnect', (reason) => this.handleDisconnect(reason));
    socket.on('connect_error', (error) => this.handleConnectError(error));
    socket.on('device:registered', (data) => this.handleRegistered(data));
    socket.on('device:register_rejected', (data) => void this.handleRejected(data));
    socket.on('task:dispatch', (task) => void this.handleTask(task));
    socket.connect();
  }

  handleConnect() {
    this.registered = false;
    this.publishStatus({ phase: 'connecting', connected: true, registered: false, message: '已连接，正在上报 MCP 工具…' });
    void this.refreshRegistration(true);
    this.startRegisterTimer();
  }

  handleDisconnect(reason) {
    this.registered = false;
    this.publishStatus({
      phase: 'disconnected', connected: false, registered: false,
      message: `连接已断开，正在自动重连${reason ? `（${reason}）` : ''}`,
    });
  }

  handleConnectError(error) {
    this.publishStatus({
      phase: 'error', connected: false, registered: false,
      message: publicMessage(error, '连接 AI 服务器失败，正在重试'),
    });
  }

  handleRegistered(data = {}) {
    this.registered = true;
    const aiConfigId = data.aiConfigId ?? null;
    this.publishStatus({
      phase: 'registered', connected: true, registered: true, aiConfigId,
      message: aiConfigId === null
        ? '设备已在线；请到作坊面板分配 AI 并勾选 MCP 权限'
        : '设备已在线并绑定 AI',
    });
  }

  async handleRejected(data = {}) {
    this.registered = false;
    const reason = String(data.reason || '服务器拒绝注册');
    this.publishStatus({ phase: 'authenticating', registered: false, message: `${reason}，正在重新登录…` });
    if (!this.credentials || this.reauthenticating) return;
    this.reauthenticating = true;
    try {
      const login = await this.requestLogin(this.credentials);
      this.token = String(login.access_token);
      const nextUrl = normalizeServerUrl(login.agent_socket_url || this.credentials.server);
      if (nextUrl !== this.socketUrl) {
        this.socketUrl = nextUrl;
        this.connectSocket();
      } else {
        await this.refreshRegistration(true);
      }
    } catch (error) {
      this.publishStatus({ phase: 'error', message: publicMessage(error, '重新登录失败') });
    } finally {
      this.reauthenticating = false;
    }
  }

  startRegisterTimer() {
    if (this.registerTimer) clearInterval(this.registerTimer);
    this.registerTimer = setInterval(() => void this.refreshRegistration(false), REGISTER_INTERVAL_MS);
    this.registerTimer.unref?.();
  }

  async refreshRegistration(force) {
    if (!this.socket?.connected || this.registering || !this.token) return false;
    this.registering = true;
    try {
      const catalog = normalizeToolCatalog(await this.getTools());
      const signature = catalogSignature(catalog.tools);
      if (!force && this.registered && signature === this.lastCatalogSignature) return false;
      this.routes = catalog.routes;
      this.lastCatalogSignature = signature;
      this.registered = false;
      this.socket.emit('device:register', {
        id: await this.resolveServiceId(),
        name: this.credentials?.serviceName || 'AI-FREE',
        platform: 'ai-free-custom-service',
        deviceType: 'custom',
        token: this.token,
        version: this.version,
        capabilities: catalog.tools.map((tool) => tool.name),
        toolDefs: catalog.tools,
      });
      this.publishStatus({
        phase: 'connecting', connected: true, registered: false,
        toolCount: catalog.tools.length,
        message: `已上报 ${catalog.tools.length} 个 MCP 工具，等待服务器确认…`,
      });
      return true;
    } catch (error) {
      this.publishStatus({ phase: 'error', message: publicMessage(error, '读取 MCP 工具失败') });
      return false;
    } finally {
      this.registering = false;
    }
  }

  rememberCompletedTask(taskId, terminal) {
    this.completedTasks.set(taskId, terminal);
    while (this.completedTasks.size > MAX_COMPLETED_TASKS) {
      this.completedTasks.delete(this.completedTasks.keys().next().value);
    }
  }

  async handleTask(task = {}) {
    const taskId = String(task.taskId || '').trim();
    const socket = this.socket;
    if (!taskId || !socket) return;
    if (this.completedTasks.has(taskId)) return;
    if (this.inFlightTasks.has(taskId)) return;
    this.inFlightTasks.add(taskId);
    const tool = String(task.tool || '').trim();
    try {
      const sourceName = this.routes.get(tool);
      if (!sourceName) throw new Error(`未知或当前不可用的 MCP 工具: ${tool}`);
      const result = await this.callTool(sourceName, task.args || {});
      const payload = {
        taskId, deviceId: this.serviceId, success: true, tool,
        result, summary: taskSummary(tool, result),
      };
      this.rememberCompletedTask(taskId, { event: 'task:result', payload });
      socket.emit('task:result', payload);
    } catch (error) {
      const normalized = normalizeToolError(error, {
        code: 'MCP_TOOL_FAILED',
        message: publicMessage(error, 'MCP 工具执行失败'),
        phase: 'heysure_task',
      });
      const payload = {
        taskId,
        deviceId: this.serviceId,
        error: normalized.message,
        errorCode: normalized.code,
        phase: normalized.phase,
        retryable: normalized.retryable,
      };
      this.rememberCompletedTask(taskId, { event: 'task:error', payload });
      socket.emit('task:error', payload);
    } finally {
      this.inFlightTasks.delete(taskId);
    }
  }

  disconnectSocket() {
    if (this.registerTimer) clearInterval(this.registerTimer);
    this.registerTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.disconnect();
    this.registered = false;
  }

  logout() {
    this.disconnectSocket();
    this.credentials = null;
    this.token = '';
    this.socketUrl = '';
    this.routes.clear();
    this.lastCatalogSignature = '';
    this.completedTasks.clear();
    const forgotten = this.credentialStore?.clear?.() !== false;
    this.publishStatus({
      phase: 'idle', connected: false, registered: false, aiConfigId: null,
      toolCount: 0, remembered: !forgotten, message: forgotten ? '已断开 AI 服务器' : '已断开，但自动登录凭据清除失败',
    });
    return forgotten
      ? { ok: true, status: this.status() }
      : { ok: false, error: '自动登录凭据清除失败', status: this.status() };
  }

  async startFromEnvironment() {
    const account = String(process.env.HEYSURE_ACCOUNT || '').trim();
    const password = String(process.env.HEYSURE_PASSWORD || '');
    if (!account || !password) return { ok: true, skipped: true, status: this.status() };
    return this.login({
      server: process.env.HEYSURE_SERVER || DEFAULT_HEYSURE_SERVER,
      account,
      password,
      serviceName: process.env.HEYSURE_SERVICE_NAME || 'AI-FREE',
    }, { remember: false });
  }

  async startAutomatically() {
    if (this.hasVipAccess() !== true) {
      const remembered = this.credentialStore?.has?.() === true;
      this.publishStatus({
        phase: 'idle', connected: false, registered: false, remembered,
        message: remembered ? '已保存 HeySure 登录；当前会员无效，未自动连接' : '尚未连接 AI 服务器',
      });
      return { ok: true, skipped: true, reason: 'vip_required', status: this.status() };
    }
    const environment = await this.startFromEnvironment();
    if (!environment.skipped) return environment;
    const saved = this.credentialStore?.load?.();
    if (!saved) return { ok: true, skipped: true, reason: 'no_credentials', status: this.status() };
    return this.login(saved, { remember: false });
  }

  stop() {
    this.disconnectSocket();
    this.credentials = null;
    this.token = '';
    this.socketUrl = '';
    this.routes.clear();
    this.completedTasks.clear();
    return { ok: true };
  }
}

function createAiServerDeviceService(options = {}) {
  return new AiServerDeviceService(options);
}

module.exports = {
  DEFAULT_HEYSURE_SERVER,
  AiServerDeviceService,
  createAiServerDeviceService,
  normalizeLoginConfig,
  normalizeToolCatalog,
  protocolToolName,
};
