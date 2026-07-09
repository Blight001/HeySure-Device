# HeySure Agent — 浏览器扩展

Chrome MV3 扩展。两种工作模式并存：

1. **Browser-Agent**：通过 socket.io 连接到 HeySure 服务端，作为浏览器自动化
   Agent 执行服务端下发的 MCP 工具任务。
2. **软件端客户端**：登录账号后管理 AI 成员、对话、安排任务（与 Web 控制台
   等价的精简版）。

## 构建 & 加载

```bash
npm install
npm run build        # 输出到 dist/
npm run dev          # esbuild watch 模式
```

加载方法：Chrome → 扩展程序 → 加载已解压的扩展程序 → 选择本目录。

## 目录结构

```
device/extension/
├── manifest.json           # MV3 manifest（service worker / content scripts / 权限）
├── popup.html              # 弹窗 UI 骨架 + 内联样式
├── build.js                # esbuild 入口配置
├── tsconfig.json           # 编译配置（仅用于类型检查；打包走 esbuild）
├── icons/                  # 16/48/128 图标
├── dist/                   # 构建产物（manifest 引用，需要随仓库一起入库）
└── src/
    ├── background.ts       # service worker 入口：socket.io、任务派发、popup 端口
    ├── content/            # 内容脚本（注入到所有页面）
    │   ├── index.ts        #   入口 + chrome.runtime 消息分派
    │   ├── fx.ts           #   虚拟鼠标 / 视觉效果
    │   ├── dom.ts          #   纯 DOM 工具（可见性、文本匹配、选择器路径等）
    │   ├── viewport.ts     #   页面位置上下文（scrollY、当前章节、可见标题）
    │   ├── popups.ts       #   弹窗/对话框检测与关闭
    │   └── actions.ts      #   点击/输入/滚动/拖拽/提取 等具体动作
    ├── popup/              # 弹窗 UI 逻辑（按职责拆分的模块）
    │   ├── index.ts        #   编排层：background 端口分派、启动流程、装配监听
    │   ├── state.ts        #   共享可变状态单例 + 常量
    │   ├── dom.ts          #   集中缓存的 DOM 元素引用
    │   ├── helpers.ts      #   纯/派生工具（头像、角色、useServerChat 等）
    │   ├── ui.ts           #   表现层：主题/状态/活动流/tab/弹窗/目标横幅
    │   ├── members.ts      #   登录登出 + AI 成员加载/渲染/选择
    │   ├── chat.ts         #   对话子系统（服务端轮询 + 本地、会话、消息操作）
    │   ├── tasks.ts        #   任务安排与作业列表
    │   ├── settings.ts     #   设置表单：加载/保存/预设/测试连接/连接控制
    │   └── markdown.ts     #   纯渲染工具：Markdown / MCP 调用块 / 推理块
    └── lib/                # 跨入口共享的库代码
        ├── types.ts        #   AgentSettings、ChatMessage、消息类型等
        ├── storage.ts      #   chrome.storage 封装（设置 / 鉴权 / 历史）
        ├── ai.ts           #   Anthropic / OpenAI 兼容的 callAI
        ├── client.ts       #   软件端 REST 客户端（登录、AI 成员、任务）
        └── tools/          # MCP 工具目录
            ├── index.ts    #   对外公开 API（re-export）
            ├── definitions.ts   # BROWSER_TOOLS schema + SEARCH_ENGINES
            ├── browser.ts  #   browser_* 工具实现 + executeBrowserOnly 路由
            ├── router.ts   #   executeBrowserTool 路由（browser_*）
            └── executor.ts #   executeTask：服务端任务执行器（含 AI agent 循环）
```

## 三个入口的协作

```
┌────────────────┐  socket.io  ┌────────────┐
│  HeySure 服务端 │ ───tasks──▶ │ background │ ── chrome.tabs.sendMessage ──▶ content
│ (chat run/jobs)│ ◀──results── │  worker    │                                ▲
└────────────────┘             └─────┬──────┘                                │
                                     │ port: "popup"                         │
                                     ▼                                       │
                                ┌──────────┐                                 │
                                │  popup   │ ────── DOM actions ─────────────┘
                                └──────────┘
```

- **background**：服务端的 socket、AI 循环和任务执行调度都在这里。
  调 `lib/tools` 实际执行工具。
- **content**：注入到每个网页，负责真正动 DOM。background 通过
  `chrome.tabs.sendMessage` 发请求；content/actions.ts 根据 `action` 字段分派
  到对应处理函数。
