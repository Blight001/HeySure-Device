# 整改进度跟踪

对应方案：[ai-maintainability-refactor-plan.md](ai-maintainability-refactor-plan.md)。最后核验：2026-07-19。

状态：`[x]` 已完成并有可执行证据；`[~]` 已实施但尚未达到方案最终阈值；`[ ]` 未完成。

## 当前结论

阶段 0–5 与最终验收门槛均已完成。全项目守卫基线已收紧为：ESLint error 0、超过 500 行文件 0、超过 80 行函数 0、复杂度超过 15 的函数 0、TypeScript/checkJs error 0；后续任一回归都会直接阻塞门禁。

最终代码通过 334 项 Node 行为/契约/集成/打包测试、75%/65%/70% 覆盖率门禁、真实 Electron 验收、真实 Chromium phase 3、Windows x64 `win-unpacked`/NSIS 构建和 packaged runtime 校验。preload 只暴露冻结的 `window.aiFree` 领域 API，任意通道 façade 已删除。

## 阶段状态与证据

### 阶段 0：冻结现状与功能清单

- [x] 核心流程、IPC、HTTP、本地文件、环境变量、全局状态清点。
- [x] 功能矩阵更新为行为测试与真实环境证据，见 [stage0/feature-matrix.md](stage0/feature-matrix.md)。
- [x] 性能、构建与真实 Electron 交互基线已记录，包含首次侧栏就绪、工作集和窗口销毁耗时，见 [stage0/perf-baseline.md](stage0/perf-baseline.md)。

### 阶段 1：工程与测试护栏

- [x] ESLint、格式检查、TypeScript checkJs、依赖边界、覆盖率和统一 `npm run verify`。
- [x] `test/` 根目录无散放测试；现有自动化测试按 unit/contract/integration/packaging/acceptance 分层。
- [x] `scripts/check-*`/`accept-*` 的断言主体迁入 `test/acceptance/scripts`，脚本仅保留薄入口。
- [x] 仅匹配源码、函数名、CSS 或加载顺序的旧断言已删除。保留的源码读取只用于 IPC/打包静态安全约束、VM 实际执行或运行时副本防泄漏验证。
- [x] 生产 JS/TS 文件无超过 500 行的未登记文件；ESLint 和 TypeScript 错误均为 0。
- [x] 结构门禁收口：超过 80 行函数 0、复杂度超过 15 的函数 0，零基线已提交，见 [stage1/over-limit-list.md](stage1/over-limit-list.md)。

### 阶段 2：装配、类型和 IPC 基础设施

- [x] `bootstrap.js` 从 629 行缩为 composition root，装配拆入 `main/composition`。
- [x] AppContext、AppError/IpcResult、结构化日志、集中路径解析。
- [x] IPC 集中注册表、payload schema、重复注册 fail-fast、注册器 `dispose()`。
- [x] 混合 JS/TS 构建链；开发、测试和 Windows 构建共用 `scripts/build-source.js`。
- [x] 稳定 IPC 类型已迁入 `contracts/ipc-contracts.ts` 并由 CommonJS 构建输出。
- [x] preload 只暴露冻结的 `window.aiFree` 领域 API；所有方法绑定固定通道，订阅返回 disposer，任意通道兼容层已删除。

### 阶段 3：主进程逐域整改

- [x] AI：service/repository/IPC adapter、停止隔离、消息窗口、历史、工具、模型、卡片和自定义 API 行为测试。
- [x] 浏览器：tab manager、history/settings、Chromium runtime/process/profile 模块拆分与真实 Chromium 验收。
- [x] 网络：Clash 配置/资产/Geo/进程/代理流量模块拆分及失败、退出、离线行为测试。
- [x] 账号：认证、会员、许可证、存储迁移和设备身份模块拆分及行为测试。
- [x] 扩展与更新：发现、原目录加载、兼容、变更、会话、下载/公告模块拆分；打包混淆和路径验证通过。

### 阶段 4：渲染层与自研扩展

- [x] `ai-control.js` 拆分为 bootstrap/state/history/composer/renderer/tool/card/browser 等模块。
- [x] 标签栏、账号认证、VPN、浏览器设置和消息弹窗拆分；修复 shell 脚本加载顺序导致主题/账号绑定失效的真实缺陷。
- [x] 侧边栏 CSS 已按 layout、buttons、account-auth、ai-control、vpn、browser-settings、themes 等模块拆分。
- [x] 旧自动化扩展曾完成拆分；现已将卡片工作台与页面控制完整迁入软件/Chromium 原生控制并删除扩展源码。

