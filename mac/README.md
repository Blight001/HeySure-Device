# HeySure Agent - Mac Desktop Edition

An Electron desktop agent that connects to the HeySure server over Socket.IO,
registers itself as a desktop endpoint, and exposes the same desktop-agent
feature surface as `device/windows`.

This shell uses the shared desktop implementation from `device/shared/src`.
The build step runs `scripts/sync-shared.js`, copying shared modules into
`src/` before TypeScript compiles. Edit shared logic in `device/shared/src`,
not in the generated copies under this directory.

## Tools

| Group | Tools | Implementation |
| --- | --- | --- |
| Shell | `shell.run` | shared runtime shell runner |
| Keyboard | `keyboard.type` `keyboard.press` | robotjs |
| Mouse | `mouse.move` `mouse.click` `mouse.double_click` `mouse.right_click` `mouse.scroll` `mouse.drag` | robotjs |
| Clipboard | `clipboard.get` `clipboard.set` | Electron `clipboard` |
| Windows | `window.list` `window.focus` `window.close` | server-provided runtime tools / native bridge where available |
| Speech | `speech.speak` | server-provided runtime tools / native bridge where available |
| Screen / Vision | `vision.capture` `vision.capture_mouse` | Electron `desktopCapturer` + robotjs coordinates |
| Input monitor | `hands.start` `hands.stop` `hands.snapshot` `hands.events` `hands.mouse` | shared desktop bridge |
| Offline chat | local chat window and configured model settings | same UI/IPC flow as Windows |

## System Requirements

- macOS with Node.js and npm installed.
- Xcode Command Line Tools for native module compilation:

  ```bash
  xcode-select --install
  ```

- macOS may require granting the app or Terminal these permissions for full
  desktop control:
  - Accessibility
  - Screen Recording

## Run

```bash
cp .env.example .env
bash ./run.sh
```

Or manually:

```bash
npm install
npm run rebuild
npm run dev
```

## Package

```bash
npm run package
```

Or use the helper script:

```bash
bash ./build.sh
```

The packaged app is written to `release/`.

## How It Registers

On login, the agent emits `device:register` with
`platform: "mac-desktop (<hostname>)"` and `isMacDesktop: true`. The platform
string includes `desktop`, so existing server-side desktop routing continues to
treat it as a desktop endpoint.

## 联调测试

macOS 桌面壳与 win/linux 一致：内置仅 `mcp.manage_dynamic_tool`，业务能力来自服务端
**runtime 工具**（`server/main/api/services/device_runtime_tools/`）。UI 与
`mcp.test` 由 `device/shared` 同步。

### 测试前准备

1. 启动后端 + Web 控制台
2. `device/run-mac.sh` 或本目录 `npm run dev`
3. `npm run setup:python` 初始化 `device_runtime/python/.venv`
4. **系统设置** 为终端或打包应用授予 **辅助功能**、**屏幕录制**（键鼠/截图完整能力）
5. 桌面端登录、绑定 AI，仪表盘开放对应 MCP 工具

### 方式一：桌面端 mcp.test

主窗口 → **MCP 工具** → **测试调用 (mcp.test)**。

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

键鼠类工具会移动真实光标，冒烟时建议跳过或经确认后在安全应用（如 TextEdit）中测。

### 方式二：Web 知识库继承测试

知识库 → 继承技能 → 在线 mac 设备工具 → **开始测试**。

### 方式三：AI 完整回归

```text
请对 HeySure macOS 桌面端做联调测试并出报告。使用已连接 Mac 桌面设备；
文件仅在工作区。顺序：shell.run → fs.list → fs.write/read → screen.info →
vision.capture → window.list → clipboard 往返 → process.list。
键鼠类需先征求我同意。输出结构化报告。
```

### 常见问题

| 现象 | 排查 |
| --- | --- |
| 截图/键鼠无权限 | 系统设置 → 隐私与安全性 → 辅助功能 / 屏幕录制 |
| Python 工具失败 | `npm run setup:python`；检查 venv |
| 工具列表空 | 设备未连线或工作区未种子化 |

完整流程说明亦见 [`device/windows/README.md`](../windows/README.md)。
