# AI-FREE 架构索引

更新时间：2026-07-26

本文档记录当前源码的稳定进程边界和依赖方向。详细功能清单见
[`refactoring/stage0/feature-matrix.md`](refactoring/stage0/feature-matrix.md)，MCP 工具说明见
[`mcp.md`](mcp.md)。

## 进程与依赖方向

```text
main/entry → main/composition → main/features → injected platform/repository
                                      ↑
renderer/sidebar → preload → contracts/IPC adapters
AI/Codex/HeySure → AutomationBridge → authenticated Chromium Runtime Bridge
```

- `main/entry` 只负责启动入口。
- `main/composition` 创建服务、注入依赖并管理生命周期。
- `main/features` 承载 AI、账号、网络等业务服务和 IPC adapter。
- `main/services` 承载被业务域复用的平台服务、浏览器桥接和工具契约。
- `shared` 保持纯逻辑，不依赖 Electron、DOM、网络或文件系统。
- renderer/sidebar 只能通过 preload 暴露的冻结 `window.aiFree` 领域 API 调用主进程。

## MCP 自动化控制

三种调用入口保留各自的传输协议，但共享内部工具契约和最终执行路径：

```text
本地 AI function call ───────────────┐
Codex 本机 HTTP adapter ─────────────┼→ automation-tool-contract
HeySure Socket.IO device adapter ────┘             │
                                                    ├→ software_window / sandbox_files
                                                    └→ AutomationBridge.dispatch
                                                            ↓
                                             authenticated Chromium Runtime Bridge
                                                            ↓
                                                   AI-FREE Chromium Fork
```

统一契约真源为
[`automation-tool-contract.js`](../src/app/main/services/automation-tool-contract.js)，负责：

- 兼容 `input_schema` 和 `inputSchema` 的 JSON Schema 规范化；
- 注入统一的 `change_browser` 路由参数；
- 按连接 ID 或唯一名称解析当前控制浏览器；
- 清理仅用于路由、不应发送给浏览器扩展的参数；
- 计算普通工具、卡片运行和显式请求的有界超时；
- 将异常规范化为稳定的 `code/message/phase/retryable` 错误。

传输 adapter 只保留协议特有职责：

- 本地 AI：模型 tool call、停止/插入、截图转视觉消息和对话恢复；
- Codex：本机描述文件、随机令牌、HTTP 状态码和敏感外部参数限制；
- HeySure：登录、设备注册、`aifree.` 名称映射、任务幂等和 Socket.IO 终态回传。

外部 Codex/HeySure 目录由
[`browser-automation-external-gateway.js`](../src/app/main/services/browser-automation-external-gateway.js)
汇总。HeySure 不维护第二套工具执行器，而是通过 composition 注入同一外部目录和调用入口。

## 浏览器连接和路由

- Automation Bridge 从受管 Chromium Runtime 状态枚举多个在线原生连接，但每个调用只派发到一个连接。
- `change_browser` 接受连接 ID 或唯一窗口名称；同名连接必须使用 ID。
- 未显式切换时沿用调用会话的当前控制连接；没有唯一目标时调用失败。
- 工具目录是所有在线连接工具的去重并集；执行前仍会校验目标连接实际支持该工具。
- `software_window open/create` 需要等待 Chromium 完成认证 Runtime Bridge 握手后才返回可控连接 ID。

## 原生浏览器控制

- AI 页面工具目录由主进程提供，不再由浏览器自动化扩展注册。
- `browser_observe`、`browser_screenshot`、`browser_action`、`browser_wait` 直接调用 Chromium Runtime Bridge。
- `browser_tab` 通过受管 Profile 的原生导航、打开标签、刷新和焦点能力执行。
- `browser_download`、`manage_card` 的数据与编排留在主进程；其中页面步骤仍只通过原生 Runtime Bridge 执行。
- 自动化卡片工作台显示在软件首页下方，通过窄 preload/IPC 读写、导入导出、运行卡片和保存会话。
- 旧自动化扩展源码已删除，且不会加入 Chromium `--load-extension` 参数。普通非自动化扩展仍按扩展管理契约加载。

## 兼容边界

- 内部工具名保持无前缀；HeySure adapter 注册时转换为 `aifree.<name>`。
- 外部 HTTP 当前是 AI-FREE Codex Bridge 协议，不等同于通用 JSON-RPC MCP Server。
- 历史 `browser_id`、`browser_name` 和 `browser` 参数仅在执行层兼容，新 Schema 只公开
  `change_browser`。
- 工具业务结果暂时保持原有结构；统一错误结构作为非破坏性附加字段提供。
