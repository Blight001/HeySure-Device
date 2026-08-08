# HeySure 安卓端（数字社会控制台 + 设备 Agent）

Android App 同时承担两个彼此独立、可并行运行的角色：

1. **数字社会控制台**：全屏、硬件加速的原生 WebView 壳，直接打包并运行工作区
   `web/` 的 Vue + Phaser 生产构建，不在 Android 工程中复制控制台 UI 组件。
2. **设备 Agent**：登录后连接后端并注册为 endpoint，接收任务后执行点击、滑动、
   长按、系统导航、文本输入、截屏和录屏；切换到控制台或退到后台时仍由前台服务保活。

启动 App 默认进入数字社会控制台。首次使用或登录态失效时自动进入原生 Agent 登录/授权页；
控制台的「设备」入口是可拖拽气泡：松手后吸附最近的左右边缘并半收起；点击展开
「设备设置 / 刷新页面」菜单，避免固定遮挡网页内容，也允许用户按需主动拉取最新页面。

## 控制台源码复用与性能方案

```text
deploy/web/src + deploy/web/game（唯一 UI 源码）
       │ npm run build（Gradle 自动触发、支持增量）
       ▼
app/build/generated/heysureWebAssets/web
       │ APK assets，断网时兜底读取 JS/CSS/图片/音频
       ▼
ConsoleActivity / Android System WebView（硬件加速）
       │ 页面 Origin 保持为用户配置的 serverUrl
       ├── /api、/socket.io、WebRTC ──► HeySure Server
       └── 页面与 /assets、/game/ ──► Web 服务器（APK 断网兜底）
```

- 控制台、聊天和「社会显示」继续使用 Web 已有的响应式布局；移动端仍是「控制台 / 社会显示」
  双 Tab，不维护 Android 专属 Vue 组件。
- 页面 Origin 仍是服务器地址，现有相对 REST 路径、Socket.IO、WebRTC、头像和临时图片契约
  无需分叉，也没有 `file://` 跨域问题。
- App 不轮询网页版本，普通前后台切换不会刷新。需要拉取新部署时，点击贴边「设备」气泡，
  再选择「刷新页面」。JS/CSS 使用 Vite 内容哈希与 WebView 缓存，断网时整套切回 APK
  内置页面和配套资源，避免新旧资源混用。
- Android 在后台回收并重建控制台 Activity 时会恢复原 WebView 页面、历史与版本签名，不会因为
  普通的前后台切换重新加载；设备 Agent 仍由前台服务保持后台连接。
- 登录地址建议填写 Web 入口（默认 `:58150`）；如果历史配置填写的是直连 API Gateway
  `:3000`，App 会自动使用同主机的 `:58150` 加载控制台，API 与 Socket 连接配置不受影响。
- 「社会显示」仍按 Web 端既有逻辑在首次切换 Tab 时才加载 Phaser，隐藏后暂停渲染循环。
- 网页部署更新后，已安装 App 会自动检测并载入；重新构建 APK 仍会同步最新离线兜底源码。
  `web/dist` 和生成的 Android assets 都不是手工维护源。

> 方案选型：**手机上的原生 Kotlin App**（自包含 endpoint），不依赖电脑/ADB/root。
> 这与桌面壳"壳运行在它所控制的设备上"的心智模型一致。点击/滑动用
> `AccessibilityService.dispatchGesture()`，截屏/录屏用 `MediaProjection`。
>
> 这是**方案 A**。若需要**息屏/锁屏下也能控制**，用同类设备的**方案 B**——
> 宿主电脑经 ADB 控制手机：[`device/android/android-adb`](android-adb)。两者同为 `android`
> 设备类型、工具名一致，按场景二选一或并存。

## 与服务端的契约（与桌面壳完全一致）

通过 **Socket.IO** 连接 connector_runtime，讲的是和 Electron/扩展壳同一套协议：

