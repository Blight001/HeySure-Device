const http = require('http');
const { CARD_CACHE_FILE_NAME, createCardCacheStore, normalizeCardCacheState } = require('./automation-card-store');
const { createBrowserAutomationExternalGateway } = require('./browser-automation-external-gateway');
const { createAutomationCardMcpRouter } = require('./automation-card-mcp-router');
const { createNativeAutomationCardService } = require('./native-automation-card-service');
const { createNativeBrowserAutomation } = require('./native-browser-automation');
const { NATIVE_BROWSER_TOOL_DEFINITIONS } = require('./native-browser-tool-definitions');

const DEFAULT_PORT = 18765;

class BrowserAutomationBridgeRuntime {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.host = '127.0.0.1';
    this.port = Number(options.port || process.env.AI_FREE_AUTOMATION_BRIDGE_PORT || DEFAULT_PORT);
    this.backgroundExecutionLeases = options.backgroundExecutionLeases || null;
    this.cardCacheStore = createCardCacheStore({ dataDir: options.cardCacheDir });
    this.nativeCardService = createNativeAutomationCardService({
      read: () => this.cardCacheStore.read(), write: (state) => this.cardCacheStore.write(state),
    });
    this.cardMcpRouter = createAutomationCardMcpRouter({
      listConnections: () => this.listConnections(),
      getConnection: (id) => this.getConnection(id),
      dispatch: (...args) => this.dispatch(...args),
    });
    this.nativeAutomation = createNativeBrowserAutomation({
      browserRuntimeManager: options.browserRuntimeManager, browserDownloadService: options.browserDownloadService,
      cardService: this.nativeCardService, getTabs: options.getTabs,
      workspaceDir: options.workspaceDir, getBrowserRecords: options.getBrowserRecords,
      executeCardTool: (...args) => this.cardMcpRouter.execute(...args),
    });
    this.server = null;
    this.externalMcpGateway = createBrowserAutomationExternalGateway({
      descriptorPath: options.externalMcpDescriptorPath,
      dispatch: (...args) => this.dispatch(...args),
      getConnection: (...args) => this.getConnection(...args),
      listConnections: () => this.listConnections(),
      getActiveConnectionId: () => {
        const profileId = String(options.getActiveBrowserProfileId?.() || '').trim();
        return this.listConnections().find((item) => item.profileId === profileId)?.id || '';
      },
      getAccess: options.getExternalMcpAccess,
      logger: this.logger,
      overviewTool: NATIVE_BROWSER_TOOL_DEFINITIONS.find((tool) => tool.name === 'browser_control'),
      getBrowserOverview: (args) => this.nativeAutomation.browserOverview(args),
    });
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${this.host}:${this.port}`);
    if (await this.externalMcpGateway.handle(req, res, url)) return;
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, message: '接口不存在' }));
  }

  async start() {
    if (this.server) return { host: this.host, port: this.port };
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolve(undefined);
      });
    });
    this.publishExternalMcp();
    this.logger.log?.(`[AutomationBridge] Chromium 原生自动化网关已启动: http://${this.host}:${this.port}`);
    return { host: this.host, port: this.port };
  }

  publishExternalMcp() {
    try {
      this.externalMcpGateway.refreshPublication({ host: this.host, port: this.port });
    } catch (error) {
      this.logger.warn?.('[ExternalMCP] 无法发布 Codex 桥接描述文件:', error?.message || error);
    }
  }

  listConnections() {
    return this.nativeAutomation.listConnections();
  }

  getConnection(id) {
    return this.nativeAutomation.getConnection(id);
  }

  getCardCacheState() {
    return this.cardCacheStore.read();
  }

  setCardCacheState(state = {}) {
    return this.cardCacheStore.write(state);
  }

  selectCard(cardId) {
    const id = String(cardId || '').trim();
    if (!id) throw new Error('缺少要选择的自动化卡片 ID');
    const cached = this.cardCacheStore.read();
    const item = cached.state.items.find((entry) => String(entry?.id || '').trim() === id);
    if (!item) throw new Error(`自动化卡片不存在或已被删除: ${id}`);
    const state = this.cardCacheStore.write({ ...cached.state, selectedId: id });
    return { state, item };
  }

  async withBackgroundLease(operation, options = {}) {
    const lease = this.backgroundExecutionLeases?.acquire?.({ timeoutMs: options.timeoutMs });
    try { return await operation(); } finally { lease?.release?.(); }
  }

  manageCard(connectionId, args = {}, options = {}) {
    const action = String(args?.action || '').trim().toLowerCase();
    if (action === 'run') {
      return this.withBackgroundLease(() => this.nativeCardService.execute(args, {
        timeoutMs: options.timeoutMs,
        dispatch: (tool, toolArgs) => this.cardMcpRouter.execute(connectionId, tool, toolArgs, options),
      }), options);
    }
    return this.nativeCardService.execute(args, { timeoutMs: options.timeoutMs });
  }

  saveBrowserSession(connectionId, args = {}, options = {}) {
    return this.dispatch(connectionId, 'browser_file', {
      ...args,
      action: 'save_session',
    }, options);
  }

  dispatch(connectionId, tool, args = {}, options = {}) {
    return this.withBackgroundLease(
      () => this.nativeAutomation.dispatch(connectionId, tool, args, options),
      options,
    );
  }

  async stop() {
    this.externalMcpGateway.unpublish();
    if (!this.server) return;
    const current = this.server;
    this.server = null;
    await new Promise((resolve) => current.close(() => resolve(undefined)));
  }

  refreshExternalMcpAccess() {
    if (!this.server) return false;
    return this.externalMcpGateway.refreshPublication({ host: this.host, port: this.port });
  }

  configureExternalMcp(context = {}) {
    this.cardMcpRouter.configure(context);
    this.externalMcpGateway.configure(context);
    return this.refreshExternalMcpAccess();
  }

  listExternalMcpTools() {
    return this.externalMcpGateway.listTools();
  }

  listAutomationMcpTools() {
    return this.cardMcpRouter.listTools();
  }

  callExternalMcpTool(name, args = {}) {
    return this.externalMcpGateway.callTool(name, args);
  }
}

function createBrowserAutomationBridge(options = {}) {
  const runtime = new BrowserAutomationBridgeRuntime(options);
  return {
    configureExternalMcp: (context) => runtime.configureExternalMcp(context),
    callExternalMcpTool: (...args) => runtime.callExternalMcpTool(...args),
    dispatch: (...args) => runtime.dispatch(...args),
    getConnection: (...args) => runtime.getConnection(...args),
    getCardCacheState: () => runtime.getCardCacheState(),
    listConnections: () => runtime.listConnections(),
    listAutomationMcpTools: () => runtime.listAutomationMcpTools(),
    listExternalMcpTools: () => runtime.listExternalMcpTools(),
    manageCard: (...args) => runtime.manageCard(...args),
    saveBrowserSession: (...args) => runtime.saveBrowserSession(...args),
    selectCard: (...args) => runtime.selectCard(...args),
    setCardCacheState: (...args) => runtime.setCardCacheState(...args),
    refreshExternalMcpAccess: () => runtime.refreshExternalMcpAccess(),
    start: () => runtime.start(),
    stop: () => runtime.stop(),
    host: runtime.host,
    port: runtime.port,
    cardCacheFilePath: runtime.cardCacheStore.filePath,
  };
}

module.exports = {
  CARD_CACHE_FILE_NAME,
  DEFAULT_PORT,
  createBrowserAutomationBridge,
  createCardCacheStore,
  normalizeCardCacheState,
};
