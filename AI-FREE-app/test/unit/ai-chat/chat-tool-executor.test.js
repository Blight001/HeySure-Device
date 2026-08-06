'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dispatchPluginTool,
  executeToolCalls,
  resolvePluginTarget,
  syncWindowToolControl,
} = require('../../../src/app/main/features/ai-chat/chat-tool-executor');
const {
  buildChatToolContext,
  withBrowserRouteParam,
} = require('../../../src/app/main/features/ai-chat/chat-tool-context');

test('浏览器工具 schema 暴露可选 change_browser 且保留原必填参数', () => {
  const tool = withBrowserRouteParam({
    name: 'browser_action',
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string' } },
      required: ['action'],
    },
  });
  assert.deepEqual(tool.input_schema.required, ['action']);
  assert.equal(tool.input_schema.properties.change_browser.type, 'string');
});

test('AI MCP prompt 按可用工具注入准确的多浏览器路由和页面操作策略', () => {
  const context = buildChatToolContext({
    connections: [
      { id: 'one', name: '工作窗口', tools: [
        { name: 'browser_tab', input_schema: { type: 'object' } },
        { name: 'browser_observe', input_schema: { type: 'object' } },
        { name: 'browser_action', input_schema: { type: 'object' } },
        { name: 'browser_download', input_schema: { type: 'object' } },
      ] },
      { id: 'two', name: '资料窗口', tools: [{ name: 'browser_observe', input_schema: { type: 'object' } }] },
    ],
    controlledConnectionId: 'one',
    initialMessages: [{ role: 'user', content: '继续操作' }],
    windowTools: {
      has: (name) => name === 'software_window',
      tools: [{ name: 'software_window', input_schema: { type: 'object' } }],
    },
  });
  const prompt = context.modelMessages[0].content;
  assert.match(prompt, /browser_tab、browser_observe、browser_action/);
  assert.match(prompt, /同一时间最多控制一个浏览器/);
  assert.match(prompt, /必须在下一次浏览器工具调用中传 change_browser/);
  assert.match(prompt, /页面明显变化后重新 observe/);
  assert.match(prompt, /先主动调用 browser_observe/);
  assert.match(prompt, /downloadLinks\[\]\.url/);
  assert.match(prompt, /browser_download action=download/);
  assert.match(prompt, /category 传给 media_type/);
  assert.match(prompt, /当前 Chromium 登录态/);
  assert.match(prompt, /禁止跨浏览器或跨页面复用旧 ref/);
  assert.match(prompt, /history_id 和 tab_id 不能当作 change_browser/);
  assert.match(prompt, /要聚焦已打开窗口，调用 software_window 的 open/);
  assert.match(prompt, /窗口已打开不等于其 MCP 已连接/);
  assert.match(prompt, /未收到成功结果前不得声称操作完成/);
  assert.equal(context.tools.find((tool) => tool.name === 'browser_tab').input_schema.properties.change_browser.type, 'string');
});

test('没有浏览器连接时 prompt 不会诱导 AI 虚构浏览器 MCP', () => {
  const context = buildChatToolContext({
    connections: [],
    initialMessages: [{ role: 'user', content: '打开窗口' }],
    windowTools: {
      has: (name) => name === 'software_window',
      tools: [{ name: 'software_window', input_schema: { type: 'object' } }],
    },
  });
  assert.match(context.modelMessages[0].content, /没有可用的浏览器自动化连接/);
  assert.doesNotMatch(context.modelMessages[0].content, /网页操作应先用 browser_tab/);
});

test('多浏览器工具要求明确路由，名称歧义和未知连接返回可恢复诊断', () => {
  const connections = [{ id: 'a' }, { id: 'b' }];
  const describe = () => 'A(a), B(b)';
  assert.equal(resolvePluginTarget({}, connections, (ref) => connections.find((item) => item.id === ref), describe, 'a').connection.id, 'a');
  assert.match(resolvePluginTarget({ change_browser: 'same' }, connections, () => ({ ambiguous: true }), describe).error, /change_browser/);
  const missing = resolvePluginTarget({ change_browser: 'missing' }, connections, () => null, describe).error;
  assert.match(missing, /当前 AI 已选且在线/);
  assert.match(missing, /history_id\/tab_id 不能代替 change_browser/);
});

