# HeySure Agent — Windows Desktop Edition

Electron desktop shell that connects to the HeySure server over Socket.IO,
registers as a **desktop** endpoint, and runs MCP tools pushed from the server.

The shell itself is a **controlled runner**: it only ships one built-in MCP tool
(`mcp.manage_dynamic_tool`, the dynamic-tool bootstrap). Everything else —
`shell.run`, `keyboard.*`, `mouse.*`, `vision.*`, `window.*`, `fs.*`, and so
on — is a **server-pushed runtime tool** (python / powershell / shell) whose
definitions live under `server/main/api/services/device_runtime_tools/` and are
seeded into the user workspace at `device_tools/desktop/` on first connect.

Shared desktop logic is synced from `device/shared/src/` before each build.
Edit shared modules there, not in the generated copies under this directory.
See [`device/shared/README.md`](../shared/README.md).

## Architecture

```
HeySure Server ──socket.io──▶ main.ts / agent-runtime
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              executor/         runtime/         renderer/
         (mcp.manage_dynamic)  (python/shell/   (login, MCP UI,
                               powershell)      mcp.test)
```

| Layer | Role |
| --- | --- |
| `src/main.ts` | Electron lifecycle, tray, window |
| `src/device.ts` | Socket registration, task dispatch |
| `src/executor/` | Built-in tool registry (`catalog.ts` → dynamic manager only) |
| `src/runtime/` | Controlled execution (process guard, python/shell runners) |
| `src/renderer/` | Desktop UI (synced from `device/shared/src/renderer/`) |
| `src/tools/` | Platform bridges still used by runtime python bodies (robot, screen, …) |

Default runtime tool bodies: `server/main/api/services/device_runtime_tools/bodies/`.
Metadata: `definitions.json` in the same folder.

## System requirements

- Windows 10/11, Node.js 18+
- Native module `robotjs` (rebuilt against Electron via `npm run rebuild`)
- Python 3 for runtime tools that use `pyautogui` / device bridges:

  ```bash
  npm run setup:python   # creates device_runtime/python/.venv
  ```

- Optional: PowerShell / pwsh for `shell.run` with `shell: "powershell"`

## Run (development)

From repo root:

```bat
device\run-windows.bat
```

Or manually:

```bash
cp .env.example .env    # set SERVER_URL, WORKSPACE_ROOT, etc.
npm install
npm run rebuild
npm run dev
```

## Package

```bash
npm run package         # → release/HeySure Device Setup *.exe
```

Or from repo root: `device\build-windows.bat`

## How it registers

On login the agent emits `device:register` with
`platform: "win-desktop (<hostname>)"` and `isWindowsDesktop: true`. The server
treats it as a desktop endpoint and syncs runtime tool definitions from the
user workspace to the device.

## Directory layout

```
device/windows/
├── .env.example
├── package.json
├── src/
│   ├── main.ts           # Electron entry
│   ├── device.ts         # Socket + task handling (platform-specific)
│   ├── platform.ts       # win-desktop profile + capability hints
│   ├── executor/         # Built-in MCP catalog (dynamic manager only)
│   ├── runtime/          # Synced from shared; shell/python runners
│   ├── ipc/              # Main ↔ renderer IPC
│   ├── renderer/         # Synced UI (MCP list + mcp.test)
│   ├── tools/            # Windows-native bridges (mouse, screen, window, …)
│   └── windows/          # Main window + tray
└── device_runtime/python/  # venv for runtime tools (gitignored .venv)
```

## 联调测试

桌面端能力来自**服务端下发的 runtime 工具**（首次连接会种子化到工作区
`device_tools/desktop/`）。测试前请确认 Python 虚拟环境已就绪（`npm run setup:python`）。

### 测试前准备

1. 启动后端四进程 + Web 控制台（`server\run.bat`、`web\run.bat`）
2. 启动本机 Windows 壳：`device\run-windows.bat`
3. 桌面端登录账号，确认 Socket 已连接、已绑定待测 AI 成员
4. 仪表盘 → 该 AI 成员 → 绑定 **Windows 桌面** 设备，MCP 权限勾选需要的 runtime 工具
5. 系统全能设置里「单次运行最多步骤」完整回归建议 ≥ 60

