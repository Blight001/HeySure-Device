# AI-FREE Agent 维护契约

本文件适用于 `app2.1/` 下的全部文件。任何 AI、自动化代理或协作者在修改本项目时都必须遵守。目标是持续小步维护，防止架构、复杂度、兼容性和临时产物再次积累到需要全项目重构。

## 1. 开始工作前

1. 阅读 `docs/ARCHITECTURE.md`、`docs/DATA-CONTRACTS.md`、`docs/refactoring/PROGRESS.md`；涉及故障时再读 `docs/TROUBLESHOOTING.md`。
2. 先检查 `git status --short`，区分已有改动和本次改动。已有改动默认属于用户，不得覆盖、回退或顺手整理。
3. 找到行为入口、全部调用方、契约和现有测试后再修改。修复故障必须先说明根因，不能只隐藏错误信息或增加无条件回退。
4. 选择能完整解决问题的最小改动范围。没有用户明确授权，不做全目录改名、批量格式化、框架替换、依赖升级或无关重构。

## 2. 架构边界

保持以下依赖方向：

```text
main/entry → main/composition → main/features → injected platform/repository
                                      ↑
renderer/sidebar → preload → contracts/IPC adapters
browser extension ↔ AutomationBridge ↔ Chromium runtime
```

- `main/composition` 只装配依赖和生命周期，不放业务规则。
- `main/features` 按业务域承载 application service 与 IPC adapter；IO 必须通过 platform/repository 或显式依赖注入。
- `shared` 必须保持纯逻辑，不依赖 Electron、DOM、网络或文件系统。
- renderer/sidebar 禁止直接 `require('electron')`，禁止恢复任意通道 `window.electronAPI` 或新增业务性 `window.*`。
- preload 只暴露冻结、按域命名的窄 `window.aiFree` API。
- 新 IPC 必须先登记 `contracts/ipc-channels.js`，按需补充 payload schema 和类型，再通过 `ipc/registry.js` 注册并返回 disposer。不得 monkeypatch `ipcMain.handle/on`，不得重复注册通道。
- 新接口使用稳定的 `{ok:true,data}` / `{ok:false,error}` 结果；错误码、失败语义和重试属性属于兼容契约。
- 数据字段或存储路径变更必须兼容旧数据，并提供校验、幂等迁移与失败恢复；不得直接破坏性覆盖。

### UI 入口、职责与整改边界

修改任何 UI 前，先按下表确认宿主、职责和所有权。一个业务界面只能有一个 DOM 真源；禁止为了复用而在多个 HTML 中复制同一面板，也禁止用运行时删除无关 DOM 的方式模拟独立页面。

| UI | 入口与宿主 | 当前职责 | 控制器与样式归属 | 整改约束 |
|---|---|---|---|---|
| 主窗口与浏览器首页 | `src/app/views/app-shell.html`，由主 `BrowserWindow` 加载 | 顶部标签栏、主题/更新控件、无活动浏览器时的首页、浏览器记录、环境配置、内置代理、原生自动化工作台；活动 Chromium 的可见区域也由该窗口协调 | 主窗口逻辑位于 `renderer/controllers/pages/app-shell/`，基础样式位于 `renderer/styles/app-shell*.css` | 主内容功能必须放在此处或由此页面装配，不得再创建覆盖首页的第二个 `WebContentsView`；首页显隐只由标签运行状态决定；浏览器内容区域和侧栏预留宽度必须同步验证 |
| AI 控制页 | `src/app/sidebar/ai-control.html`，由右侧 `WebContentsView` 加载 | AI 对话、模型选择、浏览器/自动化卡片选择、工具调用展示、自定义 API、AI 服务器设备和 Prompt 诊断 | `sidebar/client/app/side/controllers/pages/ai-control/` 与 `sidebar/client/app/side/styles/modules/ai-control.css` | 只承载 AI 控制域，不得加入浏览器首页或个人中心 DOM；进入个人中心必须导航到 `account-center.html`；轮询、订阅和会话保存必须在页面卸载时保持可恢复 |
| 个人中心页 | `src/app/sidebar/account-center.html`，与 AI 控制页复用同一个右侧 `WebContentsView`，通过页面导航切换 | 登录/注册、设备登录、账号资料、额度、VIP 套餐、兑换码、关闭方式、公告、教程和版本信息 | `sidebar/client/app/side/controllers/pages/side-panel/modules/account-*`、`window-close-preference.js`、`announcements.js` 及 `account-auth.css` | 账号表单和 VIP 弹层只在此页保留一个 DOM 真源；从 AI 页触发登录时使用会话内导航意图，不复制登录表单；不得直接读取主进程存储或凭据 |
| 侧栏兼容入口 | `src/app/sidebar/index.html` | 仅把旧入口跳转到 `ai-control.html`，兼容旧路径、工具和外部启动参数 | 无业务控制器 | 必须保持轻量；不得重新放回 AI、账号或首页面板；新增正式侧栏页面时应让主进程直接加载明确文件，而不是依赖此跳转 |
| 开发控制台 | `src/app/main/views/dev-console.html`，仅开发模式作为右侧栏第三页面 | 与 AI 控制、个人中心并列，展示应用控制台历史和调试专用日志 | 导航开关在 `sidebar/client/scripts/dev-mode-navigation.js`，日志来源经 `runtime/app-console` 的受控桥接投递到侧栏 | 不得再创建独立调试 `BrowserWindow`；只用于诊断，不能成为业务操作入口；不得显示凭据、Cookie、Token 或普通用户不可见的敏感响应；生产环境的可达性必须继续受开发模式控制 |
| 浏览器历史手势弹窗 | 由 `main/features/browser/browser-history-popup-controller.js` 生成 `data:` 页面并加载到临时窗口 | 在顶部新建按钮手势中快速选择历史浏览器 | HTML 构建、窗口生命周期和输入路由归该 controller | 内容必须小型、短生命周期、无远程脚本；选项数据先在主进程规范化和转义；不得演变为第二套浏览器历史管理页 |
| 标签上下文菜单弹窗 | 由 `main/features/browser/tab-context-menu-controller.js` 生成 `data:` 页面并加载到临时窗口 | 标签的重命名、关闭等上下文操作 | HTML 构建和动作回传归该 controller | 只承载上下文动作；必须绑定明确 tab ID、处理窗口销毁并转义可见文本；复杂设置应回到主窗口，不在弹窗中扩张 |
| 更新下载页 | `main/features/updates/update-download-page.js` 创建窗口并加载受控远程地址 | 当直接安装包下载链路需要网页交互时，承载发行方下载页面 | URL 校验、导航、下载监听和窗口回收归更新域 | 这是外部页面而非本地 UI 真源；必须限制允许的 URL/导航和下载行为，不注入本地业务 DOM，不向页面暴露宽泛 preload 能力 |