### 阶段 5：清理与正式切换

- [x] 删除未加载的旧账号列表实现与重复验收脚本；统一测试/构建入口。
- [x] 架构索引、数据契约、维护规则和故障手册已补齐。
- [x] 开发源构建、真实 Electron、Chromium/扩展、win-unpacked、NSIS 安装包链路已执行。
- [x] 渐进 TypeScript 策略已落地：稳定 IPC contract 使用 TypeScript，现有业务模块由 `checkJs` 全量类型门禁保护，后续可按域继续迁移而不改变运行边界。
- [x] 删除 `window.electronAPI` 兼容层和旧 `window.electron` façade。
- [x] 全体覆盖率达到并锁定方案 75%/65% 最终阈值。
- [x] 函数/复杂度债务降至方案最终阈值并锁定零基线。

## 最近一次可复现结果

| 命令 | 结果 |
|---|---|
| `npm run verify` | 通过（格式、零告警 lint、typecheck、architecture、334 项行为/契约/打包测试、覆盖率、源码构建） |
| `npm run test:acceptance` | 通过（扩展兼容/刷新、握手、runtime、observe、settings UI、session storage） |
| `npm run test:coverage` | 通过；lines 75.69%、branches 67.77%、functions 71.46% |
| `npm run build:win` | 通过，生成 `appbuild/AI-FREE Setup 2.6.9.exe` 与 `appbuild/win-unpacked/AI-FREE.exe` |
| `npm run check:packaged-runtime` | 通过（ASAR/unpacked/native/logo/扩展完整性） |
| `npm run accept:chromium-phase3` | 通过（导航、Cookie、storage、Profile 隔离、拒绝非法/超限输入、锁释放、恢复） |
| `npm run check:browser-settings-ui` | 通过 33 项 UI；首次侧栏就绪 318.8ms、工作集 429.4MB、窗口销毁 4.8ms |
| `npm run guardrails` | 通过；eslint/max-lines/max-lines-per-function/complexity/tsc 全部为 0 |

## 各域交付记录

| 域 | 功能矩阵与自动化 | 真实环境证据 | 已知限制 | 数据兼容与回滚 |
|---|---|---|---|---|
| AI | `AI-*`；停止、工具链、历史、模型、自定义 API、卡片均有行为测试 | Electron UI、Chromium phase 3 | 外部模型可用性取决于服务端 | 历史格式不变；可回滚到旧 service，数据无需转换 |
| 浏览器 | `BR-*`；创建/关闭/恢复、历史 CRUD、Profile、焦点和失败回滚 | handshake/runtime/UI/phase 3 | 真实 Chromium 仍会输出系统 OAuth/USB 诊断 | Profile/历史原路径不变；生成目录可直接丢弃重建 |
| 网络 | `NET-*`；配置、Geo、TLS 延迟、进程退出和流量计数 | runtime、phase 3、packaged resources | 外部订阅与节点质量不由客户端保证 | Clash 配置格式不变；外部资源可恢复原包 |
| 账号 | `ACC-*`；认证、VIP、许可证、迁移、损坏/缺失数据和回滚 | account/session Electron 验收 | 服务端不可用时按安全降级处理 | 原账号/会话/许可证路径与旧字段继续读取 |
| 扩展/更新 | `EXT-*`、`UPD-*`、`PKG-*`；发现、原目录加载、端口连接、混淆、下载失败恢复和打包 | extension acceptance、win-unpacked、NSIS、packaged runtime | 发布前仍应按发行流程人工点验安装/升级 UI | 自动化插件直接加载源目录；`.generated` 可删除重建 |

## 兼容与回滚

- 本轮没有改变账号、聊天历史、Profile、代理、许可证和扩展配置的原路径/格式；新增迁移保持旧格式读取。
- 正式构建使用 `.generated/app`，源码树不被覆盖；构建回滚只需停止使用生成目录，源数据无需迁移回退。
- Chromium 与 Clash 仍作为外部 resources 串行同步，扩展保持 ASAR unpack；不要恢复为并行复制或打入 ASAR。

2026-07-19 的最终 Chromium 验收曾捕获一次第二 Profile 的 HWND 瞬时附着竞争；实现现已增加有界重试和父子窗口关系确认，两条回归测试与连续 phase 3 复验均通过。