| 方向 | 事件 | 载荷要点 |
| --- | --- | --- |
| agent → server | `device:register` | `id / name / platform("android-mobile …") / capabilities / toolDefs / token / isAndroid:true` |
| server → agent | `task:dispatch` | `taskId / tool / args / allowedTools` |
| agent → server | `task:progress` / `task:result` / `task:error` | 执行回执（idempotent，按 taskId 去重） |

服务端把 `isAndroid` 的 endpoint 识别为独立设备类型 `android`（见
`server/main/connector_runtime/dispatch/desktop_device_tools.py::device_type_of`），
有自己的标签"安卓端Agent"与 MCP 权限分组；但在**任务派发**上归为桌面类执行器，
因此点击/截屏等工具走 `get_connected_desktop_agent` 通道。`screen.capture` 返回
`dataUrl`，会被服务端截图管线自动落盘并转发给用户。

## 工具表（self-described，注册时上报 toolDefs）

| 工具 | 作用 | 实现 |
| --- | --- | --- |
| `touch.tap` | 坐标单击 | `dispatchGesture` |
| `touch.long_press` | 坐标长按 | `dispatchGesture` |
| `touch.swipe` | 两点滑动/拖拽 | `dispatchGesture` |
| `touch.back` / `touch.home` / `touch.recents` | 系统返回/主屏/最近任务 | `performGlobalAction` |
| `input.text` | 向聚焦输入框写文本 | `AccessibilityNodeInfo.ACTION_SET_TEXT` |
| `screen.capture` | 截屏（PNG dataUrl） | `MediaProjection` + `ImageReader` |
| `screen.record` | 录屏（mp4） | `MediaProjection` + `MediaRecorder` |

新增工具：在 `executor/ToolCatalog.kt` 注册一个 `Tool`（name/description/inputSchema/run），
其 schema 会随 `device:register` 自动上报给服务端，无需改后端。

## 工程结构

```
app/src/main/java/ai/heysure/agent/
  console/ConsoleActivity.kt    数字社会控制台壳 / 本地资源拦截 / 文件选择 / JS bridge
  MainActivity.kt              登录 / 引导开启无障碍 / 授权截屏 / 状态显示
  agent/Settings.kt            SharedPreferences（serverUrl / token / deviceId）
  agent/ServerApi.kt           REST：POST /api/auth/login
  agent/SocketAgent.kt         Socket.IO 客户端 + register + 任务循环（对标 device.ts）
  agent/AgentService.kt        前台服务：持有 socket 与 MediaProjection 授权，保活
  executor/Tool.kt             工具接口 + schema helper
  executor/ToolCatalog.kt      工具目录（tap/swipe/screen/record/...）
  executor/TaskExecutor.kt     校验 allowedTools 并执行
  accessibility/GestureAccessibilityService.kt  注入手势 / 全局动作
  capture/ScreenCaptureManager.kt               截屏 + 录屏
```

## 构建与运行

```bash
# 需要 JDK 17、Android SDK、Node.js/npm。Gradle 会从同一工作区的 ../../deploy/web 自动构建控制台。
# 推荐：用 Android Studio 打开 device/android 并构建/运行到真机。
# 命令行方式（首次需生成 wrapper 脚本/jar，仓库只 pin 了版本 gradle-wrapper.properties）：
cd device/android
gradle wrapper                   # 生成 gradlew / gradle-wrapper.jar（需本机已装 Gradle 8.7）
./gradlew assembleDebug          # 产物 app/build/outputs/apk/debug/

# Windows 也可直接：
build-apk.bat debug
```

Gradle 任务关系为 `preBuild → syncHeySureWeb → buildHeySureWeb → npm run build`。当 `web/`
源码和配置没有变化时会命中 Gradle up-to-date，不会重复构建；缺少 `deploy/web/node_modules` 时会先
执行 `npm ci`。因此日常 UI 修改应直接在 `deploy/web/src` 或 `deploy/web/game` 完成，不要在 Android 中
新建一套显示组件。

