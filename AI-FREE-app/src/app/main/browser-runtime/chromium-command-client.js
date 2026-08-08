const crypto = require('crypto');
const net = require('net');
const { EventEmitter } = require('events');

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_COMMANDS = new Set([
  'navigate', 'reload', 'open-tabs', 'list-tabs', 'activate-tab', 'dispatch-input', 'close-browser',
  'set-cookies', 'set-storage', 'clear-session', 'select-files',
  'observe-page', 'capture-screenshot', 'perform-action', 'get-session-data',
]);

function runtimeBridgeError(code, message) {
  const error = /** @type {Error & {code?: string, command?: string}} */ (new Error(String(message || code || 'Runtime Bridge 命令失败')));
  error.code = String(code || 'RUNTIME_BRIDGE_ERROR');
  return error;
}

function createPipeName(profileId) {
  const safeId = String(profileId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return `\\\\.\\pipe\\ai-free-runtime-${process.pid}-${safeId}-${crypto.randomBytes(6).toString('hex')}`;
}

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_MESSAGE_BYTES) throw new Error('Runtime Bridge 消息过大');
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

class ChromiumCommandClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.profileId = String(options.profileId || '').trim();
    this.pipeName = options.pipeName || createPipeName(this.profileId);
    this.launchToken = String(options.launchToken || crypto.randomBytes(32).toString('hex'));
    this.expectedPid = Number(options.expectedPid || 0);
    this.logger = options.logger || console;
    this.server = null;
    this.socket = null;
    this.sessionId = '';
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.requestSequence = 0;
    this.handshakeComplete = false;
    this.lastHello = null;
  }

  setExpectedPid(pid) { this.expectedPid = Number(pid || 0); }

  async listen() {
    if (this.server) return this.pipeName;
    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.on('error', (error) => this.emit('error', error));
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server?.off('listening', onListening); reject(error); };
      const onListening = () => { this.server?.off('error', onError); resolve(undefined); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.pipeName);
    });
    return this.pipeName;
  }

  handleConnection(socket) {
    if (this.socket && !this.socket.destroyed) {
      socket.destroy(new Error('Runtime Bridge 已有活动连接'));
      return;
    }
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('close', () => {
      this.socket = null;
      this.handshakeComplete = false;
      this.rejectPending(new Error('Runtime Bridge 连接已关闭'));
      this.emit('disconnected');
    });
    socket.on('error', (error) => this.emit('socket-error', error));
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length <= 0 || length > MAX_MESSAGE_BYTES) {
        this.socket?.destroy(new Error('非法 Runtime Bridge 帧长度'));
        return;
      }
      if (this.buffer.length < length + 4) return;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let message;
      try { message = JSON.parse(body.toString('utf8')); } catch (_) {
        this.socket?.destroy(new Error('Runtime Bridge JSON 无效'));
        return;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message = {}) {
    if (!this.handshakeComplete) return this.handleHandshake(message);
    if (!this.isCurrentSessionMessage(message)) return;
    if (this.resolvePendingMessage(message)) return;
    this.emit('event', message);
    this.emit(String(message.type || 'message'), message);
  }

  handleHandshake(message) {
    const rejection = this.getHandshakeRejection(message);
    if (rejection) return this.rejectHandshake(rejection);
    this.launchToken = '';
    this.sessionId = crypto.randomUUID();
    this.handshakeComplete = true;
    this.lastHello = { ...message, sessionId: this.sessionId };
    this.sendRaw({
      type: 'hello-accepted', protocolVersion: PROTOCOL_VERSION,
      profileId: this.profileId, sessionId: this.sessionId, heartbeatIntervalMs: 3000,
    });
    this.emit('hello', this.lastHello);
  }

  getHandshakeRejection(message) {
    if (message.type !== 'hello') return '首条消息必须是 hello';
    if (Number(message.protocolVersion) !== PROTOCOL_VERSION) return '协议版本不匹配';
    if (String(message.profileId || '') !== this.profileId) return 'Profile ID 不匹配';
    if (String(message.launchToken || '') !== this.launchToken) return '启动令牌错误';
    if (this.expectedPid > 0 && Number(message.pid) !== this.expectedPid) return 'Chromium PID 不匹配';
    return '';
  }

  isCurrentSessionMessage(message) {
    return Number(message.protocolVersion) === PROTOCOL_VERSION
      && String(message.profileId || '') === this.profileId
      && String(message.sessionId || '') === this.sessionId;
  }

  resolvePendingMessage(message) {
    if (!message.requestId || !this.pending.has(message.requestId)) return false;
    const pending = this.pending.get(message.requestId);
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok === false || message.error) {
      const details = message.error && typeof message.error === 'object' ? message.error : {};
      pending.reject(runtimeBridgeError(details.code, details.message || message.error));
    } else pending.resolve(message);
    return true;
  }

  rejectHandshake(reason) {
    try { this.sendRaw({ type: 'hello-rejected', protocolVersion: PROTOCOL_VERSION, reason }); } catch (_) {}
    this.socket?.destroy(new Error(reason));
    this.emit('handshake-rejected', reason);
  }

  sendRaw(message) {
    if (!this.socket || this.socket.destroyed) throw new Error('Runtime Bridge 未连接');
    this.socket.write(encodeFrame(message));
  }

  send(type, payload = {}, options = {}) {
    if (!this.handshakeComplete) return Promise.reject(new Error('Runtime Bridge 尚未完成握手'));
    if (!ALLOWED_COMMANDS.has(String(type || ''))) return Promise.reject(runtimeBridgeError('COMMAND_NOT_ALLOWED', `Runtime Bridge 命令不在白名单: ${type}`));
    const requestId = `${process.pid}-${Date.now()}-${++this.requestSequence}`;
    const message = {
      ...payload,
      type,
      protocolVersion: PROTOCOL_VERSION,
      profileId: this.profileId,
      sessionId: this.sessionId,
      requestId,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = runtimeBridgeError('RUNTIME_COMMAND_TIMEOUT', `Runtime Bridge 命令超时: ${type}`);
        error.command = String(type || '');
        reject(error);
      }, Math.max(100, Number(options.timeoutMs) || 5000));
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.sendRaw(message); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    this.rejectPending(new Error('Runtime Bridge 已关闭'));
    if (this.socket) this.socket.destroy();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  }
}

module.exports = { ALLOWED_COMMANDS, ChromiumCommandClient, MAX_MESSAGE_BYTES, PROTOCOL_VERSION, createPipeName, encodeFrame };
