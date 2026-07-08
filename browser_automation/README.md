# AI自动化插件（Browser Automation）

一个基于 Chrome Manifest V3 的浏览器扩展，用于浏览器任务的自动化执行，并可作为 **HeySure 端侧 agent** 登录软件端账号、连接服务器、由网页端「作坊」分配 AI 后接受远程调度。

支持自动化卡片定义、本地执行自动化流程、Cookie 抓取，以及登录后把上述能力作为工具暴露给分配到本设备的 AI。

> 说明：早期的「临时邮箱」调试栏目已移除。自动化流程内部仍可通过 `wait_verification_code` 步骤自动获取邮件验证码（引擎能力保留），只是不再有单独的临时邮箱调试面板。

## 主要功能

- **自动化卡片**：可视化编辑自动化步骤，支持：
  - 固定或随机数据生成
  - 弹窗处理规则
  - 步骤导航（点击、输入、等待、验证码识别、脚本执行等）
  - 循环执行模式
  - 缓存保存 / 导出 / 导入

- **Cookie 抓取**：
  - 一键抓取当前页面的 Cookie、localStorage、sessionStorage
  - 支持账号/密码/备注/卡片密钥关联
  - 本地缓存历史凭证 / 导出凭证数据

- **本地执行**：无需后端，在浏览器扩展环境中直接运行自动化流程。

- **服务器同步（登录 + AI 分配）**：登录 HeySure 软件端账号后自动连接服务器，设备出现在网页端「作坊」栏目里等待管理员分配 AI；分配后 AI 可远程调用本插件的自动化卡片管理、运行与 Cookie 抓取工具。

- **操作动效**：AI 远程执行页面点击/输入时，在页面上显示手型光标、点击涟漪、输入高亮等可视反馈（可在同步面板的「选项」里开关）。

## 安装方法

1. 打开 Chrome 浏览器，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目根目录即可加载（本扩展为纯 JS，无需构建步骤）

## 使用流程（本地）

1. 点击扩展图标打开弹窗。
2. 切换到对应标签页：
   - 自动化卡片：编辑或加载卡片，执行自动化流程
   - Cookie 抓取：捕获并管理凭证
3. 使用「教程」按钮查看使用说明。

## 服务器同步（登录 + AI 分配）

本扩展登录后作为 HeySure 端侧 agent，经 **Socket.IO** 连接服务器并登记为一个浏览器设备。与 `device/extension`（HeySure Agent）的登录/AI 分配链路一致。

### 使用步骤

1. 点击弹窗头部的账号胶囊（右上角「未登录」）打开「服务器同步」面板。
2. 填写服务器地址（默认 `http://127.0.0.1:3000`）、账号、密码，点击「登录并连接」。
3. 登录成功后自动连接服务器；头部状态条：
   - 🔴 未连接 / 连接错误
   - 🟡 已连接 · 未分配 AI（等待管理员在网页端「作坊」为本设备分配 AI）
   - 🟢 已连接 · 已分配 AI（可被 AI 远程调度）
4. 管理员在网页端「作坊」栏目为本设备分配 AI 后，AI 触发的工具调用会经 Connector Runtime 以 `task:dispatch` 下发到本插件执行。

### 暴露给 AI 的工具

