# IPC 全量清点（阶段 0）

生成方式：grep 扫描 src/app/main（2026-07-17）。阶段 2 建立集中注册表时以此为迁移清单。

## 现状结论

- 共 **102 个 handle + 24 个 on** 渲染→主通道，**41 个**主→渲染事件通道。
- 注册点分散在 7 个文件；**app-lifecycle.js 内嵌 28 个注册**（AI 域为主），未走 ipc/register 目录。
- 无通道常量表；preload 暴露通用 send/invoke/on，未做白名单。

## 注册点分布

| 文件 | 直接注册数 |
|---|---|
| src/app/main/ipc/register/ui.js | 31 |
| src/app/main/ipc/register/settings.js | 31 |
| src/app/main/ipc/register/clash.js | 12 |
| src/app/main/ipc/register/misc.js | 9 |
| src/app/main/ipc/account_remember.js | 9 |
| src/app/main/ipc/register/license.js | 6 |
| src/app/main/ipc/register/extensions.js | 4 |
| src/app/main/services/app-lifecycle.js | 28 |

注：clash-mini-core.js / clash-mini-actions.js / store-utils.js / proxy-traffic-monitor.js 不直接注册，作为实现被 clash.js / settings.js 调用。

## 渲染→主进程通道（按注册文件分组）

### ui.js

- (event) `add-tab`
- (event) `app-theme-changed`
- (event) `close-account-center-popup`
- (event) `close-tab`
- (event) `dismiss-account-center-popup`
- (event) `ensure-sidebar-visible`
- (event) `open-account-center-popup`
- (event) `open-tutorial`
- (event) `refresh-active-tab-to-url`
- (event) `refresh-active-tab`
- (event) `reorder-tab`
- (event) `resize-account-center-popup`
- (event) `reveal-cookie-import`
- (event) `set-zoom`
- (event) `smart-refresh-active-tab`
- (event) `switch-tab`
- (event) `sync-app-shell-account`
- (event) `toggle-account-center-popup`
- (event) `toggle-sidebar`
- `browser-mcp-bridge`
- `clear-browser-runtime-data`
- `focus-sidebar-input`
- `get-app-console-history`
- `get-app-theme`
- `get-browser-runtime-state`
- `get-tabs-state`
- `open-active-web-console`
- `refresh-tab`
- `resolve-browser-data-clear-confirm`
- `restart-browser-runtime`
- `show-tab-context-menu`

### settings.js

- (event) `close-browser-history-gesture-popup`
- (event) `server-account-cookie-received`
- (event) `update-browser-history-gesture-popup-selection`
- `cleanup-orphan-browser-profiles`
- `consume-auto-validate-flag`
- `create-independent-browser`
- `delete-browser-history`
- `extract-ai-free-proxy`
- `get-ai-control-custom-api`
- `get-ai-control-settings`
- `get-ai-free-browser-settings`
- `get-browser-history`
- `get-network-magic-auto-start-enabled`
- `get-plugin-settings`
- `get-user-credentials`
- `get-vpn-status`
- `open-browser-history`
- `rename-browser-history-batch`
- `rename-browser-history`
- `reset-ai-free-browser-settings`
- `save-user-credentials`
- `set-ai-control-custom-api`
- `set-ai-control-settings`
- `set-ai-free-browser-settings`
- `set-network-magic-auto-start-enabled`
- `set-plugin-settings`
- `show-browser-history-gesture-popup`
- `test-ai-free-proxy`
- `update-system-proxy-enabled`

### clash.js

- `ensure-clash-config-dir`
- `get-clash-config`
- `get-clash-mini-proxy-options`
- `get-clash-mini-status`
- `get-proxy-traffic-quota`
- `redeem-proxy-traffic-gift-code`
- `save-clash-config`
- `start-clash-mini`
- `stop-clash-mini`
- `stop-clash-service`
- `switch-clash-mini-proxy`
- `test-min-latency`

### misc.js

- `create-desktop-shortcut`
- `get-app-session-id`
- `get-app-version`
- `get-platform-name`
- `get-target-url`
- `get-tutorial-url`
- `get-wool-platforms`
- `network:diagnose`
- `start-app-update`

### account_remember.js

- (event) `cookie-import-confirm-response`
- `delete-accounts`
- `fetch-cookies`
- `get-all-accounts`
- `get-global-credentials`
- `import-cookie-file`
- `save-account`
- `save-global-credentials`
- `switch-account`

### license.js

- `open-dream-page`
- `refresh-subscription-url`
- `refresh-tutorial-url`
- `refresh-wool-platforms`
- `unbind-device`
- `validate-key`

### extensions.js

- `get-extension-manager-state`
- `import-extension-plugin`
- `remove-extension-plugin`
- `set-extension-enabled`

### app-lifecycle.js

- (event) `ai-control-browser-selection-changed`
- `account-authenticate`
- `account-get-session`
- `account-logout`
- `ai-control-chat-insert`
- `ai-control-chat-stop`
- `ai-control-chat`
- `ai-control-get-automation-cards`
- `ai-control-get-browser-connections`
- `ai-control-get-models`
- `ai-control-history-create`
- `ai-control-history-delete`
- `ai-control-history-get`
- `ai-control-history-list`
- `ai-control-history-rename`
- `ai-control-history-save`
- `ai-control-redeem-gift-code`
- `ai-control-select-automation-card`
- `get-app-console-history`
- `get-vip-plans`
- `license-clear-records`
- `license-close-window`
- `license-delete-record`
- `license-get-device-id`
- `license-get-records`
- `license-get-saved-key`
- `redeem-vip-gift-code`
- `redeem-wool-gift-code`

## 主进程→渲染事件

- `account-list-updated`
- `account-popup-dismiss`
- `account-popup-snapshot`
- `active-tab-refreshed`
- `active-zoom`
- `ai-control-browser-selection-changed`
- `ai-control-chat-event`
- `app-console-history`
- `app-console-line`
- `app-shell-account-updated`
- `app-theme-changed`
- `app-version`
- `browser-data-clear-confirm-request`
- `browser-history-gesture-selection`
- `clear-session`
- `close-browser`
- `cookie-import-confirm-request`
- `cookie-import-unlock`
- `desktop-shortcut-prompt`
- `ensure-sidebar-visible`
- `extension-browsers-refreshed`
- `extension-manager-state`
- `independent-browser-create-complete`
- `independent-browser-create-failed`
- `license-records-updated`
- `license-usage-updated`
- `navigate`
- `open-vip-plans`
- `platform-name-updated`
- `reload`
- `server-account-cookie-received`
- `server-announcements-reset`
- `set-cookies`
- `set-storage`
- `set-zoom`
- `tab-closed`
- `target-url-updated`
- `tutorial-url-updated`
- `update-device-id`
- `update-tabs`
- `wool-platforms-updated`