test('插件工具移除路由字段并限制超时，自动化卡片使用十五分钟默认值', async () => {
  const calls = [];
  const base = {
    connections: [{ id: 'browser-1' }],
    browserControl: { connectionId: 'browser-1' },
    findConnectionByRef: (reference) => reference === 'browser-1' ? { id: 'browser-1' } : null,
    describeConnections: () => 'browser-1',
    waitForAbort: (promise) => promise,
    bridge: { dispatch: async (...args) => { calls.push(args); return { success: true }; } },
  };
  await dispatchPluginTool(base, 'open_page', { change_browser: 'browser-1', timeout_seconds: 9999, url: 'https://example.com' });
  assert.deepEqual(calls[0][2], { timeout_seconds: 9999, url: 'https://example.com' });
  assert.equal(calls[0][3].timeoutMs, 1800 * 1000);
  await dispatchPluginTool(base, 'manage_card', { action: 'run' });
  assert.equal(calls[1][3].timeoutMs, 15 * 60 * 1000);
});

test('change_browser 切换唯一控制目标并由后续调用沿用', async () => {
  const calls = [];
  const connections = [{ id: 'one', name: '窗口一' }, { id: 'two', name: '窗口二' }];
  const browserControl = { connectionId: 'one' };
  const context = {
    browserControl,
    connections,
    describeConnections: () => '窗口一(one)、窗口二(two)',
    emit() {},
    findConnectionByRef: (ref) => connections.find((item) => item.id === ref || item.name === ref),
    waitForAbort: (promise) => promise,
    bridge: { dispatch: async (...args) => { calls.push(args); return { success: true }; } },
  };
  await dispatchPluginTool(context, 'browser_observe', { change_browser: '窗口二', keyword: '标题' });
  await dispatchPluginTool(context, 'browser_action', { action: 'click', ref: 'e1' });
  assert.equal(browserControl.connectionId, 'two');
  assert.deepEqual(calls.map((call) => call[0]), ['two', 'two']);
  assert.deepEqual(calls[0][2], { keyword: '标题' });
});

test('窗口 MCP 就绪后刷新同一轮连接与工具目录并切换控制目标', () => {
  const events = [];
  const context = {
    bridge: { getConnection: () => ({ id: 'new-mcp', name: '插件窗口', tools: [
      { name: 'browser_tab', input_schema: { type: 'object', properties: {} } },
    ] }) },
    browserControl: { connectionId: 'old-mcp' },
    connections: [{ id: 'old-mcp', name: '旧窗口' }],
    emit: (event) => events.push(event),
    toolDefinitions: [{ name: 'software_window', input_schema: { type: 'object' } }],
    windowTools: { has: (name) => name === 'software_window' },
  };
  syncWindowToolControl(context, 'software_window', { action: 'open' }, {
    success: true,
    name: '新窗口',
    control_browser_id: 'new-mcp',
    control_browser_name: '新窗口',
  });
  assert.equal(context.browserControl.connectionId, 'new-mcp');
  assert.equal(context.connections.at(-1).name, '新窗口');
  assert.equal(context.toolDefinitions.at(-1).input_schema.properties.change_browser.type, 'string');
  assert.equal(events.at(-1).type, 'browser_control_changed');
});

test('窗口 MCP 就绪不会在工具结果后追加 system 消息', async () => {
  const modelMessages = [];
  await executeToolCalls({
    bridge: { getConnection: () => ({ id: 'new-mcp', name: '新窗口', tools: [] }) },
    browserControl: { connectionId: 'old-mcp' },
    compactToolValue: (value) => value,
    connections: [{ id: 'old-mcp', name: '旧窗口' }],
    describeConnections: () => '旧窗口、新窗口',
    emit() {},
    findConnectionByRef: () => null,
    isStopped: () => false,
    modelMessages,
    round: 0,
    toolCalls: [{ id: 'open', function: { name: 'software_window', arguments: '{"action":"open","name":"新窗口"}' } }],
    toolDefinitions: [],
    toolEvents: [],
    traceEvents: [],
    waitForAbort: (promise) => promise,
    windowTools: {
      has: (name) => name === 'software_window',
      execute: async () => ({
        success: true, name: '新窗口', mcp_connected: true,
        control_browser_id: 'new-mcp', control_browser_name: '新窗口',
      }),
    },
  });
  assert.equal(modelMessages.at(-1).role, 'tool');
});