主窗口中的浏览器设置目前仍复用部分 `sidebar/client/.../side-panel/modules/` 控制器与侧栏样式，这是从独立设置页迁入 `app-shell.html` 后的已知过渡耦合。后续整改应按功能把 `browser-settings-*`、VPN 首页绑定和对应样式迁到 `renderer/controllers/pages/app-shell/`、`renderer/styles/`，但迁移过程中只能移动真源，不能复制后保留两套实现。

UI 调整还必须遵守以下规则：

- 新增 UI 前先判断它属于主内容、右侧侧栏、短生命周期弹窗还是外部网页；仅当需要独立渲染生命周期、层级或安全边界时才能新增 `BrowserWindow`/`WebContentsView`。
- 页面级 HTML 只声明该页面真实需要的 DOM。共享行为通过窄 preload API、纯工具或明确的共享控制器复用，不通过隐藏面板、跨页查询不存在的元素或复制脚本列表复用。
- 页面导航、窗口创建和弹窗打开属于行为契约。改动后至少验证源码加载路径、`.generated/app` 路径、打包资源存在性、页面首次加载、页面切换、关闭/重开和主窗口/侧栏显隐。
- 主窗口 UI 相关回归优先覆盖 `test/unit/runtime/app-shell-browser-settings-page.test.js`、`test/acceptance/scripts/check-browser-settings-ui.js`；侧栏资源与页面拆分覆盖 `test/packaging/packaged-runtime-assets.test.js`、`test/acceptance/scripts/check-packaged-sidebar-assets.js` 和 packaged runtime 校验。
- 新增或删除 UI 入口时必须同步更新本节、加载入口、CSP、资源打包断言和真实 Electron 验收；不得只修改 HTML 后依赖人工发现路径遗漏。

## 3. 防止代码重新膨胀

生产代码硬门槛：文件不超过 500 行、函数不超过 80 行、圈复杂度不超过 15，ESLint error 与 TypeScript/checkJs error 必须为 0。

- 当文件、函数或复杂度达到硬门槛的 80% 时，继续增加逻辑前必须先按职责拆分；不要等门禁报错再处理。
- 一个模块只承担一个可命名职责。新增分支前优先抽取纯函数、策略对象或领域服务，但不得制造只转发参数的空壳层。
- 同一规则只能有一个真源。新增 helper 前先搜索现有实现；不得复制常量、通道名、schema、路径推导或错误码。
- 不通过关闭 ESLint 规则、增加 ignore、移动文件到豁免目录、拆成难读碎片或修改测试来规避门禁。
- `scripts/guardrail-baseline.json` 维持零基线。没有用户明确授权，不得执行 `--update`、放宽阈值或增加例外。
- 修复局部问题时不得顺带重写整个模块。若最小正确修复确实需要跨域变更，先向用户说明影响范围和理由。

## 4. 路径、生成态与打包态

