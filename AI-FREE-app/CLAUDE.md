# app2.1 — AI-FREE Electron 客户端

面向 AI/开发者的架构地图与操作指南。产品介绍见 [README_zh-CN.md](README_zh-CN.md)。

## 一分钟总览

- Electron 应用（打包名 AI-FREE），内嵌 Chromium fork 浏览器，主窗口是多标签浏览器壳，右侧内嵌本地侧边栏（AI 控制 + 浏览器配置）。
- 与后端纯 HTTP 通信（TCP 通道已移除，见下文"TCP 命名遗留"）；公告走 HTTP 轮询（`lib/announcement-poller.js`）。
- 用户日常运行的是 `appbuild/` 下的打包版。**改 `src/` 后必须 `npm run build:win` 重新打包才对打包版生效**；开发验证用 `npm start`。

## 入口链

```
package.json main
└─ src/app/main/main.js          （仅 1 行 require）
   └─ src/app/main/entry/start-app.js  （日志初始化、更新缓存清理）
      └─ src/app/main/bootstrap.js     （startMainApp：组装全部 deps 并启动）
```

## 目录职责（src/app/）

| 目录 | 职责 |
|---|---|
| `main/` | 主进程。`services/`（业务服务）、`ipc/`（IPC 注册）、`config/`（集中配置）、`composition/`（deps 组装）、`lib/`（HTTP 客户端、公告轮询、账号存储等）、`runtime/`、`browser-runtime/`（Chromium fork 对接）、`utils/` |
| `views/` + `renderer/` | 主窗口壳（app-shell.html + tabs 等 3 个渲染进程文件） |
| `sidebar/` | 本地内嵌侧边栏（file:// 直接 loadFile，无端口/远程服务）。`index.html` + `client/app/side/controllers/pages/`（ai-control.js、side-panel/modules/ 下 15 个功能模块） |
| `preload.js` | 唯一 preload，暴露 electronAPI |
| `shared/` | 主/渲染共享代码 |

关键服务（`main/services/`）：`app-lifecycle.js`（生命周期 + AI 对话工具派发）、`app-shell.js`（窗口/侧边栏装配）、`tab-manager.js`（标签）、`extension-manager.js`（扩展装载）、`app-updater.js`（自动更新）、`server-resolver.js`（服务器地址解析）、`ai-browser-window-tools.js`（AI 默认窗口控制工具 software_window_*，本地派发优先于插件桥）。

## IPC 结构

`ipc/register.js` 是编排入口，依次调用 `ipc/register/` 下 10 个模块 + `ipc/account_remember.js`：

clash-mini-actions / clash-mini-core（Clash 代理核心与进程管理）/ clash / extensions / license / misc / proxy-traffic-monitor / settings / store-utils / ui（含主题广播 app-theme-changed）

通道名目前散落在各 register 模块与渲染端，无集中常量表——查通道时全局 grep 字符串。

## 运行 / 构建 / 测试

| 命令 | 用途 |
|---|---|
| `npm start` | 开发启动（Chromium fork 正式模式） |
| `v-start.bat` | 远程服务器模式（AI_FREE_SERVER_MODE=remote） |
| `v-debug.bat` | 本地后端 58111 + FORCE_HTTP_COMPAT_MODE |
| `electron . --control-panel` | 把侧边栏开成独立调试窗口（`--control-panel-only` 只开该窗口） |
| `npm test` | node:test 全量（~2 秒，纯文本断言，无需 electron 环境） |
| `npm run build:win` | Windows 正式打包 → `appbuild/` |

### 坑（务必注意）

- **本机 shell 默认 `ELECTRON_RUN_AS_NODE=1`**：直接跑 electron.exe 会退化成纯 Node。`scripts/run-electron.js:8` 已自动清除该变量，npm scripts 不受影响；绕过脚本手动跑 electron 前需先 unset。
- **`npm test` 必须无参 `node --test`**：`node --test test/` 在 Node 24 下报 MODULE_NOT_FOUND。
- **`appbuild/`（约 4.4GB）是用户日常运行的打包产物，勿删勿改**；全库搜索时排除它（还有 node_modules）。
- 测试多为"读源码断言文本"风格，改动源码后断言可能漂移；跨行断言注意 CRLF（测试内已归一化的除外）。

## TCP 命名遗留

原 TCP 长连接通道已整体迁移纯 HTTP，但 `config/index.js` 中 `getTcpConfig`/`setRuntimeTcpConfig`/`RUNTIME_TCP_CONFIG` 等命名保留——它们现在仅承载服务器下发的 `address_TCP`（host:port）元数据，供 `getServerBase()` 兜底反推 HTTP 地址。详见 `src/app/main/config/index.js` 头部注释。**不要**据此认为存在真实 TCP socket。

## 超大文件地图（后续拆分候选，按行数降序）

| 文件 | 行数≈ | 职责 |
|---|---|---|
| `sidebar/.../pages/ai-control.js` | 2900+ | 侧边栏 AI 控制面板 |
| `main/ipc/register/clash-mini-core.js` | 2150 | Clash 核心 IPC + 进程管理 |
| `main/services/extension-manager.js` | 1900 | 扩展装载/刷新 |
| `main/services/app-lifecycle.js` | 1750+ | 生命周期 + AI 工具派发 |
| `main/services/app-updater.js` | 1450 | 自动更新 |
| `main/ipc/register/settings.js` | 1400+ | 设置 IPC |
| `renderer/controllers/pages/app-shell/tabs.js` | 1270 | 主窗口标签 |
| `main/services/tab-manager.js` | 1215 | 标签管理 |
| `main/lib/auth-cookie.js` | 1190 | 鉴权 cookie |

（`src/assets/extensions/` 下更大的文件属扩展资产，打包时混淆，一般不重构。）

## 相关文档

- `docs/api/HTTP请求说明.md` — 客户端-后端 HTTP 协议
- `docs/api/自动更新消息说明.md` — 更新消息格式
- `docs/clash-mini-geo-localization-spec.md` — Clash geo 本地化
- 后端在同级仓库 `../backserve/`（父仓库 + server_main/server_middle/server_web 三个 git 子模块）
