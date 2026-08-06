/**
 * AI 对话历史本地存储（按登录账号隔离）
 */
const crypto = require('crypto');
const path = require('path');
const { app } = require('electron');
const { readJsonFileSafe, writeJsonFileSafe } = require('../utils/json-store');

function accountScope(credentials = {}) {
  const key = String(credentials.key || credentials.credential || '').trim();
  const username = String(credentials.username || '').trim();
  const deviceId = String(credentials.deviceId || credentials.device_id || '').trim();
  const seed = [key, username, deviceId].filter(Boolean).join('|') || 'anonymous';
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 20);
}

function historyFilePath(scope) {
  let base = '';
  try {
    base = app?.getPath ? app.getPath('userData') : '';
  } catch (_) {
    base = '';
  }
  if (!base) base = path.join(__dirname, '../../../../');
  return path.join(base, 'ai-chat-history', `${scope || 'anonymous'}.json`);
}

function emptyStore() {
  return { version: 1, sessions: [], currentId: '' };
}

function readStore(scope) {
  const data = readJsonFileSafe(historyFilePath(scope), {
    fallback: emptyStore(),
    logPrefix: 'AIHistory',
  });
  if (!data || typeof data !== 'object') return emptyStore();
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  return {
    version: 1,
    sessions,
    currentId: String(data.currentId || ''),
  };
}

function writeStore(scope, store) {
  return writeJsonFileSafe(historyFilePath(scope), store, {
    logPrefix: 'AIHistory',
  });
}

const DEFAULT_HISTORY_CONTEXT = Object.freeze({
  accountScope,
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
  readStore,
  writeStore,
});

function normalizeHistoryContext(options = {}) {
  return {
    accountScope: options.accountScope || DEFAULT_HISTORY_CONTEXT.accountScope,
    now: options.now || DEFAULT_HISTORY_CONTEXT.now,
    randomUUID: options.randomUUID || DEFAULT_HISTORY_CONTEXT.randomUUID,
    readStore: options.readStore || DEFAULT_HISTORY_CONTEXT.readStore,
    writeStore: options.writeStore || DEFAULT_HISTORY_CONTEXT.writeStore,
  };
}

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const messages = [];
  for (const item of raw) {
    const message = sanitizeMessage(item);
    if (message) messages.push(message);
  }
  return messages;
}

function sanitizeMessage(item) {
  if (!item || typeof item !== 'object') return null;
  const role = String(item.role || '').trim().toLowerCase();
  if (!['system', 'user', 'assistant', 'tool'].includes(role)) return null;
  const message = {
    role,
    content: typeof item.content === 'string' ? item.content : String(item.content || ''),
  };
  if (role === 'assistant') appendAssistantHistory(message, item);
  if (role === 'tool') appendToolHistory(message, item);
  return message;
}

function appendAssistantHistory(message, item) {
  if (Array.isArray(item.tool_calls) && item.tool_calls.length) message.tool_calls = item.tool_calls;
  if (typeof item.reasoning === 'string') message.reasoning = item.reasoning;
  if (Array.isArray(item.tool_events)) {
    message.tool_events = item.tool_events.map(sanitizeToolEvent);
  }
  if (Array.isArray(item.trace_events)) {
    message.trace_events = item.trace_events.map(sanitizeTraceEvent);
  }
}

function compactHistoryValue(value) {
  let text = '';
  try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch (_) { text = String(value ?? ''); }
  if (typeof text !== 'string') text = String(value ?? '');
  return text;
}

function sanitizeToolEvent(entry) {
  return {
    id: String(entry?.id || ''),
    name: String(entry?.name || '工具'),
    status: String(entry?.status || 'success'),
    arguments: compactHistoryValue(entry?.arguments),
    result: compactHistoryValue(entry?.result),
  };
}

function sanitizeTraceEvent(entry, index) {
  const type = normalizeTraceType(entry);
  if (type !== 'tool') {
    return sanitizeTextTraceEvent(entry, type);
  }
  return sanitizeToolTraceEvent(entry, index, type);
}

function normalizeTraceType(entry) {
  return ['reasoning', 'tool', 'step'].includes(entry?.type) ? entry.type : 'step';
}

function sanitizeTextTraceEvent(entry, type) {
  return { type, round: Number(entry?.round) || 0, content: String(entry?.content || '') };
}

function sanitizeToolTraceEvent(entry, index, type) {
  return {
    type,
    round: Number(entry?.round) || 0,
    tool: sanitizeTraceTool(entry?.tool, index),
  };
}

