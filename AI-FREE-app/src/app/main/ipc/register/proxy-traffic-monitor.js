const crypto = require('crypto');

const SAMPLE_INTERVAL_MS = 2000;
const DEFAULT_REPORT_INTERVAL_MS = 30000;
const EARLY_REPORT_BYTES = 8 * 1024 * 1024;

function normalizeCounter(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

const NON_BILLABLE_CHAINS = new Set([
  'DIRECT',
  'PASS',
  'REJECT',
  'REJECT-DROP',
]);

function normalizeChainName(value) {
  return String(value || '').trim().toUpperCase();
}

function isBillableProxyConnection(connection) {
  const chains = Array.isArray(connection?.chains)
    ? connection.chains.map(normalizeChainName).filter(Boolean)
    : [];
  if (chains.length === 0) return false;
  return !chains.some((name) => NON_BILLABLE_CHAINS.has(name));
}

function createBillableTrafficTracker() {
  let initialized = false;
  let previousConnections = new Map();

  const reset = () => {
    initialized = false;
    previousConnections = new Map();
  };

  const sample = (snapshot) => {
    // Mihomo 没有活动连接时（例如浏览器当前没有网络请求），Go 的
    // nil slice 会把 connections 序列化成 null，这仍是合法的空闲响应，
    // 不能当成格式错误——连续误判会触发“控制端口不可用”而停掉 Clash。
    assertValidTrafficSnapshot(snapshot);
    const connections = Array.isArray(snapshot.connections) ? snapshot.connections : [];

    const currentConnections = new Map();
    let upload = 0;
    let download = 0;

    for (const connection of connections) {
      const id = String(connection?.id || '').trim();
      if (!id) continue;

      const current = normalizeTrafficConnection(connection);
      currentConnections.set(id, current);
      if (!initialized || !current.billable) continue;
      const previous = previousConnections.get(id);
      const delta = getConnectionTrafficDelta(current, previous);
      upload += delta.upload;
      download += delta.download;
    }

    initialized = true;
    previousConnections = currentConnections;
    return { upload, download };
  };

  return { reset, sample };
}

function assertValidTrafficSnapshot(snapshot) {
  const idleSnapshot = snapshot
    && snapshot.connections == null
    && Number.isFinite(Number(snapshot.downloadTotal))
    && Number.isFinite(Number(snapshot.uploadTotal));
  if (!snapshot || (!Array.isArray(snapshot.connections) && !idleSnapshot)) {
    throw new Error('Mihomo 连接流量响应格式无效');
  }
}

function normalizeTrafficConnection(connection) {
  return {
    upload: normalizeCounter(connection?.upload),
    download: normalizeCounter(connection?.download),
    billable: isBillableProxyConnection(connection),
  };
}

function getConnectionTrafficDelta(current, previous) {
  if (!previous) return { upload: current.upload, download: current.download };
  if (!previous.billable) return { upload: 0, download: 0 };
  return {
    upload: current.upload >= previous.upload ? current.upload - previous.upload : current.upload,
    download: current.download >= previous.download ? current.download - previous.download : current.download,
  };
}

function signReport(secret, fields) {
  const message = [
    fields.session_id,
    fields.sequence,
    fields.reported_at,
    fields.upload_bytes,
    fields.download_bytes,
  ].join('\n');
  return crypto.createHmac('sha256', String(secret || '')).update(message, 'utf8').digest('hex');
}

function describeAuthorizationFailure(result) {
  const explicit = String(result?.message || result?.error || '').trim();
  if (explicit) return explicit;
  if (result?.quota?.exhausted === true || Number(result?.status) === 402) {
    return '网络魔法流量已用完，请到个人中心兑换流量';
  }
  return describeAuthorizationStatus(Number(result?.status || 0));
}

function describeAuthorizationStatus(status) {
  const exactMessages = {
    404: '服务器暂未启用流量额度接口，请更新并重启服务器',
    401: '账号或设备验证失败，请重新登录后再试',
    403: '账号或设备验证失败，请重新登录后再试',
  };
  if (exactMessages[status]) return exactMessages[status];
  if (status >= 500) return `服务器流量额度服务异常（HTTP ${status}），请联系管理员检查服务端日志`;
  if (status > 0) return `流量额度校验失败（HTTP ${status}）`;
  return '无法连接流量额度服务，请检查服务器连接';
}

/** @param {Record<string, any>} [options] */
function createProxyTrafficMonitor({ httpClient, ui, readCredentials, readTotals, onExhausted, onUnavailable, logger = console } = {}) {
  const monitor = new ProxyTrafficMonitor({
    httpClient, ui, readCredentials, readTotals, onExhausted, onUnavailable, logger,
  });
  return {
    authorize: () => monitor.authorize(),
    start: () => monitor.start(),
    stop: () => monitor.stop(),
    flush: (...args) => monitor.flush(...args),
    sample: () => monitor.sample(),
    signReport,
  };
}

class ProxyTrafficMonitor {
  constructor(options) {
    this.httpClient = options.httpClient;
    this.ui = options.ui;
    this.readCredentials = options.readCredentials;
    this.readTotals = options.readTotals;
    this.onExhausted = options.onExhausted;
    this.onUnavailable = options.onUnavailable;
    this.logger = options.logger;
    this.timer = null;
    this.session = null;
    this.trafficTracker = createBillableTrafficTracker();
    this.pendingUpload = 0;
    this.pendingDownload = 0;
    this.sequence = 0;
    this.reporting = null;
    this.lastReportAt = 0;
    this.consecutiveReadFailures = 0;
    this.unavailableNotified = false;
    this.samplingPromise = null;
  }

  emitQuota(quota) {
    if (!quota) return;
    try { this.ui?.sendToSide?.('proxy-traffic-quota', quota); } catch (_) {}
  }

  async authorize() {
    const credentials = typeof this.readCredentials === 'function' ? this.readCredentials() : {};
    const key = String(credentials?.key || '').trim();
    const deviceId = String(credentials?.deviceId || '').trim();
    if (!key || !deviceId) return { ok: false, message: '请先在个人中心登录账号' };
    const result = await this.httpClient.createProxyTrafficSession(key, deviceId);
    if (!result?.ok) {
      const message = describeAuthorizationFailure(result);
      return { ...(result || {}), ok: false, message, error: message };
    }
    if (!result.session_id || !result.report_secret) {
      return { ok: false, message: '服务器未返回安全流量计量会话' };
    }
    this.session = {
      id: String(result.session_id),
      secret: String(result.report_secret),
      expiresAt: Number(result.expires_at || 0),
      reportIntervalMs: Math.max(10000, Number(result.report_interval_seconds || 30) * 1000),
    };
    this.resetCounters();
    this.emitQuota(result.quota);
    return result;
  }

  resetCounters() {
    this.sequence = 0;
    this.trafficTracker.reset();
    this.pendingUpload = 0;
    this.pendingDownload = 0;
    this.lastReportAt = Date.now();
    this.consecutiveReadFailures = 0;
    this.unavailableNotified = false;
  }

  async flush({ force = false } = {}) {
    if (this.reporting) return this.reporting;
    if (!this.session) return { ok: false, skipped: true };
    const total = this.pendingUpload + this.pendingDownload;
    if (!force && total <= 0) return { ok: true, skipped: true };
    if (total <= 0) return { ok: true, skipped: true };
    const upload = this.pendingUpload;
    const download = this.pendingDownload;
    const nextSequence = this.sequence + 1;
    const reportedAt = Math.floor(Date.now() / 1000);
    const payload = {
      session_id: this.session.id,
      sequence: nextSequence,
      reported_at: reportedAt,
      upload_bytes: upload,
      download_bytes: download,
    };
    payload.signature = signReport(this.session.secret, payload);
    this.reporting = this.performReport(payload, { upload, download, nextSequence }).catch((error) => {
      this.logger.warn?.('[流量计量] 安全上报失败，将保留增量稍后重试:', error?.message || error);
      return { ok: false, message: error?.message || String(error) };
    }).finally(() => {
      this.reporting = null;
    });
    return this.reporting;
  }

  async performReport(payload, batch) {
    const result = await this.httpClient.reportProxyTraffic(payload);
    if (!result?.ok) {
      if (result?.session_expired) this.session = null;
      throw new Error(result?.message || result?.error || '流量上报失败');
    }
    this.pendingUpload = Math.max(0, this.pendingUpload - batch.upload);
    this.pendingDownload = Math.max(0, this.pendingDownload - batch.download);
    this.sequence = batch.nextSequence;
    this.lastReportAt = Date.now();
    this.emitQuota(result.quota);
    if (result.stop_required === true || result.quota?.exhausted === true) {
      clearInterval(this.timer);
      this.timer = null;
      await Promise.resolve(this.onExhausted?.(result.quota)).catch(() => {});
    }
    return result;
  }

  async sampleOnce() {
    if (!this.session || typeof this.readTotals !== 'function') return;
    try {
      const totals = await this.readTotals();
      this.consecutiveReadFailures = 0;
      const delta = this.trafficTracker.sample(totals);
      this.pendingUpload += delta.upload;
      this.pendingDownload += delta.download;
      if (this.isReportDue()) await this.flush();
    } catch (error) {
      await this.handleReadFailure(error);
    }
  }

  isReportDue() {
    const interval = this.session?.reportIntervalMs || DEFAULT_REPORT_INTERVAL_MS;
    return Date.now() - this.lastReportAt >= interval
      || this.pendingUpload + this.pendingDownload >= EARLY_REPORT_BYTES;
  }

  async handleReadFailure(error) {
    this.consecutiveReadFailures += 1;
    if (this.consecutiveReadFailures === 1) {
      this.logger.warn?.('[流量计量] 暂时无法读取 Mihomo 累计流量，将自动重试:', error?.message || error);
    }
    if (this.consecutiveReadFailures < 3 || this.unavailableNotified) return;
    this.unavailableNotified = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.logger.warn?.('[流量计量] Mihomo 控制端口连续不可用，已停止轮询并恢复直连');
    await this.flush({ force: true }).catch(() => {});
    await Promise.resolve(this.onUnavailable?.(error)).catch(() => {});
  }

  sample() {
    if (this.samplingPromise) return this.samplingPromise;
    this.samplingPromise = this.sampleOnce().finally(() => {
      this.samplingPromise = null;
    });
    return this.samplingPromise;
  }

  start() {
    if (!this.session) return false;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { this.sample().catch(() => {}); }, SAMPLE_INTERVAL_MS);
    setTimeout(() => { this.sample().catch(() => {}); }, 800);
    return true;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.sample().catch(() => {});
    if (this.reporting) await this.reporting.catch(() => {});
    await this.flush({ force: true }).catch(() => {});
    this.trafficTracker.reset();
    this.session = null;
  }
}

module.exports = {
  createBillableTrafficTracker,
  createProxyTrafficMonitor,
  describeAuthorizationFailure,
  isBillableProxyConnection,
  signReport,
};
