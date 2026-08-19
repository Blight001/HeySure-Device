# CLAUDE.md — device/ 端侧执行器（壳） (HeySure-Device)

端侧客户端（**只是运行在不同端的壳，本身不具备 agent 能力**），连接后端、注册为 endpoint，接收并执行服务端下发的 MCP 任务。

**本目录是聚合仓库** `HeySure-Device`。各设备产品以 Git submodule 形式维护独立仓库，代码与资产互不共享；首次检出或更新后运行 `git submodule update --init --recursive`。
同内容的 Agent 版见 [`AGENTS.md`](AGENTS.md)。

**桌面/服务端壳已退化为受控运行器**：能力主要来自服务器下发的动态 MCP（`device:tool-config`，含 runtime 工具；Windows 以 powershell/shell 为主），由服务端编排/推理。接入协议与远程连接标准见 [`read.md`](read.md)。

**远程连接是另一条独立于 AI 任务循环的、由真人操作者驱动的实时数据面**，有两种形态——
画面远程（`rc:*`，WebRTC P2P）与命令行远程（`rt:*`，PTY 走 Socket.IO relay，无需 TURN）——
统一标准见 [`read.md`](read.md) 第 9 节。

## 当前形态（仓库内实际目录）

| 子目录 | 形态 | 作用 |
| --- | --- | --- |
| `windows/` | **Tauri 2** 桌面（Windows） | 正式 Windows 壳：登录/连接 + 动态 MCP + runtime 执行（powershell / shell）+ 远程连接两条通道——画面（`remote-control.ts` + `src-tauri/src/rc.rs`，xcap 抓屏→canvas→WebRTC + enigo 键鼠）与命令行（`remote-terminal.ts` + `src-tauri/src/pty.rs`，ConPTY + `rt:*`）。见 `windows/README.md` |
| `linux/` | **Python** 服务器 Agent | 无 GUI 常驻进程，把 Linux 服务器接入为 `deviceType: custom`（systemd 部署）。运维类 MCP + 命令行远程 `rt:*`。**不是**旧版 Electron 桌面端。见 `linux/README.md` |
| `browser/browser_MCP/` | Chrome MV3 扩展（主源码） | 浏览器自动化 Agent + 轻量客户端；TypeScript 源在 `src/`，构建产物 `dist/` |
| `browser/browser_MCP_win/` | Chrome 扩展 + Windows 原生输入构建 | 与 `browser_MCP/` 共用感知逻辑；点击/输入等经本机回环桥交给 `windows/` 的 Rust/enigo 执行 |
| `browser/browser_automation/` | 另一套浏览器自动化扩展（JS 分包） | 历史/并行实现，background 按序号分包；联调前先确认目标目录 |
| `android/` | 原生 Kotlin App（方案 A） | 手机本机执行：点击/滑动/截屏（无障碍 + MediaProjection） |
| `android/android-adb/` | 宿主电脑 Node.js（方案 B） | 经 ADB 控制手机；息屏/锁屏下也能注入 |
| `cli_to_api/grok_cli_api/` | 本地 OpenAI 兼容网关（**不是**端侧 agent 壳） | 包装本机 grok CLI 为 `POST /v1/chat/completions`（默认 `127.0.0.1:8100`），不注册设备 |
| `cli_to_api/antigravity_cli_api/` | 本地 OpenAI 兼容网关（**不是**端侧 agent 壳） | Python 调用官方 `agy`，复用其本地用户登录数据并提供 `POST /v1/chat/completions`（默认 `127.0.0.1:8110`），不注册设备 |
| `AI-FREE-app/` | Windows AI 浏览器工作台 | Electron + 内置 Chromium Fork，多环境隔离、网络管理和浏览器 AI 自动化；内置 OpenCut 本地端口 `127.0.0.1:5173` 与 `opencut.*` 工具 |
| `usb_flasher/` | **Python USB 烧录设备** | 被控机常驻进程：从服务器拉固件、esptool 烧录 ESP、串口监视；本机回环面板 `127.0.0.1:8770`。见 `usb_flasher/README.md` |
| `AI-Control-Exam/` | AI 控制能力考试系统 | 浏览器与桌面控制 Agent 的交互式任务、遥测、安全检查和评分平台 |

