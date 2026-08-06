# AI-FREE

[English](README.md) | 简体中文

AI-FREE 是面向 Windows 的多环境 AI 浏览器工作台。Electron 负责桌面外壳、账号授权、网络与环境配置，实际网页统一运行在项目内置的 **AI-FREE Chromium Fork** 中，并通过原生 Win32 宿主嵌入主窗口。

当前版本：`2.6.4`

> 当前仓库不是普通 Electron 内嵌网页项目。正式模式必须使用 `resources/chromium/ai-free-browser.exe`，并完成 Runtime Bridge 命名管道握手；不会回退到 Electron 网页视图或系统 Chrome/Edge。

## 核心能力

- **多浏览器环境**：独立 Profile、标签页、浏览器记录、会话与 Cookie 导入、重启、清除数据和环境删除。
- **浏览器环境配置**：代理、主页、Cookie、User Agent、语言、时区、WebRTC、地理位置、分辨率、Canvas、WebGL、WebGPU、AudioContext、硬件信息与启动参数等。
- **账号与授权**：登录、注册、授权状态、兑换码、流量与 AI 额度展示，以及远端公告和自动更新。
- **内置代理**：集成 Mihomo/Clash Mini，支持节点测速、自动选择、手动切换、系统代理恢复和代理流量统计。
- **浏览器插件自动注入**：按配置向 Chromium 环境加载 AI 自动化、去水印和翻译扩展。
- **AI 控制**：软件内对话可选择已连接的浏览器，通过本机桥接调用页面观察、点击、输入、导航、等待、Cookie 保存和自动化卡片等工具。
- **后台自动化保护**：降低窗口最小化、遮挡或失焦对定时器、Socket 和脚本执行的影响。

## 运行架构

```text
Electron 主进程
├─ 应用外壳 / 侧边栏 / 标签管理
├─ 账号、授权、更新与配置
├─ Clash Mini 与网络状态
├─ Browser Automation 本机桥接（127.0.0.1:18765）
└─ Browser Runtime Manager
   ├─ 启动每个 Profile 对应的 AI-FREE Chromium
   ├─ 通过命名管道完成身份握手与命令传输
   └─ 通过 N-API Win32 Host 嵌入、缩放和聚焦浏览器 HWND

AI-FREE Chromium Fork
├─ 独立 Profile 与浏览器进程
├─ 自动加载选定的 MV3 扩展
└─ 承载所有目标网页与浏览器自动化
```

Electron 不再承载业务网页；它只负责控制面和 Chromium 窗口编排。每个浏览器环境的数据保存在独立 Profile 中，生命周期由主进程统一管理。

## 系统与开发环境

运行源码需要：

- Windows 10/11 x64
- Node.js 与 npm，建议使用当前 Node.js LTS
- 完整的 `resources/chromium/` 运行时，入口必须为 `ai-free-browser.exe`
- 已编译的 `native/browser-host/build/Release/browser_host.node`

仅在重新编译原生宿主时还需要 Visual Studio 2022 Build Tools，并安装“使用 C++ 的桌面开发”和 Windows 10/11 SDK。已打包的安装版不需要 Node.js 或 Visual Studio。

## 快速开始

在 `app2.1` 目录执行：

```powershell
npm ci
npm start
```

也可以双击 `v-start.bat`。它会强制使用远端服务模式，并检查 Electron 二进制是否安装完整。

### 启动命令

| 命令 | 用途 |
| --- | --- |
| `npm start` | 正式 Fork 模式：内置 Chromium + 强制命名管道握手 |
| `npm run start:chromium` | 与 `npm start` 相同 |
| `npm run start:dev` | 直接启动 Electron 开发外壳；浏览器页仍使用内置 Chromium |
| `npm run start:electron` | 与 `start:dev` 相同 |
| `npm run start:prototype` | Chromium 接入排障模式，允许 prototype 握手；不得用于发布 |
| `v-debug.bat` | 使用 `127.0.0.1:58111` 本地后端并启用 HTTP 兼容调试 |

`start:dev` 不包含热更新服务器。修改主进程或预加载脚本后需要重启应用；修改内置扩展后需要重建或重新加载对应浏览器环境。

### Electron 下载不完整

如果启动脚本提示缺少 `node_modules/electron/dist` 或 `path.txt`，可在 PowerShell 中执行：

```powershell
Remove-Item -Recurse -Force node_modules\electron -ErrorAction SilentlyContinue
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install
```

## 配置

根目录的 `platforms-config.json` 是打包和默认运行配置入口。

| 字段 | 作用 |
| --- | --- |
| `accountService` | 账号服务主地址、备用地址与请求超时 |
| `packagedExtensions` | 本次打包要包含的扩展目录名；构建时会校验名称、重复项和目录是否存在 |
| `platforms` | 产品名、App ID 和安装器/窗口图标 |
| `platformConfigs.<name>.targetUrl` | 服务未下发覆盖值时使用的默认目标页 |
| `platformConfigs.<name>.tutorialUrl` | 默认教程地址 |
| `platformConfigs.<name>.allowedPlatforms` | 授权验证允许的平台标签 |
| `platformConfigs.<name>.systemProxyEnabled` | 是否允许应用管理系统代理 |
| `defaultPlatform` | 默认平台配置键 |

服务器在授权响应中可以动态下发目标页、教程、平台标签、羊毛资源、TCP 配置和更新信息；运行时值可能覆盖本地默认配置。

常用开发环境变量：

