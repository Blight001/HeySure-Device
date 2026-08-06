# Native Browser Host

Windows x64 的 Chromium 子窗口宿主，使用 N-API，API 与
`docs/architecture/Chromium-Fork-Win32嵌入实施方案.md` 第 6 节一致。

构建前安装 Visual Studio 2022 Build Tools，并勾选“使用 C++ 的桌面开发”和
Windows 10/11 SDK，然后在 `app2.1` 执行：

```powershell
npm run build:native-host
npm --prefix native/browser-host test
```

正式运行要求 Chromium Fork 完成命名管道握手。仅做 Phase 0 原版 Chromium
验证时，可以设置 `AI_FREE_CHROMIUM_HANDSHAKE=prototype`，允许按受控子进程 PID
枚举其主窗口。生产包不得设置该变量。
