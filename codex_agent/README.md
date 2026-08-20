# HeySure Codex Agent

`codex_agent` 是 HeySure 的正式 Codex 项目控制器。它把网页远程消息和维护工单连接到
本机 Codex App Server；Codex 保持自身身份，不成为 HeySure 数字成员。成员名称仅可作为
网页消息路由入口。它不包装 OpenAI 兼容 API，也不操作 Codex 桌面 UI。

它只建立两条本机/出站连接：

1. 以 `deviceType=custom`、`platform=codex-maintainer` 登录并连接 HeySure Socket.IO；
2. 以子进程方式运行 `codex app-server --listen stdio://`，通过 JSONL JSON-RPC 通信。

App Server 的 stdio、thread、turn、steer、interrupt、流式 item 和审批协议以
[OpenAI 官方 Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)为准。
本设备不会启动实验性的 App Server WebSocket listener。

## 能力

- 稳定且可显式覆盖的设备 ID；每次 Socket 重连都会重新注册；
- 监督 App Server，异常退出后指数退避重启；
- 原子持久化 `runId -> threadId/turnId`、单调事件序号和待审批记录；
- 支持 `run_start`、运行中 `steer`、`interrupt` 与 Web 审批回执；
- 所有入站 Codex 控制命令经单消费者 FIFO 执行，重连补发的 steer/interrupt/审批不会
  越过尚未完成映射的 run_start；
- 上报消息、计划、公开 reasoning summary、命令输出、文件变更、turn diff 和错误；
- 主动丢弃 `item/reasoning/textDelta`，不采集或声称提供隐藏思维链；
- 对 token、密码、Cookie、Authorization、API key 等内容递归脱敏；
- 用本地锁阻止相同状态目录被重复启动；
- 保留最多 1000 个尚未确认且带 `eventId` 的出站事件；服务端 ACK 后删除，重连时重放，
  服务端同时按 `eventId` 去重。
- 提供只监听本机回环地址的状态面板，展示服务器连接、设备注册、消息接收、Codex
  App Server、运行工单、审批与可靠队列；默认地址为 `http://127.0.0.1:8765/`。
- 在状态目录的 `logs/codex-agent.jsonl` 写入脱敏 JSONL 轮转日志（单文件 5 MiB，保留 5 份）。

## 安装

需要 Python 3.10+，并先确保当前运行账户可以正常使用已经登录的 Codex CLI。

```powershell
cd device/codex_agent
python -m venv .venv
.venv\Scripts\python -m pip install -e .
```

配置通过进程环境传入；程序不会读取或生成 `.env`：

```powershell
$env:HEYSURE_ACCOUNT = 'heysure'
$env:HEYSURE_PASSWORD = '<password>'
$env:HEYSURE_CODEX_WORKSPACE = 'D:\path\to\HeySure_AI_2.0'
$env:CODEX_COMMAND = 'codex'
.venv\Scripts\heysure-codex-agent
```

如果计划任务或 Windows 服务账户不能解析 Store 安装的 `codex.exe`，不要硬编码
`WindowsApps` 路径。将 `CODEX_COMMAND` 指向该运行账户可以访问的启动器。它可以是
安全拆分的命令字符串，也可以是 JSON argv：

```powershell
$env:CODEX_COMMAND = '["C:\\Tools\\codex.exe","--profile","maintainer"]'
```

程序不通过 shell 执行这个值；解析出的 argv 会追加
`app-server --listen stdio://`。启动失败会明确提示当前命令和 `CODEX_COMMAND`，但不会
回显 HeySure 密码或 token。

## 配置

| 环境变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `HEYSURE_SERVER` | 否 | 聚合仓库 `device.config.json`（当前为 `http://49.234.181.190:58150`） | 显式 API 登录入口，优先级最高；Socket 地址始终采用登录响应中的 `agent_socket_url` |
| `HEYSURE_LOCAL_TEST` | 否 | `false` | 仅显式设为 `true/1/yes/on` 时使用 `device.config.json` 的本地测试地址 `http://127.0.0.1:3000` |
| `HEYSURE_ACCOUNT` | 是 | - | HeySure 账号 |
| `HEYSURE_PASSWORD` | 是 | - | HeySure 密码，只在登录请求中使用 |
| `HEYSURE_CODEX_WORKSPACE` | 否 | 当前目录 | Codex thread/turn 的工作目录 |
| `HEYSURE_CODEX_STATE_DIR` | 否 | `<workspace>/.heysure-codex-agent` | 映射、序号、重放窗口和实例锁 |
| `HEYSURE_CODEX_WORKTREE_ROOT` | 否 | 主仓库同级的 `.heysure-codex-worktrees/<repo>` | 受管 Git worktree 根目录 |
| `HEYSURE_CODEX_WORKTREE_MODE` | 否 | `on` | `on` 强制隔离；仅显式设为 `off` 才使用配置 workspace |
| `HEYSURE_CODEX_DEVICE_ID` | 否 | 首次启动生成并持久化 | 显式稳定设备 ID |
| `HEYSURE_CODEX_DEVICE_NAME` | 否 | `Codex Project Controller` | Web 展示名称 |
| `CODEX_COMMAND` | 否 | `codex` | Codex 可执行 argv 前缀；支持 JSON 字符串数组 |
| `LOG_LEVEL` | 否 | `INFO` | Python 日志等级 |
| `HEYSURE_CODEX_DASHBOARD_HOST` | 否 | `127.0.0.1` | 本地状态面板；只允许回环地址 |
| `HEYSURE_CODEX_DASHBOARD_PORT` | 否 | `8765` | 本地状态面板端口；设为 `0` 可禁用 |

