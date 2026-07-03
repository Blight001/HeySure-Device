# CLAUDE.md — device/ 端侧执行器（壳） (HeySure-Device)

六个端侧客户端（**只是运行在不同端的壳，本身不具备 agent 能力**），连接后端、注册为 endpoint。

**本目录是独立仓库** `HeySure-Device`。各平台（windows / linux / mac / extension / android）代码与资产完全独立，不再共享 `shared/`。
**桌面端已退化为受控运行器**：不再内置固定原生 MCP 工具，能力来自服务器下发的 runtime 工具（python/shell），由服务端编排/推理。

## 六种形态

| 子目录 | 形态 | 作用 |
| --- | --- | --- |
| `windows/` | Tauri 2 桌面（Windows） | 受控运行器（**原 Electron 壳已迁移为 Tauri**）：登录/注册 + 动态 MCP + runtime 执行（shell/PowerShell/python）+ 远控（**原生抓屏 xcap→canvas→WebRTC，不走 getDisplayMedia、无屏幕共享弹窗** + enigo 键鼠注入，`src/remote-control.ts` / `src-tauri/src/rc.rs`）；见 `windows/README.md` 与 `doc/tauri2-migration-report.md` |
| `linux/` | Electron 桌面（X11） | 同上（shell 默认 bash；含 STT/git 独有工具） |
| `mac/` | Electron 桌面（macOS） | 同上（需系统辅助功能 & 屏幕录制权限） |
| `extension/` | Chrome MV3 扩展 | 浏览器自动化与轻量客户端（固定工具目录） |
| `android/` | 原生 Kotlin App（方案 A） | 手机本机执行：点击/滑动/截屏（无障碍 + MediaProjection） |
| `android/android-adb/` | 宿主电脑 Node.js 进程（方案 B） | 经 ADB 控制手机；息屏/锁屏下也能注入 |

> 安卓两形态（A 本机 App / B 宿主 ADB）都以 `isAndroid:true` 注册，服务端统一识别为 `android` 类型。

## 桌面端架构（linux/mac，Electron）

> **注意**：`windows/` 已从 Electron 迁移为 **Tauri 2**，结构与下图不同（`src/agent.ts` `api.ts` `native.ts` `remote-control.ts` `executor/` `runtime/` + `src-tauri/` Rust 壳），详见 `windows/README.md`。下图仅适用于仍为 Electron 的 linux/mac。

```
device/linux/src/
  main.ts                    ← Electron 生命周期（窗口/托盘/IPC）
  device.ts                  ← 设备注册与 Socket.IO 连接（平台分叉文件）
  platform.ts                ← 平台抽象层（读取 platformProfile）
  services/
    agent-runtime.ts         ← Socket.IO 消息接收与分发（核心入口）
    device-runtime.ts        ← 工具执行底座（平台分叉）
    server-client.ts         ← 向 Gateway 发 HTTP 请求
    auth-state.ts            ← 认证状态机
    offline-ai.ts            ← 离线推理备用
  executor/
    catalog.ts               ← 仅注册 mcp.manage_dynamic_tool（动态工具引导器）
    registry.ts              ← 工具路由表（平台分叉）
    dynamic.ts               ← 动态工具管理（平台分叉）
    index.ts                 ← 统一调度入口
  runtime/                   ← 受控执行底座（各平台独立 copy）
    shell-runner.ts          ← Shell 脚本执行
    powershell-runner.ts     ← PowerShell 执行（Windows 专用）
    python-runner.ts         ← Python 脚本执行
    process-guard.ts         ← 超时/并发/输出管控
    permission-guard.ts      ← 权限标签校验
    artifact-bridge.ts       ← 工件目录与文件管理
  ipc/                       ← 主进程 ↔ 渲染进程通信
  renderer/                  ← 渲染进程 UI（托盘窗口/设置页/离线聊天）
  windows/                   ← Electron 窗口与托盘管理
  tools/                     ← 支持代码（mouse/screen/window 等，仅支持代码非工具实现）
  preload.ts                 ← 安全隔离层（contextBridge）
```

## 工具调用链路

```
服务端推理触发工具调用
  → 服务端 mcp_runtime 收到调用请求
  → Connector Runtime (3002) 经 Socket.IO 下发到端侧
  → device/services/agent-runtime.ts 接收消息
  → executor/index.ts 路由到对应 handler
  → runtime/shell-runner.ts 或 python-runner.ts 执行
  → 结果经 Socket.IO 返回服务端
  → 服务端继续推理
```

## 桌面端代码独立（停止共享）

自 2026-07 起，各桌面壳（windows / linux / mac）**完全独立**，不再使用 `device/shared/` 作为单一真相源。