原生 Agent 设置页沿用深色靛紫风格（卡片式 + 顶部状态点：绿=已注册 / 黄=连接中 / 红=未连接），
包含登录账号、权限授权、后台与常亮、运行日志。首次使用：

1. **登录账号卡**：填服务器地址 + 账号密码，点「登录并连接」。
2. **权限授权卡**：「开启无障碍」（点击/滑动依赖）+「授权截屏/录屏」（截屏录屏依赖），各授一次。
3. **后台与常亮卡**（让手机放着也尽量可控）：
   - 「保持屏幕常亮」开关：开启后用 WakeLock 让屏幕压暗常亮、CPU 不休眠，截屏不黑、手势可注入、socket 不易被 Doze 掐（**较耗电**）。
   - 「申请后台不被杀」：把本应用加入电池优化白名单，减少息屏后被系统回收。

授权后会启动前台服务长连，状态栏显示运行中；之后由 Web「作坊」面板把某个 AI 分配给该设备。

> 提醒：常亮模式不是"真息屏控制"——它靠让屏幕保持点亮（压暗）来维持可控。若要**真正息屏 +
> 安全锁屏下控制**，请用同类设备的方案 B（电脑 ADB）：[`device/android/android-adb`](android-adb)。

## 注意点

- **本 CI/远程环境无法编译/运行 Android**（无 Android SDK、需真机授予无障碍与投屏权限）。
  这里只能完成静态编写，实际行为需在真机验证。
- `minSdk = 26`（Android 8.0）——`dispatchGesture` 与前台服务投屏类型所需。
- Android 14（API 34）要求投屏前台服务声明 `FOREGROUND_SERVICE_MEDIA_PROJECTION` 且
  在 `startForeground` 时带 `mediaProjection` 类型，本工程已处理。
- `build/`、`.gradle/`、`local.properties` 等已在根 `.gitignore` 忽略。

## 权限说明（为何需要 / 非诈骗用途）

本应用是**经用户授权的远程协作/自动化工具**，由用户自己的 HeySure 账号登录、绑定到用户
自己的 AI；所有动作来自用户自己的服务器，不上传通讯录/短信，不读取其它应用数据。但它的
能力组合（无障碍 + 屏幕共享 + 后台常驻）天然与"远程控制木马"相似，会被反诈系统/Play Protect
警惕。为降低误判，已做如下收敛：

| 权限 | 用途 | 是否必需 |
| --- | --- | --- |
| `BIND_ACCESSIBILITY_SERVICE`（无障碍） | 模拟点击/滑动/返回主屏 | 必需（核心功能，删了就不能操作） |
| `MediaProjection`（投屏，运行时授权） | 截屏 / 录屏 | 必需 |
| `FOREGROUND_SERVICE(_MEDIA_PROJECTION)` | 后台保活 + 截屏录屏前台类型 | 必需 |
| `INTERNET` / `ACCESS_NETWORK_STATE` | 连接用户自己的服务器 | 必需 |
| `POST_NOTIFICATIONS` | 显示常驻运行通知（透明告知用户） | 必需 |
| `WAKE_LOCK` | "保持常亮"模式 | 可选功能用 |
| ~~`RECORD_AUDIO`~~ | ~~录屏音频~~ → **已移除**，录屏改为纯画面无音频 | 已去除 |
| ~~`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`~~ | ~~一键电池豁免~~ → **已移除**，改为引导到系统设置页手动设置 | 已去除 |

进一步降低被误判 / 被银行类 App 拦截的建议：
- 用**正式 release keystore 签名**（非 debug 签名），减少 Play Protect 安装告警；
- 首启明确告知"这是远程控制/自动化工具"，保留常驻通知，不做激进自启动；
- **银行/支付类 App 仍可能因"检测到无障碍/屏幕共享"主动拒绝运行**——这是其反诈设计，
  方案 A 无法根除；该类场景请改用 [`device/android/android-adb`](android-adb)（方案 B，手机不装 App，
  反诈系统看不到可疑应用）。