- **popup**：扩展弹窗。通过 `chrome.runtime.connect({ name: 'popup' })`
  与 background 双向通信；可以本地直连 AI（用户配置的 AI Key），也可以走
  服务端 AI 成员（登录账号后）。

## 工具体系（lib/tools/）

工具以 `browser_*` 为主：通过 chrome API 或 content script 操作浏览器（导航、点击、
  输入、截图、滚动、提取等）。实现位于 `browser.ts`。

共 **34 个**工具，按 `BROWSER_TOOL_CATEGORIES`（定义在 `definitions.ts`，分组的
唯一来源）分为 5 类：

| 分类 | 说明 |
| --- | --- |
| 导航与搜索 | navigate / search / history |
| 页面观察 | screenshot / get_content / dom_snapshot / page_info / find_text / find_popups / performance / network_log / iframe_list |
| 页面交互 | click / double_click / right_click / type / press_key / hover / scroll / wait / drag / fill_form / select / close_popup |
| 数据与脚本 | evaluate / extract / clipboard_write / file_upload / download |
| 浏览器状态 | tab / cookie / storage / session / profile（均带 `action` 参数） |

「浏览器状态」类把原先按动词拆分的 19 个工具（`browser_cookie_get`、
`browser_storage_set` 等）收敛为 6 个带 `action` 参数的工具。`browser.ts` 的路由
保留旧名作为别名，会改写成「新工具 + action」，旧调用仍然可用。

`executeBrowserTool(name, args)` 执行浏览器工具；`executeTask` 是
服务端任务的总入口：要么直跑指定工具，要么进入 AI agentic 循环让模型自行
选择工具。

## 开发须知

- TypeScript 类型检查：`npx tsc --noEmit`
- 修改 src/ 后必须 `npm run build` 更新 dist/（manifest 直接引用 dist/）
- 切换包的 popup UI 在 `popup.html` + `src/popup/`；服务端通信在
  `src/background.ts` + `src/lib/client.ts`

## 联调测试

项目提供专用静态测试页，覆盖 `browser_*` MCP 工具的主要场景。源码位于
`web/extension-test/index.html`，由 Web 控制台 Vite 多页入口托管。

### 测试前准备

1. 启动后端（Gateway 等 4 进程）与前端：`web/run.bat`
2. 打开测试页：`http://127.0.0.1:58150/extension-test/`
   - 也可在 Web 控制台 → **系统全能设置** → **打开插件测试页**
3. Chrome 加载本扩展（`npm run build` 后重新加载扩展）
4. popup 内登录并确认已连接服务端
5. 仪表盘中为待测 AI 成员：
   - 绑定「浏览器插件」设备
   - MCP 权限勾选全部 `browser_*`（至少基础类 + 特殊类）
   - 系统全能设置里「单次运行最多步骤」建议 ≥ 80（完整回归）

### 测试页区块与工具对应

| 测试页区块 | 主要工具 | 验证点 |
| --- | --- | --- |
| 观察与点击 | `browser_observe` / `browser_action` | 编号点击、文本定位、禁用按钮、交互日志 |
| 表单输入 | `browser_action`（type / press_key） | 输入框、下拉、checkbox、contenteditable |
| 滚动 | `browser_action`（scroll） | 容器内滚动 + 整页长内容 |
| 拖拽 | `browser_drag` | 拖放到投放区 |
| 等待 | `browser_wait` | 延迟出现 `#delayed-target` |
| 弹窗遮挡 | `browser_action`（click） | 弹窗打开时 `occluded`，关闭后可点击 |
| 结构化提取 | `browser_extract` | `.product-card` + `data-sku` / `data-stock` |
| 截图 | `browser_screenshot` | `#shot-target` 或整页 |
| 文件上传 | `browser_file_upload` | `input[type=file]`（须传 `files[].content`） |
| 存储 | `browser_storage` / `browser_cookie` / `browser_session` | localStorage / sessionStorage |
| 脚本 | `browser_evaluate` | `window.__HEYSURE_TEST__` |
| 下载 | `browser_download` | 页面内下载链接 |

### 方式一：popup 单工具冒烟（mcp.test）

适合改完 `src/lib/tools/` 后快速验单个工具。

1. 在浏览器打开测试页并保持为**当前活动标签**
2. 打开扩展 popup → MCP 工具列表 → 选中工具 → **测试调用**
3. 填入 JSON 参数 → 运行 → 对照返回与页面交互日志（`#action-log`）

常用示例：

```json
{ "action": "list" }
```

```json
{ "action": "switch", "tab_id": 123456789 }
```

```json
{ "action": "replace", "url": "http://127.0.0.1:58150/extension-test/" }
```