> 安卓两形态（A 本机 App / B 宿主 ADB）都以 Android 类 endpoint 注册，服务端统一调度。
> **当前仓库无 `mac/`、`extension/` 目录**（旧文档里的路径已废弃；浏览器主线为 `browser_MCP*`）。

## Windows 桌面架构（Tauri 2）

```
device/windows/
  src/
    main.ts / agent.ts / api.ts / native.ts
    remote-control.ts      ← 画面远控（WebRTC）
    remote-terminal.ts     ← 命令行远控（rt:*）
    executor/              ← 动态 MCP 路由（catalog / dynamic / registry / index）
    runtime/               ← powershell-runner / shell-runner / process / permission-guard
  src-tauri/src/           ← Rust 壳（托盘、进程 guard、rc 抓屏注入、pty、browser_bridge…）
  assets/                  ← 图标等本地资产
```

协议层跑在 WebView（socket.io-client）；spawn/抓屏/注入走 Rust 命令。详见 `windows/README.md`。

## Linux 服务器 Agent 架构（Python）

```
device/linux/
  agent/
    main.py / config.py / connection.py / dispatch.py
    remote_terminal.py
    tools/                 ← system/process/service/journal/shell/console 等
  systemd/                 ← heysure-linux-agent.service
  install.sh / run.sh / requirements.txt
```

登录 → Socket.IO 注册 → 收 `task:dispatch` → 工具执行 → `task:result`。详见 `linux/README.md` 与 [`read.md`](read.md)。

## 浏览器扩展（browser_MCP）

```
device/browser/browser_MCP/
  src/
    background.ts          ← service worker：socket / 任务派发
    content/               ← DOM 感知与动作
    popup/                 ← 弹窗 UI 模块
    lib/                   ← 共享库
  dist/                    ← 构建产物（Chrome 加载目录）
  build.js / manifest.json
```

## 工具调用链路（通用）

```
服务端推理触发工具调用
  → mcp_runtime 校验权限
  → Connector Runtime (3002) 经 Socket.IO 下发到端侧
  → 端侧接收（Windows: agent.ts；Linux: agent/dispatch.py；扩展: background）
  → executor / tools 路由执行
  → 结果经 Socket.IO 回传
  → 服务端继续推理
```

## 端侧代码独立

- 各端目录**完全独立**，无 `device/shared/` 同步步骤。
- 改 Windows → 只改 `device/windows/`
- 改 Linux 服务器 Agent → 只改 `device/linux/`
- 改浏览器主扩展 → 优先 `device/browser/browser_MCP/`（Windows 原生输入构建再看 `device/browser/browser_MCP_win/`）
- 改 Android → `device/android/` 或 `device/android/android-adb/`

## "改 X 去哪里"

