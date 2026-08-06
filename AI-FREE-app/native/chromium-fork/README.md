# AI-FREE Chromium Fork

此目录只保存版本锁、GN 参数、补丁队列和可重复构建脚本。Chromium 完整源码及
`out` 目录固定在 `E:\chromium-ai-free\src`，不得复制进 app2.1 Git 仓库。

锁定基线为 Chromium `150.0.7871.114`，commit
`f405107495a07cb1bfcf687d4af8d91117098db6`。补丁必须按 `patches/series`
顺序应用，禁止直接修改 `out/AI-Free` 中的生成文件。

AI-FREE 品牌图标母版固定为 `assets/AI-FREE.png`。`generate-brand-assets.js`
由该母版生成关于页 1x/2x 徽标、版本页横向品牌图、快捷方式 PNG、
Windows 磁贴和 16/32/48/64/128/256 多尺寸 ICO；`0005` 补丁保存全部
生成产物。源文件与生成 ICO 的 SHA-256 均记录在 `version-lock.json`。

更新母版后先重新生成品牌资源：

```powershell
node native/chromium-fork/scripts/generate-brand-assets.js
node native/chromium-fork/scripts/apply-zh-cn-brand-strings.js
```

执行顺序：

```powershell
powershell -ExecutionPolicy Bypass -File native/chromium-fork/scripts/check-environment.ps1
powershell -ExecutionPolicy Bypass -File native/chromium-fork/scripts/sync-source.ps1
powershell -ExecutionPolicy Bypass -File native/chromium-fork/scripts/apply-patches.ps1
powershell -ExecutionPolicy Bypass -File native/chromium-fork/scripts/build.ps1
powershell -ExecutionPolicy Bypass -File native/chromium-fork/scripts/stage-runtime.ps1
```

需要代理时，在执行同步前设置
`$env:AI_FREE_CHROMIUM_PROXY='http://127.0.0.1:端口'`。同步脚本会先串行完成
depot_tools Python/CIPD bootstrap，再启动并行 gclient 任务，避免首次安装时的
`.cipd_bin` 竞争。

正式运行目录是 `resources/chromium/`。stage 脚本复制完整 Chromium 运行时，
包括 DLL、PAK、locales、resources、Vulkan/SwiftShader 文件和版本目录。

## 启动自检与故障诊断

`stage-runtime.ps1` 和 `build:win` 都会生成 `runtime-manifest.json`，记录
`ai-free-browser.exe`、`chrome.dll`、`chrome_elf.dll`、`icudtl.dat` 与
`resources.pak` 的大小和 SHA-256。启动 Chromium 前，主进程自动检查 Windows
版本/架构、安装盘 NTFS、Code Integrity/AppLocker 最近事件、关键文件哈希和
AppContainer 读取权限；确定失败的检查会阻止启动，避免继续运行损坏内核。

运行日志位于 Electron `userData/logs/chromium-runtime.log`。启动或握手失败时，
系统还会在 `userData/diagnostics/` 自动生成单文件 JSON 诊断包，包含脱敏后的
启动参数、预检结果、日志尾部以及最近的 Code Integrity、AppLocker 和 Defender
事件。Token、Cookie、授权头、代理凭据与用户目录会在写入前清理。

补丁 `0025-ai-free-sandbox-launch-diagnostics.patch` 会在 Windows 沙箱子进程
启动失败时记录 `process-type`、`sandbox-result`、`win32-last-error` 和
`sandbox-tag`，用于区分 Renderer、GPU、Network Service 等不同失败阶段。

## Google 登录与 API 凭据

登录 Gmail、YouTube 等普通网站不需要 Chromium API 凭据。浏览器自身的
Google 账号登录与同步则需要由 AI-FREE 所属 Google Cloud 项目合法申请的
API key、OAuth desktop client ID 和 client secret。不要把这些凭据提交到
仓库或写入补丁；启动器支持从当前进程环境读取以下 AI-FREE 专用变量，并在
启动浏览器时映射为 Chromium 官方支持的变量：

```powershell
$env:AI_FREE_GOOGLE_API_KEY='你的 API key'
$env:AI_FREE_GOOGLE_CLIENT_ID='你的 OAuth client ID'
$env:AI_FREE_GOOGLE_CLIENT_SECRET='你的 OAuth client secret'
npm start
```

也可以继续直接使用 `GOOGLE_API_KEY`、`GOOGLE_DEFAULT_CLIENT_ID` 和
`GOOGLE_DEFAULT_CLIENT_SECRET`。如果两套变量同时存在，原生 `GOOGLE_*`
变量优先。修改后必须完全退出并重新启动 AI-FREE。

Google 对 Chromium 派生版的浏览器级登录和 Chrome Sync 令牌实施服务端
限制；自建凭据不等于自动获得面向所有终端用户的 Chrome Sync 分发权限。
开发测试账号需按 Chromium 官方要求取得相应授权，正式产品则应申请 Google
许可或使用 AI-FREE 自己的账号与同步服务。
