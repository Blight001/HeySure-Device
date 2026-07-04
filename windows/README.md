# HeySure Device — Tauri 2 原型（Windows）

`doc/tauri2-migration-report.md` **第一阶段**的落地实现：用 Tauri 2 替换 Electron 桌面壳，
只验证核心链路 —— 打开 UI、保存设置、登录并连接服务端、接收/注册动态 MCP、执行
PowerShell / shell / Python 工具。**远控已迁移**：原生抓屏（`xcap`，无屏幕共享弹窗）+ WebRTC 画面
+ enigo 键鼠注入，实现「直接远控」（见下文「远程控制」）；**截图 MCP 工具、离线聊天头像缓存仍未迁移**。

> **本目录已成为 Windows 桌面壳的正式实现**：原 Electron 版 `device/windows/` 已被本 Tauri 实现取代并改名为 `device/windows/`（下文「Electron 版」均指已退役的旧实现，仅作架构对照）。

## 架构对照

| Electron 版 | Tauri 版 | 说明 |
| --- | --- | --- |
| main process（Node） | `src-tauri/src/main.rs` | 只保留原生职责：托盘、窗口、设置持久化、临时脚本 |
| `runtime/process-guard.ts` | `src-tauri/src/guard.rs` | 超时 / 并发上限 4 / 输出截断 1MB / 一键暂停，语义一致 |
| `device.ts`（Socket.IO 协议） | `src/agent.ts` | **逐行移植**，协议不变；socket.io-client 直接跑在 WebView |
| `executor/dynamic.ts`（动态 MCP） | `src/executor/dynamic.ts` | program / js / runtime 三种 code_kind 全保留 |
| `runtime/*-runner.ts` | `src/runtime/*-runner.ts` | 拼装逻辑在 TS，spawn 走 Rust `run_process` 命令 |
| `permission-guard.ts` + 主进程弹窗 | `src/runtime/permission-guard.ts` + 页面内弹窗 | 策略逻辑原样，confirm 改为页内模态 |
| electron-store | `settings.json`（app config 目录，Rust 读写） | |
| ipc/* + preload | （不存在） | 协议就在 WebView 里，无需 IPC 桥 |
| `remote/remote-control-host.ts` + 隐藏 renderer + renderer/remote-control | `src/remote-control.ts` | **合二为一**：WebView 原生有 WebRTC，无需隐藏 peer renderer |
| `remote/desktop-source.ts` + `desktopCapturer`（静默截屏） | `src-tauri/src/rc.rs`（xcap 原生捕获）→ canvas → `captureStream()` | **不走 `getDisplayMedia`**，无「屏幕共享」弹窗/提示；Rust 抓主屏 JPEG，前端画到 canvas 再转 WebRTC 视频轨 |
| `remote/input-injector.ts`（robotjs） | `src-tauri/src/rc.rs`（enigo） | 归一化 [0,1] 坐标 → 主屏像素，键鼠注入语义一致（含 CJK `text()`） |

之所以能把协议层留在 WebView：服务端 Gateway 与 Socket.IO 均放开了 CORS
（`allow_origins=["*"]` / `cors_allowed_origins='*'`），WebView 里的 fetch 和
websocket 可直连服务端。

## 独立资产与代码

Tauri 原型已停止从 device/shared 同步。

可移植的少量文件（constants.ts、server-url.ts、executor/catalog.ts、runtime/permission-guard.ts）已作为独立副本保留在本地 src/。

所有修改直接在 `windows/src/` 及 `src-tauri/` 中进行。

图标现从本地 `assets/` 读取（tauri.conf + include_bytes 已更新）。

## 环境要求

- Node.js ≥ 18（前端构建）
- **Rust 工具链**（[rustup](https://rustup.rs/)，stable-msvc）
- **Visual Studio Build Tools**（含"使用 C++ 的桌面开发"工作负载，MSVC 链接器）
- WebView2 Runtime（Windows 11 自带；旧系统由 NSIS 安装器自动引导安装）

## 命令

从 `device/windows/` 目录双击：

```bat
run.bat
build.bat
```

手动命令：

```bash
cd device/windows
npm install
npm run tauri:dev      # 开发模式（前端热更新 + Rust 调试构建）
npm run tauri:build    # 产出 NSIS 安装包（src-tauri/target/release/bundle/nsis/）
npm run typecheck      # 仅前端 TS 类型检查（无需 Rust 工具链）
```

## 验证清单（对应报告的判断标准）

- [ ] 打开 UI、保存设置、托盘常驻
- [ ] 登录 → `device:register` → `device:registered`（作坊分配 AI）
- [ ] 服务器 `device:tool-config` 下发动态 MCP 并出现在工具列表
- [ ] 本地工具测试页执行 shell / powershell runtime 工具
- [ ] 权限确认弹窗（confirm 级权限标签）、一键暂停
- [ ] 远程控制：Web 控制台发起 → 看到实时主屏 → 鼠标/键盘/滚轮/中文输入生效
- [ ] 安装包体积对比 Electron 版（预期 ~10MB vs ~100MB+，待实测）

## 已知取舍（第一阶段范围内）

- **MCP 工具驱动**：出厂默认桌面工具集已全部迁移到 PowerShell 驱动（Windows PowerShell 5.1 优先）。仅支持 `powershell` 和 `shell` 运行时；Python runtime 已完全移除（不再支持用户自建 `runtime=python` 工具）。
- **不再支持 Python**：`mcp.manage_dynamic_tool` 中的 runtime 枚举已移除 `python`。如需 Python 能力，请使用其他平台或将逻辑迁移到 PowerShell/shell。
- **`mcp.manage_dynamic_tool` 的 `get_source`/源码检视不可用**：应用源码以打包产物分发，
  没有可读的 `src/**.ts`；`inspect` 仍返回注册定义与 handler 源码。
- **本地动态工具 JSON 无文件监听热加载**（Electron 版有 fs.watch）；改用 `action=reload`。
- **与 Electron 版同时运行会冲突**：默认 deviceId 都是 `agent-<hostname>`，
  同时连接会互相顶替；如需并行测试，改 `%APPDATA%/com.heysure.device.win.tauri/settings.json`
  里的 `deviceId`。
- **远程控制的屏幕捕获走原生路径，不用 `getDisplayMedia`**：WebView2 无 Electron 的
  `desktopCapturer`，而 `getDisplayMedia` 会弹「屏幕共享」选择框/常驻提示条——不符合「直接远控」。
  改为 Rust 端 `xcap` 抓主屏 → JPEG（`image`）→ **原始字节**（`tauri::ipc::Response`，前端收到
  `ArrayBuffer`，不再 base64）→ 前端 `createImageBitmap` 解码后画到 `<canvas>` →
  `canvas.captureStream()` 作为 WebRTC 视频轨。清晰度/帧率调优（均在 `src/remote-control.ts` 顶部）：
  `JPEG_QUALITY=82`（源帧清晰度）、`CAPTURE_FPS=20`、`MAX_VIDEO_BITRATE`（抬高 VP8 码率上限）；
  视频轨设 `contentHint='detail'` + `degradationPreference='maintain-resolution'`，让 WebRTC
  在压力下优先掉帧而非降分辨率（避免文字发糊）。**代价**：帧路径仍是「原生抓屏+JPEG 编码+IPC」，
  纯 Rust JPEG 编码偏慢；若仍不够可换 `turbojpeg`/DXGI Desktop Duplication，或对静止帧做差分跳过。
  引入 `xcap`+`image` 会增大安装包体积（与本迁移的「体积优先」目标有取舍）。
- 仍未迁移：截图 MCP 工具、离线聊天头像缓存。

## 目录结构

```
windows/
  index.html / src/         前端（Vite + 原生 TS，无框架）
    agent.ts                设备协议（Socket.IO 注册/任务分发/工具下发）
    api.ts settings.ts      REST 登录、设置持久化
    executor/               工具注册表 + 动态 MCP 引擎（program/js/runtime）
    runtime/                运行器底座（权限守卫 + 三个 runner + 探测）
    remote-control.ts       远控 WebRTC peer（原生抓屏→canvas→captureStream + 控制通道 + 信令）
    native.ts               与 Rust 的唯一边界（invoke 封装）
  src-tauri/
    src/main.rs             命令 + 托盘 + 持久化
    src/guard.rs            进程守护（超时/并发/截断/暂停）
    src/rc.rs               远控原生抓屏（xcap→JPEG）+ 键鼠注入（enigo）
```

## 远程控制

链路与 Electron 版一致（信令 `rc:*` 经 `connector_runtime/dispatch/remote_control.py`
中继，媒体与输入走点对点 WebRTC）。桌面是 **offerer**。

**屏幕画面（直接远控，无屏幕共享）**：不使用 `getDisplayMedia`（那会弹「屏幕共享」框/提示条）。
改为 Rust `rc_capture_frame` 用 `xcap` 静默抓主屏 → JPEG → 原始字节（`ArrayBuffer`，非 base64）；
前端 `createImageBitmap` 解码后把每帧画到一个离屏 `<canvas>`，用 `canvas.captureStream()` 得到
MediaStream 作为 WebRTC 视频轨。抓帧循环自节流（`setTimeout` 递归，避免慢帧堆叠），首帧确定画布尺寸
与视频分辨率。清晰/流畅度调优见 `src/remote-control.ts` 顶部常量与 `tuneVideoEncoder`。

**输入**：`control` DataChannel 收浏览器下发的归一化鼠标/键盘事件，经 Rust `rc_inject_input`
（enigo）注入本机（含滚轮、修饰键、CJK `text()`）。抓屏走 `spawn_blocking`，与输入注入互不阻塞，
远控手感保持跟手。

`agent.ts` 注册时宣告 `remote_control` capability，服务端据此放行；未宣告则回
「该设备版本不支持远程控制」。
