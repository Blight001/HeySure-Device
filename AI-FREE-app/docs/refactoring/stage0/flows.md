# 核心流程记录（阶段 0）

记录当前行为作为整改冻结基线。标注 `[待核]` 的环节在进入对应域整改（阶段 3/4）时补充细化。

## 1. 启动

1. `src/app/main/main.js` → `entry/start-app.js`：初始化文件日志（`userData/logs/run-*.log`）、清理更新缓存。
2. `bootstrap.js startMainApp()`：加载 config → 创建 state/auth/accountStorage/extensionManager 等 → 组装约 100+ 字段的 deps 对象 → `services/app-shell.js createAppShell(deps)`。
3. app-shell：创建主窗口（app-shell.html）+ 侧边栏 WebContentsView（loadFile `sidebar/index.html`）→ `registerIPC` 注册全部通道 → 恢复账号登录态（在线验证失败则"会员安全降级"）→ 启动公告轮询（licenseCache.validated 才轮询）。
4. Chromium fork：`scripts/run-chromium-fork.js` 正式模式，Named Pipe 握手（`AI_FREE_CHROMIUM_HANDSHAKE`）；AutomationBridge 监听 18765。
5. `--control-panel(-only)` / `APP_BOOT_MODE`：侧边栏独立调试窗口分支（app-shell.js `isControlPanelModeEnabled`）。

## 2. AI 对话

- 入口：侧边栏 `ai-control.js`（2900 行）→ `ai-control-chat` (handle，app-lifecycle.js:634)。
- 主进程：app-lifecycle 组装消息窗口（`lib/ai-control-message-window.js` 裁剪/摘要）→ 工具目录 = `services/ai-browser-window-tools.js`（`software_window` 默认注入，通过 `action` 选择操作）+ 插件桥工具 → HTTP `/api/ai-control/chat`。
- 工具派发：窗口工具本地执行优先；插件工具走 `services/browser-automation-bridge.js`；`needsPluginConnection && (!connections.length || !bridge?.dispatch)` 时报错。
- 流事件经 `ai-control-chat-event` 推回侧边栏；停止走 `ai-control-chat-stop`。
- 历史：`ai-control-history-*` 6 个通道 + `lib/ai-chat-history.js`。[待核] 本地/远端合并与损坏恢复细节。

## 3. 浏览器（标签/Profile）

- 标签：渲染端 `renderer/controllers/pages/app-shell/tabs.js` ↔ `add-tab`/`switch-tab`/`close-tab`/`reorder-tab`/`rename-tab` 等 (on) ↔ `services/tab-manager.js`；状态回推 `update-tabs`。
- 独立浏览器：`create-independent-browser` → Chromium fork 进程 + `userData/chromium-profiles/` Profile；历史记录 `get/open/rename/delete-browser-history`（settings.js，共享 openBrowserHistoryRecord 等导出）。
- 浏览器设置（UA/时区/语言/指纹）：`get/set/reset-ai-free-browser-settings`；指纹项 JS 注入 vs 内核项分流，改头走 session-request-headers。[待核]
- 孤儿清理：`cleanup-orphan-browser-profiles`、退出时 `cleanupAllBrowserSessionData`。

## 4. 网络魔法（Clash）

- 应用级开关：开启后所有软件内置浏览器统一走 Clash 本地混合端口；关闭后移除全局覆盖并恢复各浏览器原有代理设置。
- IPC：`start/stop-clash-mini`、`get-clash-mini-status`、`switch-clash-mini-proxy`、`get-clash-mini-proxy-options`、`save/get-clash-config`、`test-min-latency`、`update-system-proxy-enabled`（clash.js 注册，clash-mini-core.js 2150 行实现进程管理）。
- 已知风险：config 运行时从 jsdelivr 拉 geo/规则，国内失败退化 MATCH,DIRECT（见 docs/clash-mini-geo-localization-spec.md 的本地化方案）。
- 流量配额：`get-proxy-traffic-quota`、`redeem-proxy-traffic-gift-code` + proxy-traffic-monitor.js。

## 5. 账号

- 登录/会话：`account-authenticate`（app-lifecycle.js:1189）、`account-get-session`、`account-logout`（登出清 setRuntimeTcpConfig(null)）。
- 凭证存储：`lib/account-storage.js`（`userData/store/content` + `account_sessions/`）；记住密码走 `ipc/account_remember.js`（9 通道：save/get/delete-accounts、switch-account、cookies 导入等）。
- Cookie 注入：`fetch-cookies` → `/api/fetch_cookie` → `lib/auth-cookie.js`（1190 行）注入目标站点。
- 账号中心弹窗：`open/close/toggle-account-center-popup` + `account-popup-snapshot`。

## 6. 授权（卡密/VIP）

- `validate-key` → `/api/validate_key`；设备号 `license-get-device-id`（node-machine-id）；`unbind-device`。
- licenseCache 快照驱动：公告轮询开关、VIP 门禁（FREE_BROWSER_WINDOW_LIMIT 等）。
- 记录管理：`license-get/clear/delete-record(s)`、`license-get-saved-key`（services/license-store.js）。
- 礼品码：`redeem-vip/wool/proxy-traffic-gift-code`、`ai-control-redeem-gift-code`。

## 7. 扩展

- 内置扩展装载：`services/extension-manager.js`（1900 行）——发现、兼容副本、注入、刷新；状态 `get-extension-manager-state` / `extension-manager-state` 事件。
- 自定义：`import-extension-plugin` / `remove-extension-plugin` / `set-extension-enabled`。
- AI 自动化：工作台内置在软件首页，卡片与会话操作经 preload/IPC 到主进程，页面动作经受认证 Runtime Bridge 进入 Chromium Fork。

## 8. 更新与退出

- 更新：`start-app-update` + 服务器指令 `handleServerUpdateCommand`（公告轮询里的 sendUpdateNotice 必须经主进程版本比较）→ `services/app-updater.js`（1450 行）下载/校验/安装；挂起状态存 `global._pendingUpdateInstall*`。
- 退出：`global._isShuttingDown`/`_mainAppExiting` 标志 → stopClashMiniProcess → 会话数据清理（cleanupBrowserSessionData / purge）→ Chromium 子进程回收。[待核] 崩溃路径的孤儿进程处理。
