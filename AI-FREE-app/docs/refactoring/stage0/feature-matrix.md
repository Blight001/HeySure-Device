# 功能覆盖矩阵

更新日期：2026-07-19。测试名称以 `node:test` 输出为准；同一行中的测试会覆盖正常、边界、失败、重复/并发或恢复中的多个维度。`真实验收` 指必须使用 Electron、Chromium 或打包产物的补充证据。

## AI

| 编号 | 目标/入口 | 前置状态 | 正常与异常/边界 | 恢复/副作用 | 自动化测试 | 真实验收 |
|---|---|---|---|---|---|---|
| AI-CHAT-01 | `ai-control-chat` 发送、配额和流式输出 | 登录、模型可用 | 合法消息完成；额度耗尽/服务失败不误调用 | 迟到事件不发给已销毁窗口 | `test/unit/ai-chat/ai-chat-service.test.js`、`chat-request-context.test.js` | 侧边栏 Electron 加载通过 |
| AI-CHAT-STOP-01 | stop/insert/连续停止 | 存在运行 requestId | stop 只影响同 sender/request；重复 stop 幂等 | 新运行替换旧运行，旧清理不删新状态 | `test/unit/ai-chat/chat-run-registry.test.js`、`test/integration/ai-chat-interrupt.test.js` | `test:acceptance` |
| AI-WINDOW-01 | 消息裁剪、摘要、工具链配对 | 任意历史长度 | 40 条/字符上限；孤立 tool 丢弃；先压缩旧工具结果 | 最新用户输入和完整 tool chain 保留 | `test/integration/ai-control-message-window.test.js` | 不需要 |
| AI-TOOL-01 | 本地窗口工具与插件工具派发 | 浏览器连接可选 | 本地工具优先；未知/歧义连接明确失败 | 插件失败转换为可恢复 tool message | `test/unit/ai-chat/chat-tool-executor.test.js`、`chat-tool-context.test.js` | Chromium phase 3 |
| AI-HIST-01 | 历史 create/list/get/save/rename/delete | 账号 scope | 首次保存、重命名、删除；非法角色过滤 | 空会话不落盘、损坏/写失败不报告成功、账号隔离 | `test/unit/ai-chat/history-repository.test.js` | 不需要 |
| AI-SET-01 | MCP 上限、自定义 API、模型和礼品码 | 自定义模型需在线 VIP | MCP 1–1000；URL 兼容；Key 不返回 UI；无效地址失败 | 写失败不污染存储，远端模型失败降级 | `test/integration/ai-control-mcp-limit.test.js`、`custom-ai-api.test.js`、`test/unit/ai-chat/ai-settings-service.test.js` | 侧边栏设置 UI acceptance |
| AI-CARD-01 | 自动化卡片读取、选择和运行 | 桥/token/managed PID | 选择稳定摘要；跨导航 wait；空卡运行 | 空库可持久化、失败诊断完整、运行释放 session | `test/integration/browser-automation-card-cache.test.js`、`browser-automation/card-runner.test.js` | extension compat/observe acceptance |

## 浏览器

| 编号 | 目标/入口 | 前置状态 | 正常与异常/边界 | 恢复/副作用 | 自动化测试 | 真实验收 |
|---|---|---|---|---|---|---|
| BR-TAB-01 | 标签创建、关闭、切换和运行环境 | 主窗口存活 | 慢探测先发 starting；创建失败回滚；创建中关闭取消 | Chromium 意外关闭同步 tab；应用退出不重复关闭 | `test/integration/browser-window-lifecycle.test.js` | packaged sidebar assets |
| BR-VIP-01 | 非 VIP 独立浏览器数量限制 | 服务端 VIP 快照 | 第六个独立浏览器在主进程拒绝 | 不新增 tab、不启动进程 | `test/integration/vip-access.test.js` | 不需要 |
| BR-PROFILE-01 | Profile/网络环境/Geo | 代理可选 | 权威 trace、CN 代理未改变出口拒绝；环境 payload 取已应用快照 | Profile 间 Cookie/storage 隔离，锁/进程释放 | `test/unit/browser-profile-geo.test.js`、`test/integration/tab-runtime-environment.test.js` | `accept:chromium-phase3` |
| BR-RUNTIME-01 | Chromium 握手、导航、重载、会话导入 | 原生 host/resources 可用 | 非法 session/profile/origin/超限拒绝 | graceful stop、session 恢复、Named Pipe 释放 | contract/runtime tests | handshake/runtime/phase2/phase3 acceptance |
| BR-SET-01 | 浏览器设置、历史、代理测试 | sidebar 与主进程连接 | 33 项设置渲染和保存；代理/历史操作返回明确状态 | 重复初始化不重复绑定 | UI/contract tests | `check:browser-settings-ui`（真实 Electron） |
| BR-FOCUS-01 | shell/sidebar/native host 焦点 | 主窗口已聚焦 | 重开侧栏恢复输入；refocus 提升 Chromium | timer 解绑，无重复 paint | `test/integration/sidebar-reopen-wheel-focus.test.js`、`browser-window-focus-flicker.test.js` | packaged sidebar assets |

## 网络