| 分类 | 工具 | 功能说明 |
|------|------|----------|
| 自动化卡片 | `manage_card`   | 卡片唯一入口（管理 + 执行合一）：rules 获取步骤类型与运行规则（写卡片前必看，write 和局部步骤编辑都会按规范校验拒绝非法步骤类型）、list 列出全部卡片、get 获取卡片完整 JSON、write 创建/覆盖完整卡片、patch_step 修改某一步、insert_step 插入步骤、delete_step 删除步骤、move_step 移动步骤、delete 删除整张卡片、run 在当前活动标签页执行卡片（可指定账号/邮箱/验证码，耗时操作）。步骤索引使用 1-based，与失败结果 stepIndex 对齐；insert_step 不传 step_index 时默认追加。run 失败时返回结构化现场（errorCode + 失败步骤 stepIndex/selector + failureSnapshot 候选元素 + context 实际凭证），页面停留在失败现场，修复卡片后可用 `start_step` 从失败步骤续跑，形成「失败 → 修卡 → 续跑」闭环。旧工具名 `get_status`/`run_card`/`write_card` 仍兼容执行（分别等价 list/run/write） |
| 自动化卡片 | `save_cookies`  | 抓取当前页面的 Cookie + localStorage + sessionStorage，可选上传到指定服务器 |
| 导航与搜索 | `browser_tab`   | 标签页管理与导航：list / switch / replace / navigate / close / back / forward |
| 页面观察   | `browser_observe`    | 感知当前视口的可交互元素、媒体、可见文本与 iframe 边界，返回带 tag/selector/name/placeholder/ariaLabel 等基本信息的 items 列表（含临时 id）；支持用 selector/text 定位构造卡片步骤或 ref 快速操作，便于卡片创建/修改与表单信息填入 |
| 页面交互   | `browser_action`     | 点击 / 双击 / 右键 / 滚动 / 输入文本 / 键盘按键的聚合工具。click/type 成功回执附 `cardStep`（与卡片规范同构的步骤对象），browser_tab navigate/replace、browser_wait 同理——AI 探索验证通过后直接把各步 cardStep 拼进 `manage_card write` 即可固化成卡片 |
| 页面交互   | `browser_wait`       | 等待某个 CSS selector 出现，或固定等待一段时间 |

工具 schema 在设备登记时上报给服务器，由服务器在 `mcp.list_tools` / `describe_tool` 中呈现，无需服务端硬编码。

> `browser_tab`/`browser_observe`/`browser_action`/`browser_wait`
> 移植自 `device/extension` 的同名 MCP 工具：本插件没有 `debugger`/CDP 权限，因此点击/输入/按键都是
> 合成事件（非 CDP trusted 事件）。`browser_observe` 已与桌面浏览器扩展的观察能力对齐——扫描主文档、
> 同源（含嵌套）iframe 内部、Shadow DOM（开放 root，封闭 root 由 `content/shadow-patch.js` 强制转开放），
> 识别 img/video/audio 媒体元素及 `cursor:pointer` / 类名或 ID 以 btn/button/link 结尾的自定义控件，
> 并支持 `frame`/`frame_path` 钻取单个 iframe；跨域 iframe 内部仍不可访问。
> observe 现返回元素基本信息（tag/selector/attrs），AI 推荐用 selector/text 进行卡片步骤定位（不再依赖临时 id），便于自动化卡片的修改和创建。
> 执行逻辑见 `background/10_browser_tools.js` + `content/observe.js`（+ `content/shadow-patch.js`）。

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
│   ├── 06_automation_run.js
│   ├── 07_events.js
│   ├── 08_agent_auth.js        # 软件端账号登录 / 认证 HTTP 客户端
│   ├── 09_agent_socket.js      # Socket.IO 连接 / 设备登记 / task 调度 / AI 分配
│   └── 10_browser_tools.js     # browser_tab/observe/action/wait 工具封装
├── content/
│   ├── shadow-patch.js         # document_start / MAIN world：强制 shadow root 转 open（供 observe 扫描封闭 root）
│   ├── fx.js                   # 页面操作动效（手型光标 / 点击涟漪 / 输入高亮）
│   └── observe.js              # 页面观察与交互底座（window.__hsObserve，供 10_browser_tools.js 调用）
├── cursors/
│   └── hand.png                # 动效手型光标资源
├── vendor/
│   └── socket.io.js            # 打包好的 socket.io-client（供 SW importScripts）
├── popup.html / popup.js / popup.css
├── popup/
│   ├── bootstrap.js
│   ├── agent-account.js        # 服务器同步 UI（登录 / 连接 / AI 分配 / 选项）
│   ├── automation-workbench.js
│   ├── automation-flow.js
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