- 开发、测试和打包统一通过 `npm run prepare:source`；不得手工编辑 `.generated/`。
- 不得手工编辑 `appbuild/`、`node_modules/`、编译中间文件或打包输出。需要改变产物时修改源文件/构建脚本后重新生成。
- 不改写第三方扩展或供应商资产；自研 `browser_automation` 扩展也必须保持 background/content/popup 的明确装配边界。
- 路径逻辑统一放在路径解析模块，不在业务代码散落 `../../..`、当前工作目录假设或打包特判。
- 任何 Electron/Chromium 资源路径变更都必须覆盖三种环境：源码测试、`.generated/app` 开发运行态、`process.resourcesPath` 打包态。不能假设 `__dirname` 永远位于项目根，也不能假设 `process.resourcesPath` 在开发态指向应用资源。
- 正式 Chromium 模式只能使用随项目/安装包提供的 AI-FREE Chromium Fork；不得静默回退到系统 Chrome、Edge 或调用方传入的外部路径。
- Chromium、Clash Core、native host、logo 和扩展的外部资源布局属于可执行契约，变更后必须验证 packaged runtime。

## 5. 临时文件与敏感信息

- 临时目录使用系统临时目录、测试专用 `mkdtemp` 或 `userData` 下的明确运行目录；禁止在项目根、工作区父目录或源码目录留下 `.tmp`、`.log`、coverage 批次日志、dump、截图或调试描述文件。
- 创建临时文件的代码必须用 `try/finally`、退出钩子或测试 teardown 清理；同时覆盖成功、失败、超时和进程退出路径。
- 原子写入产生的临时文件必须与目标文件同目录且在成功替换后删除。启动时发现本应用遗留文件，应验证所有权与 PID 后安全清理。
- Cookie、API Key、卡密、设备凭据、授权头、MCP/AutomationBridge token 不得进入日志、fixture、snapshot、错误详情或项目文件。
- 扩展运行 token 只能写入 `userData` 下的独立运行副本，绝不能写回源扩展。
- 调试输出应使用现有结构化 logger 和 debug 路由；合入前删除临时 `console.log`、探针代码和一次性脚本。

## 6. 修改与兼容原则

- 保持现有公开行为、IPC、数据格式、用户数据路径、浏览器 Profile、代理和扩展兼容，除非用户明确要求破坏性变更。
- 修复应解决根因并保留可诊断错误。禁止吞异常、用宽泛 `catch` 假装成功或为了“能打开”绕过安全校验。
- 并发、启动、关闭、重试和取消逻辑必须明确所有权；注册的 listener、timer、server、child process 和文件锁都必须成对释放。
- 不引入新依赖，除非现有平台能力无法合理完成，并在交付说明中写明必要性、体积/安全影响及替代方案。
- 不创建第二套兼容 façade、重复状态源或临时架构。过渡代码必须有明确删除条件和测试。

## 7. 测试规则

- 测试公开行为、失败、恢复和副作用，不匹配私有函数名、源码字符串、CSS 实现细节或模块加载顺序；打包布局与安全静态约束除外。
- Bug 修复先增加能在旧实现失败的回归测试，再验证修复。至少覆盖触发条件和一个相邻非回归场景。
- 测试不得访问真实用户数据、真实凭据或公网账户；临时资源必须隔离且执行后为零残留。
- 代码修改完成后依次运行最小相关测试、`npm run guardrails` 和 `npm run verify`。
- 涉及 Electron、Chromium、扩展、原生 Host、资源路径或生命周期时，再运行 `npm run test:acceptance`；涉及真实 Chromium 行为时运行 `npm run accept:chromium-phase3`。
- 涉及 native host 时运行 `npm run build:native-host`；涉及打包配置/资源布局时运行 `npm run build:win` 与 `npm run check:packaged-runtime`。
- 文档-only 修改可以不跑运行测试，但至少执行 `git diff --check` 并核对命令、路径和版本事实。
- 任何未运行或无法运行的门禁都必须在交付中明确说明，不能声称“全部通过”。

## 8. Git 与文件安全

- 不使用 `git reset --hard`、`git checkout --`、`git clean -fd` 等覆盖性命令，不删除或回退无法确认归属的改动。
- 删除、移动或批量重写前精确确认目标；不得对项目根、工作区根或环境变量展开结果执行递归删除。
- 不主动提交、推送、改分支或改写历史，除非用户明确要求。
- 保持 diff 聚焦：只包含本任务必要的源码、测试和文档；生成物与调试产物不得混入。

## 9. 完成定义

交付前逐项确认：

- 根因已修复，不是通过隐藏错误或不安全回退绕过。
- 变更遵守进程边界、依赖方向和兼容契约。
- 文件/函数/复杂度未接近或超过门槛，零基线没有放宽。
- 回归测试覆盖成功、失败或恢复路径，相关门禁通过。
- 源码、`.generated/app` 与打包态中受影响的运行模式均已按风险验证。
- 无临时日志、token、测试目录、孤儿进程、监听端口或文件锁残留。
- 文档与实际行为一致，交付说明列出改动、验证结果和仍存在的限制。

如果无法满足以上任一项，不得把任务标记为完成；应继续修复，或清楚报告阻塞条件和所需决策。
