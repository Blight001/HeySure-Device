const DEFAULT_INTERVAL_MS = 60000;
const { summarizeUpdatePayload } = require('../utils/update-payload');

class AnnouncementPoller {
  constructor(options = {}) {
    this.getJson = options.getJson;
    this.postJson = options.postJson;
    this.getServerBase = options.getServerBase;
    this.getClientIdentity = options.getClientIdentity;
    this.shouldPoll = options.shouldPoll;
    this.sendToSide = options.sendToSide;
    this.sendUpdateNotice = options.sendUpdateNotice;
    this.logger = options.logger || console;
    this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs || 8000;
    this.timer = null;
    this.inFlight = false;
    this.pendingPoll = false;
    this.lastServerBase = '';
    this.seenByServer = new Map();
  }

  resolveAnnouncementId(announcement) {
    if (!announcement || typeof announcement !== 'object') return '';
    const id = announcement.announcement_id ?? announcement.announcementId ?? announcement.id;
    if (id !== undefined && id !== null && String(id).trim()) return String(id).trim();
    return String(announcement.content || announcement.message || '').trim().slice(0, 160);
  }

  resolveAnnouncementFingerprint(announcement) {
    const id = this.resolveAnnouncementId(announcement);
    if (!id) return '';
    const update = summarizeUpdatePayload(announcement);
    return JSON.stringify([
      id,
      announcement.message ?? announcement.content ?? '',
      announcement.message_type ?? announcement.announcement_type ?? '',
      update.version,
      update.downloadUrl || update.openUrl,
    ]);
  }

  resolveDeliveryChannel(announcement) {
    const type = String(
      announcement?.message_type ?? announcement?.messageType
      ?? announcement?.announcement_type ?? announcement?.type ?? '',
    ).trim().toLowerCase();
    const update = summarizeUpdatePayload(announcement);
    const hasUpdate = Boolean(update.version && (update.downloadUrl || update.openUrl));
    return ['update', 'upgrade', 'app_update', 'software_update'].includes(type) || hasUpdate
      ? 'app-update-notice'
      : 'server-message';
  }

  async pollOnce() {
    if (this.inFlight) {
      this.pendingPoll = true;
      return;
    }
    this.inFlight = true;
    try {
      await this.executePoll();
    } catch (error) {
      this.logger.warn?.('[公告轮询] 拉取公告失败:', error?.message || error);
    } finally {
      this.finishPoll();
    }
  }

  async executePoll() {
    if (typeof this.shouldPoll === 'function' && this.shouldPoll() !== true) return;
    const base = this.resolveServerBase();
    if (!base) return;
    this.handleServerChange(base);
    const announcementRequest = this.getJson(`${base}/api/user_announcement`, this.timeoutMs);
    const heartbeatTask = this.startHeartbeat(base);
    const list = await this.readAnnouncements(announcementRequest);
    await this.deliverAnnouncements(base, list);
    if (heartbeatTask) await heartbeatTask;
  }

  resolveServerBase() {
    const value = typeof this.getServerBase === 'function' ? this.getServerBase() : '';
    return String(value || '').replace(/\/+$/, '');
  }

  handleServerChange(base) {
    if (base === this.lastServerBase) return;
    this.lastServerBase = base;
    this.sendToSide('server-announcements-reset', { serverBase: base });
  }

  startHeartbeat(base) {
    const identity = typeof this.getClientIdentity === 'function' ? this.getClientIdentity() : null;
    const key = String(identity?.key || '').trim();
    const deviceId = String(identity?.deviceId || identity?.device_id || '').trim();
    if (!key || !deviceId || typeof this.postJson !== 'function') return null;
    return Promise.resolve().then(async () => {
      const response = await this.postJson(
        `${base}/api/client/heartbeat`, { session_token: key, device_id: deviceId }, this.timeoutMs,
      );
      const body = response?.body ?? response;
      if (!body || body.success !== true) {
        this.logger.warn?.('[HTTP 心跳] 服务器未确认在线状态:', body?.message || '未知响应');
      }
    }).catch((error) => {
      this.logger.warn?.('[HTTP 心跳] 上报失败:', error?.message || error);
    });
  }

  async readAnnouncements(request) {
    const response = await request;
    const body = response && typeof response === 'object' && response.body !== undefined
      ? response.body
      : response;
    if (!body || body.success === false) throw new Error(body?.message || '公告接口返回失败');
    return Array.isArray(body.data) ? body.data : [];
  }

  async deliverAnnouncements(base, list) {
    const previous = this.seenByServer.get(base) || new Map();
    const current = new Map();
    for (const announcement of list) {
      const id = this.resolveAnnouncementId(announcement);
      const fingerprint = this.resolveAnnouncementFingerprint(announcement);
      if (!id || !fingerprint) continue;
      current.set(id, fingerprint);
      if (previous.get(id) === fingerprint) continue;
      await this.deliverAnnouncement(announcement, id, current);
    }
    this.seenByServer.set(base, current);
  }

  async deliverAnnouncement(announcement, id, current) {
    try {
      const channel = this.resolveDeliveryChannel(announcement);
      const delivered = channel === 'app-update-notice' && typeof this.sendUpdateNotice === 'function'
        ? await this.sendUpdateNotice(announcement)
        : this.sendToSide(channel, announcement);
      if (delivered === false) {
        current.delete(id);
        this.logger.warn?.('[公告轮询] 侧边栏尚未就绪，公告将在下次轮询重试:', id);
      } else {
        this.logger.log?.('[公告轮询] 公告已交给软件界面:', id);
      }
    } catch (error) {
      current.delete(id);
      this.logger.warn?.('[公告轮询] 下发公告到侧边栏失败:', error?.message || error);
    }
  }

  finishPoll() {
    this.inFlight = false;
    if (!this.pendingPoll) return;
    this.pendingPoll = false;
    void this.pollOnce();
  }

  start() {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => { void this.pollOnce(); }, this.intervalMs);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  getApi() {
    return {
      start: () => this.start(),
      stop: () => this.stop(),
      refreshNow: () => this.pollOnce(),
    };
  }
}

/** @param {Record<string, any>} [options] */
function createAnnouncementPoller(options = {}) {
  return new AnnouncementPoller(options).getApi();
}

module.exports = { createAnnouncementPoller };