test('本地窗口工具优先执行，插件失败被序列化为可恢复 tool 消息', async () => {
  const modelMessages = [];
  let pluginCalls = 0;
  const common = {
    compactToolValue: (value) => value,
    connections: [{ id: 'one' }],
    describeConnections: () => 'one',
    emit() {},
    findConnectionByRef: () => null,
    isStopped: () => false,
    modelMessages,
    round: 0,
    toolEvents: [],
    traceEvents: [],
    waitForAbort: (promise) => promise,
    bridge: { dispatch: async () => { pluginCalls += 1; return { success: false, error: 'offline' }; } },
  };
  await executeToolCalls({
    ...common,
    toolCalls: [{ id: 'local', function: { name: 'software_window', arguments: '{"action":"list"}' } }],
    windowTools: { has: () => true, execute: async () => ({ success: true, windows: [] }) },
  });
  assert.equal(pluginCalls, 0);
  const result = await executeToolCalls({
    ...common,
    toolCalls: [{ id: 'remote', function: { name: 'open_page', arguments: '{}' } }],
    windowTools: null,
  });
  assert.equal(result.unresolvedToolFailure, 'offline');
  const payload = JSON.parse(modelMessages.at(-1).content);
  assert.equal(payload.recoverable, true);
  assert.equal(payload.error, 'offline');
});

test('工具参数 JSON 错误时返回格式诊断且不执行工具', async () => {
  const modelMessages = [];
  let executions = 0;
  const result = await executeToolCalls({
    compactToolValue: (value) => value,
    connections: [],
    describeConnections: () => '',
    emit() {},
    findConnectionByRef: () => null,
    isStopped: () => false,
    modelMessages,
    round: 0,
    toolCalls: [{ id: 'bad-json', function: { name: 'software_window', arguments: '{bad}' } }],
    toolEvents: [],
    traceEvents: [],
    waitForAbort: (promise) => promise,
    windowTools: {
      has: () => true,
      execute: async () => { executions += 1; return { success: true }; },
    },
  });
  assert.equal(executions, 0);
  assert.match(result.unresolvedToolFailure, /MCP 调用格式错误/);
  const payload = JSON.parse(modelMessages.at(-1).content);
  assert.equal(payload.errorCode, 'MCP_ARGUMENTS_INVALID');
  assert.equal(payload.phase, 'tool_parse');
});

test('截图结果转为模型可读取的临时 image_url 消息且不把 dataUrl 塞进 tool 文本', async () => {
  const modelMessages = [];
  const toolEvents = [];
  await executeToolCalls({
    compactToolValue: (value) => value,
    connections: [{ id: 'one' }],
    describeConnections: () => 'one',
    emit() {},
    findConnectionByRef: () => ({ id: 'one' }),
    isStopped: () => false,
    modelMessages,
    round: 0,
    toolCalls: [{ id: 'shot', function: { name: 'browser_screenshot', arguments: '{}' } }],
    toolEvents,
    traceEvents: [],
    waitForAbort: (promise) => promise,
    bridge: { dispatch: async () => ({
      success: true,
      dataUrl: 'data:image/png;base64,SCREENSHOT',
      method: 'captureVisibleTab',
    }) },
  });
  assert.equal(modelMessages[0].role, 'tool');
  assert.equal(JSON.parse(modelMessages[0].content).image_attached, true);
  assert.doesNotMatch(modelMessages[0].content, /SCREENSHOT/);
  assert.equal(modelMessages[1].role, 'user');
  assert.equal(modelMessages[1].content[1].type, 'image_url');
  assert.equal(modelMessages[1].content[1].image_url.url, 'data:image/png;base64,SCREENSHOT');
  assert.equal(modelMessages[1].ai_free_transient_image, true);
  assert.equal(toolEvents[0].result.image_attached, true);
  assert.equal(Object.prototype.hasOwnProperty.call(toolEvents[0].result, 'dataUrl'), false);
});