| 变量 | 作用 |
| --- | --- |
| `AI_FREE_SERVER_MODE=remote|local` | 限制允许使用的服务地址类型，避免正式启动误用回环地址 |
| `SERVER_BASE` | 覆盖服务根地址 |
| `ACCOUNT_SERVICE_URL` | 覆盖账号 HTTP 接口 |
| `PLATFORM` | 选择平台配置 |
| `FORCE_HTTP_COMPAT_MODE=1` | 禁用 TCP 通道，使用 HTTP 兼容模式 |
| `DEBUG=1` | 启用调试行为与额外日志 |

正式模式的服务地址由 `v-start.bat` 固定为 `remote`；本地联调建议使用 `v-debug.bat`，并按实际后端端口修改脚本中的地址。

## 内置扩展

当前 `packagedExtensions` 配置为空。AI 自动化由认证的 Chromium Runtime Bridge 提供，不再作为浏览器扩展打包。
- `remove_watermark`：网页复制与媒体处理相关能力。
- `transform`：网页、输入框、图片、PDF 和视频字幕翻译能力。

打包脚本会根据 `packagedExtensions` 排除未选中的扩展；Clash Mini 作为独立运行资源始终打包。AI 自动化工具由主进程发布，并直接派发到受管 Chromium Profile。

## 构建 Windows 安装包

### 1. 准备 Chromium 运行时

`resources/chromium/` 必须包含完整运行时及 `ai-free-browser.exe`。Fork 的版本锁、补丁和构建流程见 [native/chromium-fork/README.md](native/chromium-fork/README.md)。

### 2. 构建原生浏览器宿主

```powershell
npm run build:native-host
npm --prefix native/browser-host test
```

### 3. 构建并校验安装包

```powershell
npm run build:win
```

该命令会：

1. 校验并筛选要打包的扩展；
2. 生成 `appbuild/win-unpacked/`；
3. 单独同步完整 Chromium 运行时，规避大文件并行复制造成的 Windows 文件占用；
4. 校验 ASAR、原生宿主、Chromium、Clash Mini、图标和扩展资源；
5. 基于已校验目录生成 NSIS x64 安装包。

构建结果位于 `appbuild/`。也可以运行 `build.bat`，但该脚本预设下载代理为 `127.0.0.1:7897`，使用前应确认或修改代理端口。

其他构建命令：

```powershell
npm run build:portable
npm run check:packaged-runtime
```

`build:win` 是当前正式发布的推荐路径；`check:packaged-runtime` 用于复查已经生成的 `appbuild/win-unpacked`。

## 测试与检查

运行仓库级 Node 测试：

```powershell
node --test "test/*.test.js"
```

常用专项检查：

```powershell
npm run check:browser-runtime
npm run check:browser-settings
npm run check:extension-compat
npm run check:extension-refresh
npm run check:chromium-handshake
npm run check:chromium-embedded-policy
```

涉及真实窗口、输入或会话的 Electron 验收脚本可能会启动应用和 Chromium，请先关闭正在运行的 AI-FREE 实例。

## 项目结构

```text
app2.1/
├─ docs/                         # HTTP/TCP、自动更新与代理资源说明
├─ native/
│  ├─ browser-host/              # N-API Win32 Chromium 窗口宿主
│  └─ chromium-fork/             # Chromium 版本锁、补丁与构建脚本
├─ resources/
│  ├─ chromium/                  # 已暂存的 AI-FREE Chromium 运行时
│  └─ clash-mini/core/           # Mihomo 内核与本地 Geo/规则资源
├─ scripts/                      # 启动、构建、冒烟和验收脚本
├─ src/
│  ├─ app/
│  │  ├─ main/                   # Electron 主进程、IPC、服务与浏览器运行时
│  │  ├─ renderer/               # 顶部标签栏与应用外壳渲染逻辑
│  │  ├─ sidebar/                # AI 控制、账号、代理和浏览器配置 UI
│  │  ├─ shared/                 # 主进程与渲染层共享工具
│  │  └─ views/                  # 应用外壳页面
│  └─ assets/extensions/         # 随应用打包并注入 Chromium 的扩展
├─ test/                         # Node 回归测试
├─ package.json                  # npm 脚本与 Electron Builder 配置
└─ platforms-config.json         # 平台、服务、扩展与产品配置
```

### 关键入口

- `src/app/main/main.js`：Electron 入口。
- `src/app/main/bootstrap.js`：主进程装配和应用启动生命周期。
- `src/app/main/browser-runtime/`：Chromium 启动、握手、Profile 和窗口桥接。
- `src/app/main/services/tab-manager.js`：浏览器环境与顶部标签生命周期。
- `src/app/main/services/extension-manager.js`：扩展发现、加载与刷新。
- `src/app/main/services/browser-automation-bridge.js`：AI 自动化本机桥接。
- `src/app/main/ipc/`：侧边栏与主进程之间的 IPC。
- `scripts/build-windows.js`：Windows 正式构建、资源同步与校验。

## 相关文档

- [HTTP 请求说明](docs/api/HTTP请求说明.md)
- [自动更新消息说明](docs/api/自动更新消息说明.md)
- [Clash Mini Geo 本地化规格](docs/clash-mini-geo-localization-spec.md)
- [Chromium Fork 构建说明](native/chromium-fork/README.md)
- [原生浏览器宿主说明](native/browser-host/README.md)
- [AI 自动化与 MCP 工具](docs/mcp.md)

## 安全与数据说明

- 本机自动化桥接只监听 `127.0.0.1`，不应暴露到局域网或公网。
- 浏览器 Profile、Cookie、账号记录和自动化卡片可能包含敏感数据，请勿提交到版本库或随意分享。
- Google 浏览器级登录/同步凭据应通过环境变量注入，禁止写入源码、补丁或配置文件。
- 自动化、代理和网页内容处理功能应在符合目标网站条款与当地法律的前提下使用。

## 许可证

ISC