```json
{ "action": "navigate", "url": "http://127.0.0.1:58150/extension-test/" }
```

```json
{ "limit": 120, "mark": true }
```

```json
{ "action": "click", "text": "主按钮" }
```

```json
{ "action": "type", "selector": "#input-name", "text": "HeySure测试" }
```

```json
{ "selector": ".product-card", "attributes": ["data-sku", "data-stock"], "limit": 3 }
```

`browser_tab` 的 `action` 取值：`list` / `switch` / `replace` / `navigate` /
`close` / `back` / `forward`。先 `list` 拿 id 与 `activeTab`，已有页用 `switch`，
当前页改址用 `replace`，新标签打开用 `navigate`。

### 方式二：AI 成员完整回归（推荐）

将以下指令发给**已绑定浏览器插件**的 AI 成员，由其自动调用 MCP 并输出报告。
所有操作限定在测试页，不要打开其他网站。

```text
请对 HeySure 浏览器插件做一次完整联调测试，并输出结构化报告。

【环境】
- 测试页 URL：http://127.0.0.1:58150/extension-test/
- 使用当前已连接的浏览器插件设备执行所有 browser_* MCP 工具
- 若页面未打开，先用 browser_tab { action: "replace", url: "http://127.0.0.1:58150/extension-test/" } 在当前页打开，或 navigate 新标签打开

【测试要求】
按顺序逐项执行，每项记录：入参、返回摘要、通过/失败/跳过。
失败最多重试 1 次；仍失败则记录错误并继续，不要中断全流程。
任何点击前先 browser_observe，优先用 ref 编号点击。

1) browser_tab：list → replace 或 navigate 打开测试页 →（可选）navigate 再开一标签 → switch 切回测试页 → back/forward
2) browser_observe：mark:true，记录元素数，用 ref 点击「主按钮」
3) browser_screenshot：截 #shot-target，再截可视区（send_to_user:false）
4) browser_action：click 次按钮；type 写入 #input-name；scroll down 400；press_key Enter
5) browser_wait：点击「显示延迟元素」后等待 #delayed-target
6) browser_drag：从 #drag-source 拖到 #drag-target
7) 遮挡：打开遮罩后点「被遮挡按钮」应 occluded；关闭弹窗后再点应成功
8) browser_extract：.product-card，attributes ["data-sku","data-stock"]
9) browser_evaluate：执行 window.__HEYSURE_TEST__.bump() 并读取 counter
10) browser_storage：set/get localStorage key=heysure_test_key
11) browser_cookie：list
12) browser_session：save（name: ai_smoke_test）→ list
13) browser_clipboard_write：写入测试文本
14) browser_file_upload：上传 test.txt（content 传文本，非本地路径）
15) browser_download：触发页面下载链接

【报告格式】
# 浏览器插件联调报告
- 测试时间 / 设备状态 / 测试页 URL
## 总览（分类通过/失败/跳过计数）
## 逐项结果表（工具、测试点、结果、关键返回、备注）
## 失败与风险项
## 结论（整体可用性 + 阻塞问题 + 建议）
```

长任务可拆两阶段：先执行 1~15 并只报进度，再单独发「根据刚才调用结果按报告模板汇总」。

### 通过标准（摘要）

- **导航**：`list` 含 `activeTab`；`switch` 能激活目标标签；`replace`/`navigate` 后 URL 正确；`back`/`forward` 返回含当前 url
- **观察/交互**：observe 有编号；ref 点击成功；遮挡检测符合预期
- **数据类**：extract 返回 3 条商品；evaluate 能读写 `__HEYSURE_TEST__`
- **状态类**：storage 写入后可读出；session save 后 list 可见

### 常见问题

| 现象 | 排查 |
| --- | --- |
| 测试页打开却是控制台 | 确认 `web/run.bat` 已重启；访问 `/extension-test/` 而非被 SPA 吞掉的路径 |
| 工具不可用 | AI 未勾选 `browser_*` 权限，或插件未连接服务端 |
| `No ordinary web page tab found` | 切换到普通 http/https 标签后再试；或让 AI 用 `navigate` 打开测试页 |
| `Page load timed out` | 已修复竞态；仍出现则检查目标 URL 是否可达、前端是否在跑 |
| 点击失败 | 页面变化后重新 `browser_observe`；弹窗遮挡先关闭或传 `force:true` |
| `file_upload` 失败 | 扩展不能读本地路径，必须用 `files[].content` |

修改 `src/lib/tools/` 或 `definitions.ts` 后执行 `npm run build` 并在
`chrome://extensions` 重新加载扩展；若改了服务端 `catalog.json` 还需重启后端。
