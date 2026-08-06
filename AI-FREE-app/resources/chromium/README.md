# AI-FREE Chromium Fork 产物目录

正式 Fork 构建产物放入本目录，并保持 Chromium 运行所需的版本目录、DLL、PAK、Locales 等相对结构。

正式模式只查找 `ai-free-browser.exe`。即使目录中保留了构建原名
`chrome.exe`，也不会把它当作正式入口；后者只可用于显式启用的
`prototype` 排障模式。

禁止把本机安装的 Google Chrome 文件复制进发布包。系统 Chrome/Edge 只允许由 `prototype` 冒烟模式临时调用。

Chromium Fork 至少需要完成：

- Windows 产品全称：`AI-FREE Browser`
- 产品短名：`AI-FREE`
- Windows 图标、版本资源和 AppUserModelID
- `chrome://version`、`chrome://settings` 等 WebUI 品牌字符串
- `--hs-*` 私有启动参数和 Runtime Bridge 命名管道握手
- Browser HWND 主动上报
- 正式代码签名和更新版本号
