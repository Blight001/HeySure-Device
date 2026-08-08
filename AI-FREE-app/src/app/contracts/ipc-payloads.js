// IPC 请求 payload 运行时校验（阶段 2）。
// schema 只描述进程边界允许接收的形状；业务必填、权限和状态规则仍由 domain/service 判断。
// 校验错误不记录实际字段值，避免 API Key、Cookie、礼品码等敏感内容进入日志。
'use strict';

const { AppError } = require('./ipc-result');
const { getRequestSchema } = require('./ipc-channels');

const MAX_ID_LENGTH = 512;
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;
const MAX_LIST_LENGTH = 128;
const AUTOMATION_CARD_ACTIONS = new Set([
  'rules', 'list', 'get', 'write', 'patch_step', 'insert_step',
  'delete_step', 'move_step', 'delete', 'run',
]);

class IpcPayloadError extends AppError {
  constructor(channel, path, reason) {
    const field = path || 'payload';
    super('IPC_INVALID_PAYLOAD', `请求参数无效：${field} ${reason}`, {
      retryable: false,
      details: { channel, path: field, reason },
    });
    this.name = 'IpcPayloadError';
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(channel, path, reason) {
  throw new IpcPayloadError(channel, path, reason);
}

function objectPayload(channel, payload, { optional = false } = {}) {
  if (payload === undefined && optional) return {};
  if (!isPlainObject(payload)) fail(channel, 'payload', '必须是对象');
  return payload;
}

function stringField(channel, object, key, options = {}) {
  const { required = false, maxLength = MAX_ID_LENGTH, path = key } = options;
  const value = object[key];
  if (value === undefined && !required) return;
  if (typeof value !== 'string') fail(channel, path, '必须是字符串');
  if (value.length > maxLength) fail(channel, path, `长度不能超过 ${maxLength}`);
}

function booleanField(channel, object, key) {
  if (object[key] !== undefined && typeof object[key] !== 'boolean') {
    fail(channel, key, '必须是布尔值');
  }
}

function stringListField(channel, object, key) {
  const list = object[key];
  if (list === undefined) return;
  if (!Array.isArray(list)) fail(channel, key, '必须是数组');
  if (list.length > MAX_LIST_LENGTH) fail(channel, key, `数量不能超过 ${MAX_LIST_LENGTH}`);
  if (list.some((item) => typeof item !== 'string' || item.length > MAX_ID_LENGTH)) {
    fail(channel, `${key}[]`, `必须是长度不超过 ${MAX_ID_LENGTH} 的字符串`);
  }
}

function numberLikeField(channel, object, key) {
  const value = object[key];
  if (value === undefined) return;
  if ((typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(Number(value))) {
    fail(channel, key, '必须是有效数字');
  }
}

function validateChatMessage(channel, message, index) {
  const path = `messages[${index}]`;
  if (!isPlainObject(message)) fail(channel, path, '必须是对象');
  stringField(channel, message, 'role', { maxLength: 32, path: `${path}.role` });
  if (message.content !== undefined && typeof message.content !== 'string' && !Array.isArray(message.content)) {
    fail(channel, `${path}.content`, '必须是字符串或数组');
  }
  for (const key of ['tool_call_id', 'name', 'reasoning']) {
    stringField(channel, message, key, {
      maxLength: key === 'reasoning' ? MAX_TEXT_LENGTH : MAX_ID_LENGTH,
      path: `${path}.${key}`,
    });
  }
  for (const key of ['tool_calls', 'tool_events', 'trace_events']) {
    if (message[key] === undefined) continue;
    if (!Array.isArray(message[key])) fail(channel, `${path}.${key}`, '必须是数组');
  }
}

function validateHistorySession(channel, session) {
  if (!isPlainObject(session)) fail(channel, 'session', '必须是对象');
  for (const key of ['id', 'title', 'modelId', 'browserConnectionId', 'automationCardId', 'preview']) {
    stringField(channel, session, key, { maxLength: key === 'preview' ? MAX_TEXT_LENGTH : MAX_ID_LENGTH });
  }
  stringListField(channel, session, 'browserConnectionIds');
  if (session.messages !== undefined) {
    if (!Array.isArray(session.messages)) fail(channel, 'session.messages', '必须是数组');
  }
}

const IPC_PAYLOAD_SCHEMAS = Object.freeze({
  'account.authenticate': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'mode', { maxLength: 32 });
    stringField(channel, input, 'username', { maxLength: 256 });
    stringField(channel, input, 'password', { maxLength: 4096 });
    return input;
  },
  'account.gift-code': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'code', { maxLength: 512 });
    return input;
  },
  'ai.browser-selection': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'profileId');
    stringListField(channel, input, 'profileIds');
    return input;
  },
  'ai.card-selection': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'id');
    return input;
  },
  'ai.chat': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    for (const key of ['modelId', 'requestId', 'browserConnectionId', 'automationCardId']) {
      stringField(channel, input, key);
    }
    stringListField(channel, input, 'browserConnectionIds');
    for (const key of ['disableTools', 'stream']) booleanField(channel, input, key);
    if (input.quota !== undefined && input.quota !== null && !isPlainObject(input.quota)) {
      fail(channel, 'quota', '必须是对象或 null');
    }
    if (input.messages !== undefined) {
      if (!Array.isArray(input.messages)) fail(channel, 'messages', '必须是数组');
      input.messages.forEach((message, index) => validateChatMessage(channel, message, index));
    }
    return input;
  },
  'ai.chat-insert': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'requestId');
    stringField(channel, input, 'content', { maxLength: MAX_TEXT_LENGTH });
    return input;
  },
  'ai.chat-stop': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'requestId');
    return input;
  },
  'ai.prompt-diagnostics': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    for (const key of ['modelId', 'browserConnectionId', 'automationCardId']) {
      stringField(channel, input, key);
    }
    stringListField(channel, input, 'browserConnectionIds');
    if (input.messages !== undefined) {
      if (!Array.isArray(input.messages)) fail(channel, 'messages', '必须是数组');
      input.messages.forEach((message, index) => validateChatMessage(channel, message, index));
    }
    return input;
  },
  'ai.gift-code': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'code');
    return input;
  },
  'ai.custom-api': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    for (const key of ['clear', 'enabled']) booleanField(channel, input, key);
    stringField(channel, input, 'name', { maxLength: 80 });
    stringField(channel, input, 'baseUrl', { maxLength: 2048 });
    stringField(channel, input, 'model', { maxLength: 200 });
    stringField(channel, input, 'apiKey', { maxLength: 4096 });
    return input;
  },
  'ai.server-device-login': (channel, payload) => {
    const input = objectPayload(channel, payload);
    stringField(channel, input, 'server', { maxLength: 2048 });
    stringField(channel, input, 'account', { maxLength: 200 });
    stringField(channel, input, 'password', { maxLength: 4096 });
    stringField(channel, input, 'serviceName', { maxLength: 80 });
    return input;
  },
  'ai.history-create': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    for (const key of ['modelId', 'browserConnectionId', 'automationCardId']) stringField(channel, input, key);
    stringListField(channel, input, 'browserConnectionIds');
    return input;
  },
  'ai.history-id': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'id');
    return input;
  },
  'ai.history-rename': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'id');
    stringField(channel, input, 'title', { maxLength: MAX_TEXT_LENGTH });
    return input;
  },
  'ai.history-save': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    booleanField(channel, input, 'setCurrent');
    validateHistorySession(channel, input.session === undefined ? input : input.session);
    return input;
  },
  'ai.settings': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    numberLikeField(channel, input, 'mcpCallLimit');
    return input;
  },
  'ui.window-close-behavior': (channel, payload) => {
    const input = objectPayload(channel, payload);
    stringField(channel, input, 'behavior', { required: true, maxLength: 8 });
    if (!['ask', 'hide', 'quit'].includes(input.behavior)) {
      fail(channel, 'behavior', '必须是 ask、hide 或 quit');
    }
    return input;
  },
  'ui.sidebar-width': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    numberLikeField(channel, input, 'width');
    return input;
  },
  'ai.automation-card-operation': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'action', { required: true, maxLength: 32 });
    if (!AUTOMATION_CARD_ACTIONS.has(input.action)) fail(channel, 'action', '不是受支持的卡片操作');
    for (const key of ['connectionId', 'id', 'card_name']) stringField(channel, input, key);
    for (const key of ['cardData', 'stepData', 'stepPatch', 'inputs']) {
      if (input[key] !== undefined && !isPlainObject(input[key]) && !Array.isArray(input[key])) {
        fail(channel, key, '必须是对象或数组');
      }
    }
    for (const key of ['step_index', 'to_step_index', 'start_step']) numberLikeField(channel, input, key);
    booleanField(channel, input, 'replace');
    return input;
  },
  'ai.automation-session': (channel, payload) => {
    const input = objectPayload(channel, payload, { optional: true });
    stringField(channel, input, 'connectionId');
    stringField(channel, input, 'format', { maxLength: 16 });
    return input;
  },
});

