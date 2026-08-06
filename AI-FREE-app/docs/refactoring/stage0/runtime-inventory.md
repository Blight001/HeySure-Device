# 运行时契约清点（阶段 0）：HTTP / 存储 / 环境变量 / 全局状态

生成方式：grep 扫描（2026-07-17）。整改期间这些契约默认冻结，任何变更须在此登记。

## HTTP 端点（客户端 → 后端）

协议细节见 [../../api/HTTP请求说明.md](../../api/HTTP请求说明.md)。代码中出现的路径：

| 端点 | 域 |
|---|---|
| `/api/validate_key` `/api/unbind_device` | 账号/授权 |
| `/api/account` `/api/fetch_cookie` | 账号 |
| `/api/ai-control/chat` `/api/ai-control/models` `/api/ai-control/gift-codes/redeem` | AI |
| `/api/vip/plans` `/api/vip-gift-codes/redeem` `/api/wool-gift-codes/redeem` | 授权/VIP |
| `/api/proxy/client/session` `/api/proxy/client/quota` `/api/proxy/client/usage` `/api/proxy/gift-codes/redeem` | 网络/流量 |
| `/api/get_proxy_status` `/api/control_proxy` `/api/get_pac_config` | 网络 |
| `/api/user_announcement` | 公告（HTTP 轮询，见 lib/announcement-poller.js） |
| `/api/get_tutorial_url` `/api/client/config` | 杂项 |

服务器地址解析：`services/server-resolver.js`（支持 `address_TCP` 元数据兜底反推，见 config/index.js 头部注释）。

## 本地存储路径

| 路径 | 内容 | 访问代码 |
|---|---|---|
| `%APPDATA%/ai-free/`（userData） | 应用数据根 | 多处 `app.getPath('userData')` |
| `userData/store/content` | 用户凭证（加密存储） | lib/account-storage.js |
| `userData/account_sessions/` | 账号会话数据 | lib/account-storage.js |
| `userData/chromium-profiles/` | 浏览器 Profile | services/browser-partitions.js |
| `userData/logs/` | 运行日志 | entry/start-app.js |
| `core/store/`（开发树内） | 开发模式 store 回退 | config/index.js `getStorePath` |
| `resources/clash-mini/` | Clash 内核与 geo 资源 | ipc/register/clash-mini-core.js |

## 环境变量（按出现频次）

| 变量 | 用途 |
|---|---|
| `AI_FREE_CHROMIUM_HANDSHAKE` / `AI_FREE_CHROMIUM_PATH` / `AI_FREE_CHROMIUM_REQUIRED` / `AI_FREE_BROWSER_RUNTIME` | Chromium fork 运行时 |
| `AI_FREE_SERVER_MODE` | 服务器模式（remote / 本地），v-start.bat 使用 |
| `ACCOUNT_SERVICE_URL` / `SERVER_BASE` | 后端地址覆盖 |
| `NODE_ENV` / `PLATFORM` | 运行环境 |
| `APP_BOOT_MODE` / `CONTROL_PANEL_MODE` / `CONTROL_PANEL_ONLY` | 侧边栏调试窗口模式 |
| `SIDEBAR_HTML_PATH` | 侧边栏页面路径覆盖 |
| `FORCE_HTTP_COMPAT_MODE` / `NETWORK_COMPAT_MODE` / `DISABLE_TCP_CONNECTION` / `NO_TCP` | HTTP 兼容模式（后两个为遗留别名） |
| `AI_FREE_AUTOMATION_BRIDGE_PORT` | 自动化桥端口（默认 18765） |
| `AI_FREE_UI_CAPTURE` / `AI_FREE_SHELL_UI_CAPTURE` / `AI_FREE_ACCOUNT_UI_CAPTURE` | UI 截图调试 |
| `AI_FREE_SMOKE_URL` / `AI_FREE_SMOKE_AUTO_CLOSE` / `AI_FREE_ACCEPT_*` / `AI_FREE_INPUT_MANUAL_WAIT_MS` | 冒烟/验收脚本 |
| `ELECTRON_RUN_AS_NODE` | 本机 shell 默认 =1 的坑，run-electron.js 自动清除 |

## 业务性全局状态（阶段 2 迁入 AppContext 的清单）

| 全局变量 | 用途 | 出现次数 |
|---|---|---|
| `global._isShuttingDown` | 退出流程标志 | 7 |
| `global._pendingUpdateInstallVersion` / `_pendingUpdateInstallTarget` | 更新安装挂起状态 | 4+4 |
| `global._mainAppExiting` | 主应用退出标志 | 2 |
| `global.__APP_SESSION_ID__` | 会话 ID | 2 |
| `global.__APP_CONSOLE_HISTORY__` / `__APP_DEBUG_CONSOLE_WRITE__` | 控制台历史/调试写入 | 1+2 |
| `global.willQuit` | 退出意图 | 1 |

另有大量隐式共享状态经 bootstrap.js 的 deps 对象注入（约 100+ 字段），见 ipc-inventory.md 与 flows.md。