状态目录不保存 HeySure 密码或登录 token。应将密码放在操作系统服务凭据管理机制中，
不要写进仓库、启动参数或日志。如果 workspace 是仓库根目录，必须确认根仓库的
`.gitignore` 包含 `/.heysure-codex-agent/`；本目录自带的 `.gitignore` 只覆盖在本目录
启动并把本目录作为 workspace 的情况。

聚合仓库运行时会自动读取 `device/device.config.json`。单独检出本设备仓库时若该文件
不存在，也会安全回退到生产服务器，而不会默认连接本机；自定义部署请显式设置
`HEYSURE_SERVER`。

## Socket 协议

### 服务器到设备

| 事件 | 关键字段 |
| --- | --- |
| `codex:run_start` | `commandId`, `runId`, `prompt`; 可选 `workspaceMode=current` 使用配置工作区；可选 `trustedMcpServers`, `model`, `approvalPolicy`, `sandboxPolicy`, `effort`, `summary` |
| `codex:steer` | `commandId`, `runId`, `text` |
| `codex:interrupt` | `commandId`, `runId` |
| `codex:approval_decision` | `commandId`, `runId`, `approvalId`，命令/文件使用 `decision`，其他审批使用协议原生 `result` 对象 |

每个输入命令最终对应一个 `codex:command_ack`。同一个已存在的 `runId` 会先
`thread/resume`，再在原 thread 上开始新 turn。

### 设备到服务器

| 事件 | 说明 |
| --- | --- |
| `codex:run_started` | App Server 已返回 thread/turn ID |
| `codex:event` | 经过白名单和脱敏的 App Server 进度事件 |
| `codex:approval_requested` | 审批保持挂起，直到服务器回复；控制器任务仅可自动接受服务端明确下发的可信 MCP 空表单门禁，并保留审计事件 |
| `codex:run_completed` | HeySure 状态 `succeeded` / `cancelled` / `failed`，同时保留 App Server `rawStatus` |
| `codex:command_ack` | 控制命令接收与执行结果 |

除独立确认合同 `codex:command_ack` 外，所有 run 输出包含 `deviceId`、`runId`、单调递增的
`sequence`、唯一 `eventId` 和 `payload`；为了兼容 Web 直读，`payload` 字段也保留在事件顶层。
ACK 携带稳定 `commandId`，但不占用设备事件序号。
`run_completed` 会把 App Server 标记为 `final_answer` 的最终公开回复放入 `summary`，供
服务器把远程控制器会话的结果写回原聊天；过程中的 commentary 仍只进入审计事件流。
App Server 进程崩溃时运行进入 `recovering`，设备上报退出事件并重启 App Server；服务器
随后可以重发相同 `runId`，设备将恢复原 thread。旧进程上的审批请求不能跨进程回答，
迟到的服务器审批决定会被幂等消费，并上报 `approval/staleAfterRestart`，不会永久重放。
未知、从未出现过的 approval ID 仍会返回错误。对未知、已终止或尚无 active turn 的 run，
迟到 interrupt 会幂等视为取消成功；steer 仍要求 active turn。

## 安全边界

- `HEYSURE_CODEX_WORKSPACE` 是唯一传给 thread/turn 的 cwd；事件载荷不能改变它。
- 默认每个新 run 都从主 workspace 当前 `HEAD` 创建独立 Git worktree，分支为
  `codex/maintenance/<task-id-safe>`；worktree 默认位于主仓库同级的受管目录。路径、分支
  和基准 SHA 会持久化，同一 run 恢复时只复用经过仓库和分支校验的原 worktree。
- 设备不会自动删除 worktree。清理必须在任务提交、推送和审计完成后由独立运维动作执行。
- 主 workspace 不是 Git 仓库、分支冲突、路径已被占用或 worktree 创建失败时，run 会
  明确失败；不会退回可能有用户改动的主目录。`HEYSURE_CODEX_WORKTREE_MODE=off` 是唯一
  兼容例外，应只用于用户明确承担风险的诊断场景。
- 根 worktree 创建后，设备只初始化根仓库登记的顶层子模块（`git submodule update --init
  --no-fetch`），不会自动递归初始化各端自己的嵌套仓库；并把 Git 传输协议强制限制为本地
  `file`。这同时阻止首次 clone 和后续 fetch 使用网络，只使用本机已有 Git 元数据。缺少
  本地对象时不会联网拉取，也不会碰原
  子模块工作区；设备会把警告前置到 prompt 并上报 `worktree/submoduleWarning`。
- 沙箱和审批策略由工单下发或本地 Codex 托管策略决定；设备不会默认批准。
- `workspaceWrite` 的 writable roots 会强制收窄为配置 workspace，网络默认关闭。普通维护
  工单不接受主目录回退；只有服务端标记的远程 Codex 控制器任务可显式请求当前工作目录和
  `dangerFullAccess`，用于复现本机 Codex 的项目维护/MCP 部署能力，并记录完整审计事件。
- `item/reasoning/summaryTextDelta` 是面向用户的公开摘要；
  `item/reasoning/textDelta` 会被直接丢弃。
- 命令输出与 diff 最大保留 64 KiB/字段，超出部分标记为截断。
- 该设备不包含 PowerShell/shell 远程工具，也不提供任何 UI 自动化能力。

## 测试

测试使用 fake Socket.IO 与 fake App Server 进程，不需要网络、真实账号或 Codex 登录：

```powershell
cd device/codex_agent
python -m unittest discover -s tests -v
```
