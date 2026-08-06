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

专用静态插件测试页（原 `web/extension-test/`）与系统全能设置中的「设备端测试」
入口已移除。请在真实网页上联调 `browser_*` MCP。

### 测试前准备

1. 启动后端（Gateway 等 4 进程）与前端：`web/run.bat`
2. Chrome 加载本扩展（`npm run build` 后重新加载扩展）
3. popup 内登录并确认已连接服务端
4. 仪表盘中为待测 AI 成员：
   - 绑定「浏览器插件」设备
   - MCP 权限勾选需要的 `browser_*` 工具
   - 系统全能设置里「单次运行最多步骤」按任务复杂度适当调高

### 方式一：popup 单工具冒烟（mcp.test）

适合改完 `src/lib/tools/` 后快速验单个工具。

1. 在浏览器打开任意普通 http/https 页面并保持为**当前活动标签**
2. 打开扩展 popup → MCP 工具列表 → 选中工具 → **测试调用**
3. 填入 JSON 参数 → 运行 → 对照返回

常用示例：

```json
{ "action": "list" }
```

```json
{ "action": "switch", "tab_id": 123456789 }
```

```json
{ "action": "navigate", "url": "https://example.com/" }
```

```json
{ "limit": 120, "mark": true }
```

```json
{ "action": "click", "text": "示例按钮" }
```

`browser_tab` 的 `action` 取值：`list` / `switch` / `replace` / `navigate` /
`close` / `back` / `forward`。先 `list` 拿 id 与 `activeTab`，已有页用 `switch`，
当前页改址用 `replace`，新标签打开用 `navigate`。

### 方式二：AI 成员联调

将待测网页 URL 与要覆盖的工具发给**已绑定浏览器插件**的 AI 成员，由其调用 MCP
并回报结果。任何点击前建议先 `browser_observe`，优先用 ref 编号点击。

### 常见问题

| 现象 | 排查 |
| --- | --- |
| 工具不可用 | AI 未勾选 `browser_*` 权限，或插件未连接服务端 |
| `No ordinary web page tab found` | 切换到普通 http/https 标签后再试；或让 AI 用 `navigate` 打开目标页 |
| `Page load timed out` | 检查目标 URL 是否可达 |
| 点击失败 | 页面变化后重新 `browser_observe`；弹窗遮挡先关闭或传 `force:true` |
| `file_upload` 失败 | 扩展不能读本地路径，必须用 `files[].content` |

修改 `src/lib/tools/` 或 `definitions.ts` 后执行 `npm run build` 并在
`chrome://extensions` 重新加载扩展；若改了服务端 `catalog.json` 还需重启后端。
