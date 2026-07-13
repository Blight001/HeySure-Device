# browser_MCP_win

Windows 原生执行版浏览器 MCP。扩展仍使用 DOM、ARIA、Shadow DOM 和浏览器只读 API
识别页面内容与元素坐标，但不会在页面内派发点击、键盘、滚动或拖拽事件。

## 数据流

```text
browser_observe / DOM API -> 元素 ref 与最新视口坐标
browser_action / browser_drag / browser_tab
  -> http://127.0.0.1:38473/v1/input
  -> device/windows (Tauri + Rust)
  -> enigo / Windows 原生鼠标键盘
```

普通 `device/browser_MCP` 的行为不变。两个扩展不能同时连接为同一个设备，测试时建议
只启用其中一个。

## 构建与使用

1. 启动 `device/windows/run.bat`，Windows 端会启用本机浏览器原生输入桥。
2. 运行 `build.bat`。
3. Chrome 打开 `chrome://extensions`，启用开发者模式并加载 `dist/`。
4. 在扩展设置的“Windows 原生输入桥”中测试连接；无需地址或令牌配置。
5. 保持目标浏览器窗口未最小化。执行时 Windows 端会按标签标题激活对应浏览器窗口。

## 当前边界

- 原生执行：点击、双击、右键、文本输入、组合键、滚轮、拖拽、标签切换、地址栏导航、
  前进、后退和关闭标签。
- 只读感知：observe、页面内容、截图、DOM/ARIA/Shadow DOM 元素定位。
- Cookie、storage、下载等数据型工具仍使用其对应浏览器 API；它们不是鼠标键盘交互。
- Windows 优先读取 Chromium 当前页面的 `Chrome_RenderWidgetHostHWND` 实际物理矩形，
  再把 DOM 视口坐标按宽高比例映射，因此会自动扣除标签栏/地址栏并兼容 DPI、页面缩放
  和窗口位置；无法读取渲染窗口时使用浏览器内外尺寸回退。跨域 iframe 通过逐级读取
  iframe 外框位置换算到顶层视口。
- Windows 锁屏、安全桌面、浏览器最小化或原生输入桥被停用时，桥接器会拒绝执行。

## 强制弹窗防护

- 扩展加载时通过 Chrome `contentSettings` 将定位、摄像头、麦克风、通知、网页弹窗和
  自动多文件下载设为 `block`，网站会直接收到拒绝而不会显示权限询问。
- MAIN world 守卫会取消文件/目录选择器、USB、Bluetooth、Serial、HID、MIDI、屏幕共享、
  WebAuthn、安全全屏/指针锁以及 `alert`、`confirm`、`prompt`、`print`、`beforeunload`。
- Windows 原生点击不会打开 `<input type="file">`；需要上传时明确调用
  `browser_file_upload`，由扩展直接填入文件对象。
- 若原生文件选择窗口已经出现，Windows 桥只会关闭属于目标浏览器进程的系统对话框，
  不会关闭编辑器或其他应用的窗口。
- 对旧标签页或漏网的浏览器原生弹窗（确认离开、HTTP 认证、权限气泡、系统信息框），
  快速页面请求若 6 秒无响应会自动激活目标浏览器、取消对话框、补装 MAIN world 守卫，
  然后重试原请求一次；不会自动确认离开或授权设备。
- AI 已经从截图确认存在原生弹窗时可直接调用
  `browser_action {"action":"dismiss_dialog"}`，无需先从 DOM 找关闭按钮。系统对话框仅在
  进程相同或 Win32 owner 链指向目标浏览器时才会关闭；随后发送一次真实 `Escape`。
- UAC、SmartScreen 和 Windows 安全桌面不属于浏览器窗口，出于安全原因不会自动确认或关闭。