function sanitizeTraceTool(tool, index) {
  return {
    id: String(tool?.id || `tool-${index}`),
    name: String(tool?.name || '工具'),
    status: String(tool?.status || 'success'),
    arguments: compactHistoryValue(tool?.arguments),
    result: compactHistoryValue(tool?.result),
  };
}

function appendToolHistory(message, item) {
  message.tool_call_id = String(item.tool_call_id || '');
  if (item.name) message.name = String(item.name);
}

function previewFromMessages(messages) {
  const firstUser = (messages || []).find((m) => m.role === 'user' && String(m.content || '').trim());
  if (!firstUser) return '';
  return String(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 80);
}

function normalizeBrowserConnectionIds(raw = {}) {
  const list = Array.isArray(raw.browserConnectionIds)
    ? raw.browserConnectionIds
    : (raw.browserConnectionId ? [raw.browserConnectionId] : []);
  return [...new Set(list.map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeSession(raw = {}, context = DEFAULT_HISTORY_CONTEXT) {
  const id = String(raw.id || '').trim() || context.randomUUID();
  const messages = sanitizeMessages(raw.messages);
  const title = String(raw.title || '').trim() || '新对话';
  const now = context.now();
  const browserConnectionIds = normalizeBrowserConnectionIds(raw);
  return {
    id,
    title: title.slice(0, 40),
    titleGenerated: raw.titleGenerated === true,
    modelId: String(raw.modelId || '').trim(),
    browserConnectionId: browserConnectionIds[0] || '',
    browserConnectionIds,
    automationCardId: String(raw.automationCardId || '').trim(),
    messages,
    preview: String(raw.preview || previewFromMessages(messages) || '').slice(0, 80),
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
  };
}

function sessionSummary(session) {
  return {
    id: session.id,
    title: session.title,
    titleGenerated: session.titleGenerated === true,
    modelId: session.modelId || '',
    browserConnectionId: session.browserConnectionId || '',
    browserConnectionIds: Array.isArray(session.browserConnectionIds) ? session.browserConnectionIds : [],
    automationCardId: session.automationCardId || '',
    preview: session.preview || '',
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function listSessions(credentials, context = DEFAULT_HISTORY_CONTEXT) {
  const scope = context.accountScope(credentials);
  const store = context.readStore(scope);
  const sessions = store.sessions
    .map((item) => normalizeSession(item, context))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(sessionSummary);
  return {
    ok: true,
    sessions,
    currentId: store.currentId || (sessions[0]?.id || ''),
  };
}

function getSession(credentials, sessionId, context = DEFAULT_HISTORY_CONTEXT) {
  const scope = context.accountScope(credentials);
  const store = context.readStore(scope);
  const id = String(sessionId || '').trim();
  const found = store.sessions.find((item) => String(item.id) === id);
  if (!found) return { ok: false, message: '对话不存在' };
  const session = normalizeSession(found, context);
  store.currentId = session.id;
  context.writeStore(scope, store);
  return { ok: true, session };
}

function saveSession(credentials, rawSession, options = {}, context = DEFAULT_HISTORY_CONTEXT) {
  const scope = context.accountScope(credentials);
  const store = context.readStore(scope);
  const session = normalizeSession(rawSession, context);
  session.preview = previewFromMessages(session.messages) || session.preview || '';
  session.updatedAt = context.now();

  // 无消息的空会话不落盘；已有会话被删空时，同时移除旧记录。
  if (!session.messages.length && options.allowEmpty !== true) {
    return removeEmptySession(scope, store, session, context);
  }

  const index = store.sessions.findIndex((item) => String(item.id) === session.id);
  if (index >= 0) store.sessions[index] = session;
  else store.sessions.unshift(session);

  store.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  // 清理无消息的脏数据
  store.sessions = store.sessions.filter((item) => {
    const msgs = Array.isArray(item.messages) ? item.messages : [];
    return msgs.length > 0 || String(item.id) === session.id;
  });
  if (options.setCurrent !== false) store.currentId = session.id;
  const written = context.writeStore(scope, store);
  if (!written) {
    return { ok: false, message: '对话历史写入本地失败', session, summary: sessionSummary(session) };
  }
  return { ok: true, session, summary: sessionSummary(session) };
}

function removeEmptySession(scope, store, session, context) {
  const existingIndex = store.sessions.findIndex((item) => String(item.id) === session.id);
  if (existingIndex < 0) return { ok: true, session, summary: sessionSummary(session), skipped: true };
  store.sessions.splice(existingIndex, 1);
  if (store.currentId === session.id) store.currentId = store.sessions[0]?.id || '';
  const written = context.writeStore(scope, store);
  if (!written) {
    return { ok: false, message: '对话历史写入本地失败', session, summary: sessionSummary(session) };
  }
  return { ok: true, session, summary: sessionSummary(session), removed: true, currentId: store.currentId };
}

function deleteSession(credentials, sessionId, context = DEFAULT_HISTORY_CONTEXT) {
  const scope = context.accountScope(credentials);
  const store = context.readStore(scope);
  const id = String(sessionId || '').trim();
  const before = store.sessions.length;
  store.sessions = store.sessions.filter((item) => String(item.id) !== id);
  if (store.sessions.length === before) {
    return { ok: false, message: '对话不存在' };
  }
  if (store.currentId === id) {
    store.currentId = store.sessions[0]?.id || '';
  }
  const written = context.writeStore(scope, store);
  if (!written) {
    return { ok: false, message: '对话历史写入本地失败' };
  }
  return {
    ok: true,
    currentId: store.currentId,
    sessions: store.sessions
      .map((item) => normalizeSession(item, context))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(sessionSummary),
  };
}

function renameSession(credentials, sessionId, rawTitle, context = DEFAULT_HISTORY_CONTEXT) {
  const scope = context.accountScope(credentials);
  const store = context.readStore(scope);
  const id = String(sessionId || '').trim();
  const title = String(rawTitle || '').trim().slice(0, 40);
  if (!title) return { ok: false, message: '对话名称不能为空' };
  const index = store.sessions.findIndex((item) => String(item.id) === id);
  if (index < 0) return { ok: false, message: '对话不存在' };

  const session = normalizeSession(store.sessions[index], context);
  session.title = title;
  // 手动命名后不再让自动标题生成覆盖用户输入。
  session.titleGenerated = true;
  store.sessions[index] = session;
  const written = context.writeStore(scope, store);
  if (!written) return { ok: false, message: '对话历史写入本地失败' };
  return { ok: true, session, summary: sessionSummary(session) };
}

function createSession(credentials, partial = {}, context = DEFAULT_HISTORY_CONTEXT) {
  // 空会话只返回内存对象，真正有消息后再 saveSession 落盘
  const session = normalizeSession({
    id: context.randomUUID(),
    title: '新对话',
    titleGenerated: false,
    modelId: partial.modelId || '',
    browserConnectionId: partial.browserConnectionId || '',
    browserConnectionIds: Array.isArray(partial.browserConnectionIds) ? partial.browserConnectionIds : [],
    automationCardId: partial.automationCardId || '',
    messages: [],
    createdAt: context.now(),
    updatedAt: context.now(),
  }, context);
  const scope = context.accountScope(credentials);
  const store = context.readStore(scope);
  store.currentId = session.id;
  context.writeStore(scope, store);
  return { ok: true, session, summary: sessionSummary(session) };
}

function setCurrent(credentials, sessionId, context = DEFAULT_HISTORY_CONTEXT) {
  const scope = context.accountScope(credentials);
  const store = context.readStore(scope);
  const id = String(sessionId || '').trim();
  if (id && !store.sessions.some((item) => String(item.id) === id)) {
    return { ok: false, message: '对话不存在' };
  }
  store.currentId = id;
  context.writeStore(scope, store);
  return { ok: true, currentId: id };
}

function provisionalTitleFromText(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '新对话';
  return cleaned.slice(0, 20) + (cleaned.length > 20 ? '…' : '');
}

function createAiChatHistoryRepository(options = {}) {
  const context = normalizeHistoryContext(options);
  return {
    createSession: (credentials, partial) => createSession(credentials, partial, context),
    deleteSession: (credentials, id) => deleteSession(credentials, id, context),
    getSession: (credentials, id) => getSession(credentials, id, context),
    listSessions: (credentials) => listSessions(credentials, context),
    renameSession: (credentials, id, title) => renameSession(credentials, id, title, context),
    saveSession: (credentials, session, options) => saveSession(credentials, session, options, context),
    setCurrent: (credentials, id) => setCurrent(credentials, id, context),
  };
}

module.exports = {
  createAiChatHistoryRepository,
  listSessions,
  getSession,
  saveSession,
  deleteSession,
  renameSession,
  createSession,
  setCurrent,
  normalizeSession,
  provisionalTitleFromText,
};