| 编号 | 目标/入口 | 前置状态 | 正常与异常/边界 | 恢复/副作用 | 自动化测试 | 真实验收 |
|---|---|---|---|---|---|---|
| NET-CFG-01 | Clash 配置导入、Geo 本地化 | Core 与最小 Geo 资产 | 已知 provider 本地化；缺资源保留远端；更新域强制 DIRECT | 先同步资产再应用离线 fallback | `test/integration/background-network-guard.test.js` | packaged runtime 资源校验 |
| NET-LAT-01 | TLS 延迟探测和并发 | 节点列表 | HTTP 204 规范化为 HTTPS；并发限制 4–12 | 单节点失败不破坏其它结果 | `background-network-guard.test.js` | `test:acceptance` 网络环境 |
| NET-EXIT-01 | 应用退出停止 bridge/Chromium/Clash | shutdown 可重入 | 顺序为通知→bridge→Chromium→Clash | ECONNRESET 仅退出期吞掉，普通异常继续抛 | `background-network-guard.test.js` | Chromium phase 3 graceful stop |
| NET-QUOTA-01 | 代理流量计数 | connection snapshot | 只计代理链；新增连接/计数器回滚正确 | null snapshot 为 0，非法 snapshot 不重置 | `test/unit/proxy-traffic-monitor.test.js` | 不需要 |

## 账号与授权

| 编号 | 目标/入口 | 前置状态 | 正常与异常/边界 | 恢复/副作用 | 自动化测试 | 真实验收 |
|---|---|---|---|---|---|---|
| ACC-AUTH-01 | 登录、设备登录、登出 | server base 可用 | 忽略 renderer 伪造 deviceId；失败不写缓存 | 登出清凭据/状态但不关闭 Chromium | `test/unit/account/account-service.test.js`、`test/integration/account-device-login.test.js` | account/session acceptance |
| ACC-VIP-01 | VIP 永久/有效/过期与服务端可信状态 | 服务端验证时间戳 | 篡改本地字段无效；过期/陈旧验证降级 | 并发刷新复用请求，失败关闭本地 VIP | `test/integration/vip-access.test.js`、`test/unit/account/membership-service.test.js` | account popup packaged test |
| ACC-LIC-01 | 卡密、礼品码、设备解绑 | 可信设备号 | 每次重新计算设备号；服务失败不写缓存 | 成功后持久化并发布状态 | `test/unit/account/license-service.test.js` | account/session acceptance |
| ACC-MIG-01 | 旧账号/许可证/会话数据读取 | 旧文件可能缺失/损坏 | 旧键和未知记录保持；删除目标不误删其它记录 | 写前校验、失败不报告成功 | account/storage contract tests | 使用原 userData 的人工回归 |

## 扩展、更新与打包

| 编号 | 目标/入口 | 前置状态 | 正常与异常/边界 | 恢复/副作用 | 自动化测试 | 真实验收 |
|---|---|---|---|---|---|---|
| EXT-LOAD-01 | 内置/自定义扩展发现、启停、刷新 | extension paths 可读 | 发现/兼容副本/刷新；不存在项明确失败 | watcher/session 可释放 | extension feature tests | extension compat + refresh acceptance |
| EXT-PORT-01 | 自动化插件通过本机端口直接连接 | 浏览器扩展可访问 loopback 端口 | 外部浏览器可注册；注册后返回连接 token 并隔离连接 | 插件直接加载原目录，不创建运行副本 | `test/integration/browser-automation-port-access.test.js` | handshake acceptance |
| EXT-OBF-01 | 打包扩展混淆后可执行 | win-unpacked | executeScript host 保持自包含 | 源/运行资源完整 | `test/packaging/packaged-extension-obfuscation.test.js` | `check:packaged-runtime` |
| UPD-01 | 版本判断、公告、下载/安装资源 | 公告可用 | SemVer 仅高版本提示；轮询不阻塞登录 | 并发轮询排队，失败可重试 | `test/unit/update-version-detection.test.js` | Windows 正式构建 |
| PKG-01 | 开发/测试/Windows 共用源码构建 | Node/tsc/electron-builder | 按进程输出 CJS/ESM；无 renderer TS 时不误失败 | 生成目录可清除重建，不覆盖源码 | `test/packaging/assets/source-build.test.js` | `build:win` + packaged runtime |

## 矩阵闭环与明确限制

- 浏览器历史读取/迁移、创建同步、打开、重命名、批量冲突、删除失败回滚和 Profile 审计已由 `browser-history-service.test.js`、`browser-history-ipc-handlers.test.js` 覆盖。
- 更新链路覆盖直接下载、进度、HTTP/文件不完整失败、并发锁释放、版本跳过和安装资源暂存。当前产品没有“断点续传”入口，因此不虚构该行为；发布流程仍需人工点验安装/升级 UI。
- 网络进程覆盖预检取消、重复启动复用、健康检查失败停止、spawn 异常和无进程停止恢复；客户端不修改系统级代理，故“系统代理切换竞争”不适用。
- 账号/会话覆盖旧格式迁移、缺失和非法 ID；Chromium Profile 损坏恢复使用 stable backup，并在 runtime acceptance 中验证。原始数据路径和格式保持兼容。
- 所有当前产品入口均已关联自动化或真实环境证据；外部服务器、订阅节点和安装器交互质量作为发行检查项记录，不由本次可维护性重构伪装为可离线自动验证。