出厂默认工具清单位于
`server/main/api/services/device_runtime_tools/definitions.json`（`shell.run`、
`fs.*`、`vision.*`、`mouse.*`、`window.*` 等）。

### 方式一：桌面端 UI 单工具冒烟（mcp.test）

适合改完 runtime 执行链或平台桥接后快速验证。

1. 打开 HeySure Device 主窗口 → **MCP 工具** 页
2. 选中工具 → 展开 **测试调用 (mcp.test)**
3. 填入 JSON → **测试** → 查看原始返回

常用安全示例（优先在工作区内操作）：

```json
{ "command": "echo HeySure smoke test", "shell": "powershell" }
```

```json
{ "path": ".", "limit": 20 }
```

```json
{ "path": "smoke-test.txt", "content": "hello from mcp.test" }
```

```json
{ "path": "smoke-test.txt" }
```

```json
{}
```

```json
{ "text": "HeySure clipboard test" }
```

```json
{}
```

键鼠类工具（`mouse.*`、`keyboard.*`）会真实操作系统，冒烟阶段建议跳过或仅在
记事本等安全窗口、经你确认后测试。

### 方式二：Web 控制台知识库继承测试

1. Web 控制台 → **知识库** → 打开某 AI 的继承技能
2. 在 **设备工具** 列表中找到在线 Windows 设备上的工具
3. 点击 **开始测试** → 选模型 → 发起单工具模型联调

适合验证「服务端 schema → 设备执行 → 模型理解参数」整条链路。

### 方式三：AI 成员完整回归（推荐）

将以下指令发给**已绑定 Windows 桌面设备**的 AI 成员。所有文件操作限定在
工作区（`WORKSPACE_ROOT`），不要操作系统敏感目录。

```text
请对 HeySure Windows 桌面端做一次完整联调测试，并输出结构化报告。

【环境】
- 使用当前已连接的 Windows 桌面设备
- 文件类工具仅在工作区内读写（如 smoke-test.txt）
- 键鼠类工具若可能影响桌面，先询问我是否继续

【测试要求】
按顺序执行，每项记录：入参、返回摘要、通过/失败/跳过；失败最多重试 1 次。

1) shell.run：powershell 执行 echo HeySure-win-test
2) fs.list：列出工作区根目录
3) fs.write + fs.read：写入并读回 smoke-test.txt
4) screen.info：读取屏幕信息
5) vision.capture 或 screen.capture：截图（只读）
6) window.list：列出窗口
7) clipboard.set + clipboard.get：剪贴板往返
8) process.list：列出进程（只读）
9) ui.inspect：Inspect 当前前台窗口（若可用）
10) 可选：keyboard.type / mouse.move（需我确认后继续）

【报告格式】
# Windows 桌面端联调报告
- 测试时间 / 设备在线状态 / 工作区路径
## 总览（通过/失败/跳过）
## 逐项结果表
## 失败与风险项
## 结论
```

### 通过标准（摘要）

- `shell.run` 返回退出码 0 且含预期输出
- `fs.write` → `fs.read` 内容一致
- 截图类工具返回 image/path 且无权限错误
- `window.list` / `process.list` 返回非空结构

### 常见问题

| 现象 | 排查 |
| --- | --- |
| 工具列表为空 | 设备未连接；或工作区尚未种子化，重登或检查服务端 |
| Python 工具失败 | 运行 `npm run setup:python`；检查 `.venv` 与 `pyautogui` |
| 键鼠无响应 | robotjs 未 rebuild；杀毒软件拦截；目标窗口未聚焦 |
| mcp.test 报权限 | 设置里该工具未「向软件端开放」 |
| 修改默认工具无生效 | 改的是工作区 `device_tools/desktop/` 副本，不是 bodies 种子源 |

修改 `device/shared/src/` 后在本目录执行 `npm run dev`（会自动 sync-shared）；
修改平台分叉文件（`src/device.ts`、`src/tools/*`）后同样需重启桌面端验证。