'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAiChatHistoryRepository } = require('../../../src/app/main/features/ai-chat/history-repository');

function fixture({ writeResult = true } = {}) {
  let store = { version: 1, sessions: [], currentId: '' };
  let id = 0;
  let now = 1000;
  const repository = createAiChatHistoryRepository({
    accountScope: (credentials) => `scope:${credentials.username || 'anonymous'}`,
    randomUUID: () => `session-${++id}`,
    now: () => ++now,
    readStore: () => structuredClone(store),
    writeStore: (_scope, value) => {
      if (writeResult) store = structuredClone(value);
      return writeResult;
    },
  });
  return { repository, read: () => structuredClone(store) };
}

test('历史创建保持内存空会话，首次消息保存后可读取、重命名和删除', () => {
  const data = fixture();
  const credentials = { username: 'alice' };
  const created = data.repository.createSession(credentials, { modelId: 'model', browserConnectionIds: ['one', 'two'] });
  assert.equal(created.session.id, 'session-1');
  assert.equal(data.read().sessions.length, 0);
  const saved = data.repository.saveSession(credentials, {
    ...created.session,
    messages: [{ role: 'user', content: '第一条消息' }, { role: 'assistant', content: '回答' }],
  });
  assert.equal(saved.ok, true);
  assert.equal(data.repository.getSession(credentials, created.session.id).session.messages.length, 2);
  assert.equal(data.repository.renameSession(credentials, created.session.id, '手工标题').summary.title, '手工标题');
  assert.equal(data.repository.deleteSession(credentials, created.session.id).sessions.length, 0);
});

test('消息持久化保留全部合法消息并过滤非法角色', () => {
  const data = fixture();
  const messages = Array.from({ length: 45 }, (_, index) => ({ role: 'user', content: `message-${index}` }));
  messages.push({ role: 'admin', content: 'not-allowed' });
  const result = data.repository.saveSession({}, { id: 'bounded', messages });
  assert.equal(result.session.messages.length, 45);
  assert.equal(result.session.messages[0].content, 'message-0');
  assert.equal(result.session.messages.some((message) => message.role === 'admin'), false);
});

test('空会话不落盘，已有会话删空会删除；写入失败不报告成功', () => {
  const data = fixture();
  assert.equal(data.repository.saveSession({}, { id: 'empty', messages: [] }).skipped, true);
  data.repository.saveSession({}, { id: 'one', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(data.repository.saveSession({}, { id: 'one', messages: [] }).removed, true);
  const failed = fixture({ writeResult: false });
  assert.equal(failed.repository.saveSession({}, { id: 'failed', messages: [{ role: 'user', content: 'x' }] }).ok, false);
});

test('账号 scope 隔离由注入边界执行，不会跨账号返回会话', () => {
  const stores = new Map();
  const repository = createAiChatHistoryRepository({
    accountScope: ({ username }) => username,
    randomUUID: () => 'id',
    now: () => 1,
    readStore: (scope) => structuredClone(stores.get(scope) || { version: 1, sessions: [], currentId: '' }),
    writeStore: (scope, value) => { stores.set(scope, structuredClone(value)); return true; },
  });
  repository.saveSession({ username: 'alice' }, { id: 'alice-chat', messages: [{ role: 'user', content: 'secret' }] });
  assert.equal(repository.listSessions({ username: 'alice' }).sessions.length, 1);
  assert.equal(repository.listSessions({ username: 'bob' }).sessions.length, 0);
});

test('历史仓库保留超过 80 个非空会话', () => {
  const data = fixture();
  for (let index = 0; index < 85; index += 1) {
    data.repository.saveSession({}, {
      id: `session-${index}`,
      messages: [{ role: 'user', content: `message-${index}` }],
    });
  }

  assert.equal(data.repository.listSessions({}).sessions.length, 85);
});