| 需求 | 位置 |
| --- | --- |
| Windows 桌面逻辑（Tauri） | `device/windows/src/`（TS）+ `device/windows/src-tauri/`（Rust） |
| Linux 服务器 Agent | `device/linux/agent/` |
| USB 烧录 / 串口监视 | `device/usb_flasher/` |
| OpenCut 视频编辑器 | `device/AI-FREE-app/`（启动时拉起 `127.0.0.1:5173`，暴露 `opencut.*`） |
| 浏览器自动化（主线） | `device/browser/browser_MCP/src/` |
| Windows 原生执行版浏览器自动化 | `device/browser/browser_MCP_win/` + `device/windows/src-tauri/`（browser bridge） |
| Android 本机执行 | `device/android/` |
| Android ADB 控制 | `device/android/android-adb/` |
| 工具执行底座（Windows） | `device/windows/src/runtime/` + `executor/` |
| 远程连接（画面 `rc:*` / 命令行 `rt:*`） | 设备端 Windows：`remote-control.ts` + `rc.rs` / `remote-terminal.ts` + `pty.rs`；Linux：`agent/remote_terminal.py`；服务端 `connector_runtime/dispatch/remote_control.py` / `remote_terminal.py`；web `useRemoteControl.ts` / `useRemoteTerminal.ts`；标准见 [`read.md`](read.md) |
| 本地 grok API 网关 | `device/cli_to_api/grok_cli_api/` |
| 本地 Antigravity API 网关 | `device/cli_to_api/antigravity_cli_api/` |
| 服务端工具路由 | `server/main/mcp_runtime/mcp/registry.py` + 设备权限策略 |

## 常见问题排查

| 症状 | 排查位置 | 典型原因 |
| --- | --- | --- |
| 设备无法注册/上线 | 端侧连接日志；Connector (3002) 是否运行 | Socket.IO 连接失败 / auth token 缺失 / `agent_socket_url` 错误 |
| 工具调用无响应 | Windows `executor/`；Linux `agent/dispatch.py` / `tools/` | 工具未上报 / 权限未开 / 超时 |
| PowerShell 执行失败 | `windows/src/runtime/powershell-runner.ts` | 解释器不可用或脚本错误 |
| Shell 执行失败 | `windows/.../shell-runner.ts` 或 Linux `tools` | 可执行文件路径错误 / 权限不足 |
| 权限被拒 | 服务端 `DevicePermissionPolicy` + 端侧 permission-guard | 控制台未勾选工具权限 |
| 浏览器扩展不生效 | `browser_MCP/dist` 是否最新构建 | 未 `npm run build` 或加载了错误目录 |
| 远控画面黑屏 | Windows `remote-control.ts` / `rc.rs`；ICE 配置 | STUN/TURN 不通 / 抓屏失败 |
| 命令行远控无输出 | `remote-terminal` / Linux `remote_terminal.py` | PTY 未建立 / Socket.IO relay 中断 |

## 命令

```bash
# Windows 桌面壳（Tauri 2，需 Rust 工具链 + VS Build Tools）
cd device/windows
npm install
npm run tauri:dev       # 开发模式
npm run tauri:build     # NSIS 安装包
npm run typecheck       # 仅前端 TS 检查

device\windows\run.bat
device\windows\build.bat

# Linux 服务器 Agent
cd device/linux
# 见 install.sh / run.sh / README.md（Python + systemd）

# USB 烧录设备
cd device/usb_flasher
# 复制 .env.example 为 .env 后运行 run.bat / run.sh

# OpenCut 已并入 AI-FREE：启动软件后访问 http://127.0.0.1:5173/ ，工具为 opencut.*

# 浏览器扩展（主线）
cd device/browser/browser_MCP
npm install
npm run build            # → dist/（Chrome 加载已解压扩展选 dist 或按 README）
npm run dev              # watch

# Android
# 见 device/android/README.md 与 android-adb/README.md
```

## 注意点

- **提交顺序**：先在具体设备子仓库提交并推送，再在 `HeySure-Device` 提交子模块指针，最后在根仓库提交 `device` 指针。
- **Windows Tauri 需本机验证**：Rust + WebView2 +（打包时）VS Build Tools；CI 通常只能做 `typecheck`。
- **Linux Agent 是服务器管控壳**，不是带 UI 的桌面 Electron；定位见 `linux/README.md`。
- **`dist/` `node_modules/` `.env` `src-tauri/target/`** 等已 gitignore，不要提交。
- **Android 两形态独立**：`android/` 与 `android/android-adb/` 不共享代码。
- **接入协议以 [`read.md`](read.md) 为准**：自定义服务接入、事件名、回包契约均在此文档。
