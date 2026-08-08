'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createAiChatService,
  waitForBrowserConnection,
} = require('../../../src/app/main/features/ai-chat/ai-chat-service');

function eventFixture(id = 1) {
  const sent = [];
  return {
    sent,
    event: {
      sender: {
        id,
        isDestroyed: () => false,
        send: (channel, payload) => sent.push({ channel, payload }),
      },
    },
  };
}

function createService(client, overrides = {}) {
  return createAiChatService({
    readStoreConfigSafe: () => ({ userCredentials: { sessionToken: 'key', deviceId: 'device' } }),
    getGlobalHttpClient: () => client,
    licenseCache: { getSnapshot: () => ({}) },
    logger: { warn() {} },
    ...overrides,
  });
}

test('等待新窗口对应的自动化 MCP 连接后返回完整连接', async () => {
  const connection = { id: 'mcp-1', name: '新窗口', tools: [{ name: 'browser_tab' }] };
  const found = await waitForBrowserConnection({
    browserAutomationBridge: {
      listConnections: () => [connection],
      getConnection: () => connection,
    },
    getTabs: () => [],
    browserRuntimeManager: { listStates: () => [] },
  }, { name: '新窗口' }, 100);
  assert.equal(found.id, 'mcp-1');
});

test('AI 默认工具包含 AI-Workspace 命令执行入口', async (t) => {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-chat-workspace-'));
  t.after(() => fs.rmSync(sandboxDir, { recursive: true, force: true }));
  const service = createService({}, {
    aiSandboxDir: sandboxDir,
    browserWindowUi: { getTabs: () => new Map() },
  });
  const tools = service.getWindowTools();
  assert.equal(tools.has('run_command'), true);
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['windows_tab', 'run_command']);
  const command = process.platform === 'win32' ? 'echo ready' : 'printf ready';
  assert.match((await tools.execute('run_command', { command })).stdout, /ready/);
});

test('内置模型正常返回完整消息链并发布流式完成事件', async () => {
  const client = {
    sendAIControlMessage: async () => ({ ok: true, quota: { remaining: 9 }, message: { role: 'assistant', content: '完成' } }),
  };
  const service = createService(client);
  const fixture = eventFixture();
  const result = await service.chat(fixture.event, {
    modelId: 'builtin',
    messages: [{ role: 'user', content: '开始' }],
    disableTools: true,
    stream: true,
    requestId: 'request-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.messages.at(-1).content, '完成');
  assert.equal(result.quota.remaining, 9);
  assert.equal(fixture.sent.at(-1).payload.type, 'done');
});

test('提示词诊断返回下一次预览和最近一次实际发送的完整请求', async () => {
  const client = {
    sendAIControlMessage: async () => ({
      ok: true,
      message: { role: 'assistant', content: '完成' },
    }),
  };
  const service = createService(client);
  await service.chat(eventFixture().event, {
    modelId: 'builtin',
    messages: [{ role: 'user', content: '检查提示词' }],
    disableTools: true,
  });

  const diagnostics = service.getPromptDiagnostics(eventFixture().event, {
    modelId: 'builtin',
    messages: [{ role: 'user', content: '下一条消息' }],
  });

  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.preview.messages.at(-1).content, '下一条消息');
  assert.equal(diagnostics.lastRequest.modelId, 'builtin');
  assert.equal(diagnostics.lastRequest.messages.at(-1).content, '检查提示词');
  assert.equal(Array.isArray(diagnostics.lastRequest.tools), true);
});

test('额度耗尽时不调用模型服务', async () => {
  let calls = 0;
  const service = createService({ sendAIControlMessage: async () => { calls += 1; return { ok: true }; } });
  const result = await service.chat(eventFixture().event, {
    modelId: 'builtin',
    quota: { quota: 1, used: 1 },
    messages: [{ role: 'user', content: '开始' }],
    disableTools: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /额度已用尽/);
  assert.equal(calls, 0);
});

test('身份失效时通过已绑定设备刷新凭据并只重试当前模型请求', async () => {
  const credentials = { sessionToken: 'old-key', deviceId: 'device' };
  const calls = [];
  let recoveryCalls = 0;
  const client = {
    sendAIControlMessage: async (key, deviceId) => {
      calls.push([key, deviceId]);
      return calls.length === 1
        ? { ok: false, status: 403, message: '登录状态无效，请重新登录' }
        : { ok: true, message: { role: 'assistant', content: '已恢复' } };
    },
  };
  const service = createService(client, {
    readStoreConfigSafe: () => ({ userCredentials: credentials }),
    accountService: {
      authenticate: async ({ mode }) => {
        assert.equal(mode, 'device');
        recoveryCalls += 1;
        credentials.sessionToken = 'new-key';
        return { ok: true };
      },
    },
  });
  const result = await service.chat(eventFixture().event, {
    modelId: 'builtin', messages: [{ role: 'user', content: '开始' }], disableTools: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.message.content, '已恢复');
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(calls, [['old-key', 'device'], ['new-key', 'device']]);
});

test('流式输出可停止并保留已到达的部分内容，完成后连续停止幂等', async () => {
  const client = {
    sendAIControlMessage: async () => ({ ok: true }),
    streamAIControlMessage: async (_key, _device, _model, _messages, options, onEvent) => {
      onEvent({ type: 'content_delta', delta: '部分结果' });
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('stopped');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  };
  const service = createService(client);
  const fixture = eventFixture(8);
  const pending = service.chat(fixture.event, {
    modelId: 'builtin', messages: [{ role: 'user', content: '开始' }],
    disableTools: true, stream: true, requestId: 'stop-me',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await service.stop(fixture.event, { requestId: 'stop-me' }), { ok: true, stopped: true });
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(result.message.content, '部分结果');
  assert.deepEqual(await service.stop(fixture.event, { requestId: 'stop-me' }), { ok: true, stopped: false });
});
