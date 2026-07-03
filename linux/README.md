# HeySure Agent — Linux Desktop Edition

An Electron desktop agent that connects to the HeySure server over Socket.IO,
registers itself as a **desktop** endpoint, and exposes a catalog of MCP tools
the AI can call to observe and control this Linux machine.

This is the Linux counterpart to `device/windows`. It shares the same architecture
(socket runtime, tool registry, executor, IPC, renderer) and re-implements the
platform-specific tools against native Linux utilities instead of PowerShell.

## Tools

| Group | Tools | Implementation |
| --- | --- | --- |
| Filesystem | `fs.list` `fs.read` `fs.write` | Node `fs` (cross-platform) |
| Shell / Git | `shell.run` `git.diff` | `child_process` via `/bin/bash` |
| Keyboard | `keyboard.type` `keyboard.press` | robotjs (X11) |
| Mouse | `mouse.move` `mouse.click` `mouse.double_click` `mouse.right_click` `mouse.scroll` `mouse.drag` | robotjs (X11) |
| Screen / Vision | `screen.capture` `screen.capture_region` `screen.info` `vision.capture` `vision.capture_mouse` | Electron `desktopCapturer` + robotjs |
| Display overlay | `display.box` `display.clear` | Electron transparent `BrowserWindow` |
| Clipboard | `clipboard.get` `clipboard.set` | Electron `clipboard` |
| Windows | `window.list` `window.focus` `window.close` | `wmctrl`, falls back to `xdotool` |
| Processes | `process.list` `process.kill` | `ps`, `kill` / `pkill` |
| Speech (TTS) | `speech.speak` | `spd-say` → `espeak-ng` → `espeak` |
| Input monitor | `hands.start` `hands.stop` `hands.snapshot` `hands.events` `hands.mouse` | robotjs cursor + `xdotool` active window polling |
| Speech (STT) | `ear.start` `ear.stop` `ear.latest` | External recognizer via `HS_STT_CMD` |

## System requirements

- An **X11** session is recommended. robotjs and `xdotool` target X11; under
  Wayland, key/mouse injection and window control are limited (run the session
  in Xwayland/X11 for full functionality).
- Optional CLI helpers (the tools degrade gracefully and report a clear hint
  when one is missing):

  ```bash
  sudo apt install wmctrl xdotool speech-dispatcher espeak-ng
  ```

- Building the native `robotjs` module needs X11 dev headers:

  ```bash
  sudo apt install build-essential libxtst-dev libpng++-dev
  ```

- Speech-to-text (`ear.*`) has no built-in engine on Linux. Point `HS_STT_CMD`
  at any program that listens on the mic and prints one JSON object per line,
  e.g. `{"type":"recognized","text":"hello","confidence":0.9}`.

## Run (development)

```bash
cp .env.example .env   # edit SERVER_URL etc. as needed
./run.sh               # installs deps, rebuilds robotjs, starts the app
```

Or manually:

```bash
npm install
npm run rebuild        # rebuild robotjs against Electron's ABI
npm run dev
```

## Package

```bash
npm run package        # builds an AppImage + .deb into release/
```

## How it registers

On login + AI assignment the agent emits `agent:register` with
`platform: "linux-desktop (<hostname>)"` and `isLinuxDesktop: true`. The server
classifies any agent whose platform string contains `desktop`/`windows` (or
whose `isWindowsDesktop`/`isLinuxDesktop` flag is set) as a **desktop** endpoint,
so the reported `capabilities` and `toolDefs` surface through
`mcp.list_tools` / `mcp.describe_tool` for the bound AI.

## 联调测试

Linux 桌面端与 Windows 同源：壳内仅内置 `mcp.manage_dynamic_tool`，其余 MCP 能力为
服务端下发的 **runtime 工具**（种子定义见
`server/main/api/services/device_runtime_tools/`）。共享 UI 与 `mcp.test` 来自
`device/linux/src/renderer/`（本地独立）。

### 测试前准备

1. 启动后端 + Web 控制台
2. 在 **X11** 会话下运行：`device/run-linux.sh` 或本目录 `npm run dev`
3. 首次测试前：`npm run setup:python`（runtime 工具依赖 venv）
4. 桌面端登录并绑定 AI 成员；仪表盘勾选所需 MCP 工具权限

### 方式一：桌面端 mcp.test

主窗口 → **MCP 工具** → 选中工具 → **测试调用**，填入 JSON 执行。

安全冒烟示例：

```json
{ "command": "echo HeySure smoke test" }
```

```json
{ "path": ".", "limit": 20 }
```

```json
{ "path": "smoke-test.txt", "content": "hello" }
```

```json
{}
```

`mouse.*` / `keyboard.*` 会操作真实 X11 桌面，默认跳过或仅在安全窗口经确认后测试。
`ear.*` 需配置 `HS_STT_CMD` 方可测 STT。

### 方式二：Web 知识库继承测试

知识库 → 继承技能 → 设备工具 → **开始测试**（选模型发起单工具联调）。

### 方式三：AI 完整回归

```text
请对 HeySure Linux 桌面端做联调测试并出报告。使用已连接的 Linux 桌面设备；
文件仅在工作区操作。顺序：shell.run → fs.list → fs.write/read → screen.info →
vision.capture → window.list → clipboard 往返 → process.list →（可选）git.diff。
键鼠类需先征求我同意。按「设备/通过失败表/结论」输出报告。
```

### 常见问题

| 现象 | 排查 |
| --- | --- |
| robotjs / 键鼠失效 | 确认 X11 而非纯 Wayland；安装 `libxtst-dev` 并 `npm run rebuild` |
| `window.*` 失败 | 安装 `wmctrl` / `xdotool` |
| 工具为空 | 设备离线或工作区未种子化 `device_tools/desktop/` |

详见 [`device/windows/README.md`](../windows/README.md) 联调测试（流程相同，平台差异见上文）。
