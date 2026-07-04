# 注册插件（Browser Automation）

一个基于 Chrome Manifest V3 的浏览器扩展，用于账号注册流程的自动化辅助，并可作为 **HeySure 端侧 agent** 登录软件端账号、连接服务器、由网页端「作坊」分配 AI 后接受远程调度。

支持注册卡片定义、本地执行注册流程、Cookie 抓取，以及登录后把上述能力作为工具暴露给分配到本设备的 AI。

> 说明：早期的「临时邮箱」调试栏目已移除。注册流程内部仍可通过 `wait_verification_code` 步骤自动获取邮件验证码（引擎能力保留），只是不再有单独的临时邮箱调试面板。

## 主要功能

- **注册卡片**：可视化编辑注册步骤，支持：
  - 固定密码或随机密码生成（大小写、数字、混合等）
  - 弹窗处理规则
  - 步骤导航（点击、输入、等待、验证码识别等）
  - 循环注册模式
  - 缓存保存 / 导出 / 导入

- **Cookie 抓取**：
  - 一键抓取当前页面的 Cookie、localStorage、sessionStorage
  - 支持账号/密码/备注/卡片密钥关联
  - 本地缓存历史凭证 / 导出凭证数据

- **本地执行**：无需后端，在浏览器扩展环境中直接运行注册流程。

- **服务器同步（登录 + AI 分配）**：登录 HeySure 软件端账号后自动连接服务器，设备出现在网页端「作坊」栏目里等待管理员分配 AI；分配后 AI 可远程调用本插件的注册卡片管理、运行与 Cookie 抓取工具。

- **操作动效**：AI 远程执行页面点击/输入时，在页面上显示手型光标、点击涟漪、输入高亮等可视反馈（可在同步面板的「选项」里开关）。

## 安装方法

1. 打开 Chrome 浏览器，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目根目录即可加载（本扩展为纯 JS，无需构建步骤）

## 使用流程（本地）

1. 点击扩展图标打开弹窗。
2. 切换到对应标签页：
   - 注册卡片：编辑或加载卡片，执行注册
   - Cookie 抓取：捕获并管理凭证
3. 使用「教程」按钮查看使用说明。

## 服务器同步（登录 + AI 分配）

本扩展登录后作为 HeySure 端侧 agent，经 **Socket.IO** 连接服务器并注册为一个浏览器设备。与 `device/extension`（HeySure Agent）的登录/注册/AI 分配链路一致。

### 使用步骤

1. 点击弹窗头部的账号胶囊（右上角「未登录」）打开「服务器同步」面板。
2. 填写服务器地址（默认 `http://127.0.0.1:3000`）、账号、密码，点击「登录并连接」。
3. 登录成功后自动连接服务器；头部状态条：
   - 🔴 未连接 / 连接错误
   - 🟡 已连接 · 未分配 AI（等待管理员在网页端「作坊」为本设备分配 AI）
   - 🟢 已连接 · 已分配 AI（可被 AI 远程调度）
4. 管理员在网页端「作坊」栏目为本设备分配 AI 后，AI 触发的工具调用会经 Connector Runtime 以 `task:dispatch` 下发到本插件执行。

### 暴露给 AI 的工具

| 工具            | 功能说明 |
|-----------------|----------|
| `get_status`    | 列出所有已保存的注册卡片（id、名称、步骤数、保存时间等） |
| `write_card`    | 创建新卡片、覆盖已有卡片或删除卡片 |
| `run_card`      | 在当前活动标签页执行注册卡片流程（可指定账号/邮箱，耗时操作） |
| `save_cookies`  | 抓取当前页面的 Cookie + localStorage + sessionStorage，可选上传到指定服务器 |

工具 schema 在 `device:register` 时上报给服务器，由服务器在 `mcp.list_tools` / `describe_tool` 中呈现，无需服务端硬编码。

## 项目结构

```
browser_automation/
├── background.js               # importScripts 入口（先加载 vendor/socket.io.js）
├── background/
│   ├── 00_core.js
│   ├── 01_state.js
│   ├── 02_sidebar_page.js      # 页面动作执行器（executePageAction，含动效挂钩）
│   ├── 03_formatting.js
│   ├── 04_cache.js
│   ├── 05_temp_email_flow.js
│   ├── 06_registration_run.js
│   ├── 07_events.js
│   ├── 08_agent_auth.js        # 软件端账号登录 / 认证 HTTP 客户端
│   └── 09_agent_socket.js      # Socket.IO 连接 / 注册 / task 调度 / AI 分配
├── content/
│   └── fx.js                   # 页面操作动效（手型光标 / 点击涟漪 / 输入高亮）
├── cursors/
│   └── hand.png                # 动效手型光标资源
├── vendor/
│   └── socket.io.js            # 打包好的 socket.io-client（供 SW importScripts）
├── popup.html / popup.js / popup.css
├── popup/
│   ├── bootstrap.js
│   ├── agent-account.js        # 服务器同步 UI（登录 / 连接 / AI 分配 / 选项）
│   ├── register-workbench.js
│   ├── registration-flow.js
│   └── ...
├── manifest.json
└── icons（icon16/32/48/128.png, icon.ico）
```

## 技术栈

- Chrome Extension Manifest V3
- 原生 JavaScript (ES Modules)
- Chrome APIs: cookies、storage、scripting、tabs、downloads、alarms 等
- Socket.IO（`socket.io-client`，已打包到 `vendor/socket.io.js`）用于与 HeySure 服务器同步

> `vendor/socket.io.js` 由 `device/extension/node_modules/socket.io-client` 经 esbuild 打包为
> IIFE（`globalThis.io`）生成，是提交进仓库的构建产物；本扩展本身无构建步骤，直接加载源码即可。

## 注意事项

- 本工具仅供学习和自动化测试使用，请遵守目标网站的服务条款。
- 部分网站的反爬/验证码机制可能需要额外适配。
- 数据均存储在浏览器本地 storage 中；敏感凭证请谨慎处理。
- 登录令牌与账号保存在 `chrome.storage.local`；勾选「记住账号和密码」才会保留密码。

## 开发

修改代码后，在扩展管理页点击「重新加载」即可热更新。

若需重新生成 `vendor/socket.io.js`：

```bash
# 在 device/extension 目录（其中含 socket.io-client 与 esbuild）
echo "import { io } from 'socket.io-client'; globalThis.io = io" > _sio_entry.js
node node_modules/.bin/esbuild _sio_entry.js --bundle --format=iife --platform=browser \
  --target=chrome116 --outfile=../browser_automation/vendor/socket.io.js
rm _sio_entry.js
```
