# AI-FREE 数据契约

更新时间：2026-07-26

本文档记录跨进程、跨适配器或持久化边界上需要保持兼容的数据形状。具体 IPC 通道以
[`ipc-channels.js`](../src/app/contracts/ipc-channels.js) 为真源。

## MCP 工具定义

内部工具定义使用以下逻辑字段：

```js
{
  name: 'browser_action',
  description: '执行浏览器动作',
  input_schema: {
    type: 'object',
    properties: {},
    required: []
  },
  destructive: false
}
```

- 内部和本地 AI 使用 `input_schema`。
- Codex HTTP adapter 输出 `inputSchema`。
- HeySure adapter 输出 `input_schema`，并把名称转换为 `aifree.<内部名称>`。
- adapter 必须通过 `automation-tool-contract.js` 规范化 Schema，不得各自复制转换规则。
- 浏览器工具公开可选 `change_browser`；软件级工具不得无条件增加浏览器路由字段。

## 浏览器工具调用

逻辑调用由工具名、参数、当前控制连接和超时组成：

```js
{
  tool: 'browser_action',
  arguments: { action: 'click', ref: 'e1' },
  controlledConnectionId: 'connection-id',
  timeoutMs: 180000
}
```

路由参数 `change_browser`、`browser_id`、`browser_name` 和 `browser` 只供主进程选择连接，
派发到 Chromium 原生 Runtime Bridge 前必须删除。普通调用默认超时 180 秒；`manage_card action=run` 默认
15 分钟；显式 `timeout_seconds` 限制在 1～1800 秒。

## 工具结果与错误

工具业务成功结果保持各工具已有结构。跨 adapter 的规范错误字段为：

```js
{
  code: 'BROWSER_TOOL_TIMEOUT',
  message: '浏览器工具调用超时',
  phase: 'bridge_wait_result',
  retryable: true,
  timeoutMs: 180000
}
```

- 本地 AI 兼容映射为 `errorCode`、`error`、`phase`、`recoverable`。
- Codex HTTP 失败保持 `{ok:false,error,message}`，并附加 `phase`、`retryable`。
- HeySure `task:error` 保持字符串 `error`，并附加 `errorCode`、`phase`、`retryable`。
- 新字段只能以非破坏方式追加；现有调用方依赖的字段不得删除或改义。
- Cookie、Authorization、MCP token、密码和代理凭据不得进入错误详情。

## 外部 Codex Bridge

描述文件位于 Electron `userData/ai-free-mcp-bridge.json`，包含：

```js
{
  schemaVersion: 1,
  service: 'ai-free-external-mcp-gateway',
  endpoint: 'http://127.0.0.1:<port>',
  token: '<随机令牌>',
  pid: 1234,
  entitlement: 'vip',
  membershipRequired: false,
  updatedAt: '<ISO timestamp>'
}
```

描述文件只属于当前发布进程；权限状态变化时轮换令牌，退出时仅删除 PID 所有权匹配的文件。
HTTP 支持 `/mcp/v1/status`、`/mcp/v1/tools` 和 `/mcp/v1/call`，通过专用请求头或 Bearer
令牌认证。

## HeySure 设备协议

- 注册事件：`device:register`，包含设备身份、`capabilities` 和 `toolDefs`。
- 派发事件：`task:dispatch`，包含 `taskId`、带 `aifree.` 前缀的工具名和 `args`。
- 成功终态：`task:result`；失败终态：`task:error`。
- 同一 `taskId` 只能执行一次并回传一个终态；已完成任务保留有界幂等缓存。
- 浏览器连接变化后，设备端按工具目录签名刷新注册。