- 通用逻辑已复制到各平台自己的 `src/` 下（可自由演化）。
- 资产（图标等）已复制到各平台 `assets/`。
- 辅助脚本已复制到各平台 `scripts/`（copy-renderer, setup-python, prepare-bundled-python）。
- 构建不再调用 sync-shared.js。
- Windows 现为 Tauri 壳（Rust + TS），其专有适配在 `windows/src-tauri/`。

**黄金规则**（新）：
- 改 Windows 逻辑 → 只改 `device/windows/src/`
- 改 Linux 逻辑 → 只改 `device/linux/src/`
- 改 macOS 逻辑 → 只改 `device/mac/src/`
- 改 Windows（Tauri）逻辑 → 只改 `device/windows/`（`src/` 前端 + `src-tauri/` Rust）
- 图标资源现在是每平台本地 `assets/`（构建配置已更新指向本地）。
- 平台分叉文件仍然各自维护（device.ts / store.ts / platform.ts 等）。

Linux 独有：`tools/ear.ts`（STT）、`tools/git.ts`（如存在）。

**平台差异参数化**：通过各壳 `src/platform.ts` 导出的 `platformProfile` 读取。

## "改 X 去哪里"

| 需求 | 位置 |
| --- | --- |
| Windows 桌面逻辑（Tauri 壳） | `device/windows/src/`（前端 TS）+ `device/windows/src-tauri/`（Rust） |
| Linux 桌面逻辑（含原共享通用部分） | `device/linux/src/` |
| macOS 桌面逻辑（含原共享通用部分） | `device/mac/src/` |
| 浏览器自动化 | `device/extension/src/` |
| Android 本机执行 | `device/android/`（独立 Kotlin 工程） |
| Android ADB 控制 | `device/android/android-adb/` |
| 工具执行底座（runner） | 各平台 `src/runtime/`（独立） |
| 服务端工具路由 | `server/main/mcp_runtime/mcp/registry.py` + 设备类型判断 `desktop_device_tools.py` |

## 常见问题排查

| 症状 | 排查位置 | 典型原因 |
| --- | --- | --- |
| 设备无法注册/上线 | `services/device.ts` 日志；Connector (3002) 是否运行 | Socket.IO 连接失败 / auth token 缺失 |
| 工具调用无响应 | `executor/index.ts`；`runtime/process-guard.ts` 超时日志 | 工具路由未注册 / 超时配置过短 |
| Shell/Python 执行失败 | `runtime/shell-runner.ts` / `python-runner.ts` | 可执行文件路径错误 / 打包版未带 bundled python（重新 npm run package） |
| 权限被拒 | `runtime/permission-guard.ts` | 服务端 `DevicePermissionPolicy` 未允许该工具 |
| 代码修改未生效 | 检查是否在目标平台目录下运行 npm 命令 | 各平台现在独立，无 sync 步骤 |
| macOS 截图/鼠标失败 | 系统偏好 → 安全性与隐私 → 辅助功能/屏幕录制 | 未授予系统权限 |
| Linux 注入失败 | Wayland 会话检测 | Wayland 下注入受限，需 X11 会话 |

## 命令

```bash
# 桌面端壳（linux / mac：Electron）
cd device/linux         # 或 mac
npm install
npm run dev             # 直接编译运行（已无 sync-shared）
npm run build           # → dist/（gitignored）
npm run setup:python    # 开发时配置 venv；正式打包会自动调用 prepare-bundled-python 内置完整 Python 运行时（用户无需装 Python）

# Windows 桌面壳（Tauri 2，需 Rust 工具链 + VS Build Tools）
cd device/windows
npm install
npm run tauri:dev       # 开发模式（无 sync-shared）
npm run tauri:build     # NSIS 安装包（内部触发 npm run build）
npm run typecheck       # 仅前端 TS 检查（CI/无 Rust 环境可用）

# 一键入口（位于各平台目录）
device\windows\run.bat     # Windows Tauri 直接运行（开发用）
device\windows\build.bat   # Windows Tauri 打包（NSIS 安装包）
device/linux/run.sh
device/linux/build.sh
device/mac/run.sh
device/mac/build.sh
device/extension/build.bat

# 浏览器扩展
cd device/extension
npm install
npm run build            # → dist/（Chrome 加载此目录为未打包扩展）
```

## 注意点

- **CI/远程环境无法运行 Electron GUI**：依赖 X11/原生模块，只能 `npm install --ignore-scripts` + `tsc --noEmit` 编译检查，实际行为必须本机验证。
- **Linux 推荐 X11 会话**：Wayland 下截图、鼠标注入受限。
- **macOS 需系统权限**：辅助功能 + 屏幕录制，需在系统偏好设置中手动授予。
- **`dist/` `release/` `node_modules/` `.env`** 已 gitignore，不要提交。
- **Android 两形态独立**：`android/`（Kotlin App）与 `android/android-adb/`（Node.js）不共享代码，各有独立 README。