function hasIpcPayloadSchema(schemaName) {
  return typeof IPC_PAYLOAD_SCHEMAS[schemaName] === 'function';
}

function validateIpcPayload(channel, payload) {
  const schemaName = getRequestSchema(channel);
  if (!schemaName) return payload;
  const schema = IPC_PAYLOAD_SCHEMAS[schemaName];
  if (!schema) throw new Error(`IPC 通道 '${channel}' 引用了未登记 schema '${schemaName}'`);
  return schema(channel, payload);
}

function wrapLegacyIpcPayload(channel, handler) {
  return async (event, payload, ...rest) => {
    try {
      const validated = validateIpcPayload(channel, payload);
      return await handler(event, validated, ...rest);
    } catch (error) {
      if (!(error instanceof IpcPayloadError)) throw error;
      return { ok: false, code: error.code, message: error.message };
    }
  };
}

function wrapLegacyIpcEventPayload(channel, listener, logger = console) {
  return (event, payload, ...rest) => {
    try {
      const validated = validateIpcPayload(channel, payload);
      return listener(event, validated, ...rest);
    } catch (error) {
      if (!(error instanceof IpcPayloadError)) throw error;
      /** @type {{ path?: string, reason?: string }} */
      const details = error.details && typeof error.details === 'object' ? error.details : {};
      logger.warn?.(`[IPC] ${channel} 请求参数校验失败`, {
        channel,
        errorCode: error.code,
        path: details.path,
        reason: details.reason,
      });
      return undefined;
    }
  };
}

module.exports = {
  IPC_PAYLOAD_SCHEMAS,
  IpcPayloadError,
  hasIpcPayloadSchema,
  validateIpcPayload,
  wrapLegacyIpcPayload,
  wrapLegacyIpcEventPayload,
};
