# device/shared — 桌面端 win/linux/mac 共享源（单一真相源）

`device/windows`、`device/linux` 与 `device/mac` 是同源 Electron 壳。本目录是它们**完全相同**
（或仅平台常量不同）那部分代码的**唯一真相源**。

## 工作方式（构建期覆盖式同步）

- `shared/src/` 镜像各壳 `src/` 的目录布局。
- `shared/assets/` 是桌面端通用图标资源的唯一真相源。
- 每个壳的 `npm run build` / `npm run dev` 在 `tsc` 之前调用 `shared/scripts/sync-shared.js`，
  把 `shared/src/**` 覆盖拷贝进自己的 `src/**`，把 `shared/assets/**` 覆盖拷贝进自己的 `assets/**`。
- 拷贝出的副本在 `.gitignore` 中被忽略，**不提交**。
- 因为保持原始相对布局，共享文件里的相对导入（如 `../store`、`./screen`）
  在覆盖后会解析到各壳自己的平台实现，无需改写。

## 铁律

- **只改 `device/shared/src/` 与 `device/shared/assets/` 里的文件，绝不改各壳下的同名副本**（那是生成物）。
- 平台差异不要写死在共享代码里：通过各壳 `src/platform.ts` 导出的 `platformProfile`
  读取（见 `shared/src/platform-profile.ts`）。
- 新增共享文件后，记得在根 `.gitignore` 的 "Device shared modules" 区块补上对应路径。

## 当前共享内容

- 完全相同：桌面图标资源 `assets/*`，以及 `main.ts`、`constants.ts`、`server-url.ts`、`preload.ts`、`capture-bridge.ts`、`ipc/*`
  （auth/settings/index/device/offline-chat/ai-config/mcp）、`services/*`（activity-log/auth-state/
  avatar-cache/reauth/server-client/offline-ai）、`tools/*`（display/filesystem/vision）、
  `tools/shared/{robot,coordinates}.ts`、`windows/offline-chat-window.ts`、`renderer/*` 桌面端 UI。
  （keyboard/clipboard 已随阶段四删除，改由服务器 python 工具替代。）
- 仅平台常量不同（经 `platformProfile` 参数化）：`executor/registry.ts`、`executor/index.ts`、
  `ipc/ai-config.ts`、`services/device-runtime.ts`、`windows/main-window.ts`、`windows/tray.ts`。
- 动态工具管理器：`executor/dynamic.ts`。
- 受控执行器底座 `runtime/`（设备端MCP代码下放长期方案 §3.2/§5/§7）：
  - `process-guard.ts`：统一 spawn——超时(SIGTERM→SIGKILL)、并发上限、输出截断、一键暂停/中止；
  - `shell-runner.ts`：按 OS + `shell` 提示选解释器（win cmd/powershell/pwsh，其余 bash），走 guard；
  - `powershell-runner.ts`：自包含编码 + 解释器解析（win 优先 powershell.exe，其余 pwsh）；
  - `python-runner.ts`：解析解释器（`HEYSURE_PYTHON` → `device_runtime/python/.venv` → PATH），
    注入 `args`、回收 `result`。venv 由各壳 `npm run setup:python` 在目标机器创建
    （依赖见 `device/<壳>/device_runtime/python/requirements.txt`，`.venv` 已 gitignore）；
  - `permission-guard.ts`：权限标签 → allow/confirm/deny，confirm 经宿主弹窗回调，无回调则 fail-safe 拒绝；
  - `artifact-bridge.ts`：受控 artifacts 目录、大小上限、保存/读取（mime + sha256）。
  - 这些模块**不依赖 electron**，宿主通过 `initArtifactBridge` / `registerConfirmHandler` 注入。
  - `tools/shell.ts`（`shell.run` 内置工具）已重构为 `shell-runner` 的薄封装。

共享构建辅助脚本位于 `shared/scripts/`：`sync-shared.js`、`copy-renderer.js`、`setup-python.js`。

平台分叉文件（`device.ts`、`store.ts`、`platform.ts`、各 `tools/{mouse,screen,window,...}.ts` 等）
仍各自保留在各壳 `src/` 下，不在此目录。

## 联调测试

本目录**不单独运行**，联调请在具体平台壳上执行（`device/windows`、`device/linux`、
`device/mac`）。改共享代码后的验证流程：

1. **只改** `shared/src/` 或 `shared/assets/`，不要改各壳下 sync 出的副本
2. 在至少一个目标平台执行 `npm run dev`（会自动 `sync-shared.js`）
3. 打开该平台桌面端 → **MCP 工具** → 任选 1～2 个工具做 `mcp.test`（如 `shell.run`、`fs.list`）
4. 若改动涉及 `renderer/`、`ipc/mcp.ts`、`runtime/*`，三端各抽测一次更稳妥

各平台完整测试清单、AI 回归指令与排障表见：

- [`device/windows/README.md`](../windows/README.md)（Windows，含最完整联调说明）
- [`device/linux/README.md`](../linux/README.md)
- [`device/mac/README.md`](../mac/README.md)
- 浏览器扩展：[`device/extension/README.md`](../extension/README.md)
