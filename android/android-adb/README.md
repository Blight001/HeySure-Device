# HeySure 安卓端 Agent · 方案 B（device/android/android-adb）

**宿主电脑经 ADB 控制手机**的端侧执行器：不在手机上装 App，而是在一台电脑上跑这个
无界面 Node 进程，用 `adb` 驱动通过 USB / 无线调试连接的安卓手机，并用和其它设备
**同一套 Socket.IO 协议**注册成 endpoint。

与 [`device/android`](..)（方案 A，手机原生 App）是**同一类设备的两种形态**：

| | 方案 A `device/android` | 方案 B `device/android/android-adb`（本目录） |
| --- | --- | --- |
| 运行位置 | 手机本机（Kotlin App） | 宿主电脑（Node 进程） |
| 点击/滑动 | 无障碍 `dispatchGesture` | `adb shell input` |
| 截屏/录屏 | MediaProjection | `adb exec-out screencap` / `screenrecord` |
| **息屏/锁屏下可控** | ✗（黑屏 + 锁屏拦截 + Doze） | **✓**（input 注入不受屏幕状态影响，可先 `KEYCODE_WAKEUP` 唤醒） |
| 需要电脑 | 否 | 是（电脑需连着手机） |
| 安全锁屏（PIN/密码） | 绕不过 | 同样绕不过（非 root） |

两种形态**都以 `isAndroid:true` 注册**，服务端统一识别为 `android` 设备类型、共用
"安卓端Agent" 标签与 MCP 权限分组；**模型看到的工具名也完全一致**
（`touch.tap` / `touch.swipe` / `screen.capture` / `screen.record` / `input.text` …），
方案 B 额外提供 `touch.wake`（息屏先唤醒）。因此后端无需为方案 B 做任何改动。

## 前置条件

1. 宿主电脑安装 **Android Platform Tools（adb）** 并加入 PATH。
2. 手机开启 **USB 调试**（或无线调试），`adb devices` 能看到设备且状态为 `device`。
3. Node ≥ 18。

## 运行

```bash
cd device/android/android-adb
cp .env.example .env        # 填 HEYSURE_SERVER_URL / 账号 / 密码 /（可选）ANDROID_SERIAL
npm install
npm run dev                 # 或 npm run build && npm start
```

启动后会：选定手机 → 登录换 token → 连接后端注册为安卓端点。之后由 Web「作坊」面板
把某个 AI 分配给该设备即可调用。多台手机：跑多份进程，每份用 `ANDROID_SERIAL` 指定一台。

## 关于息屏控制

- `adb shell input tap/swipe/text/keyevent` 在**息屏或锁屏下也能注入**，这是方案 B 的核心优势。
- `screen.capture` 会先 `KEYCODE_WAKEUP` 点亮再截图——否则息屏截到的是黑帧（屏幕没内容可截）。
- `touch.wake { unlock: true }` 可尝试滑动解锁，但**仅对无密码锁屏有效**；PIN/密码/指纹等
  安全锁屏，adb 无法绕过（需 root）。

## 工程结构

```
src/
  index.ts        入口：选设备 → 登录 → 连接注册
  config 由 .env  （dotenv）
  server-api.ts   REST 登录 + URL 规范化
  agent.ts        Socket.IO 客户端 + register + 任务循环
  adb.ts          adb 命令封装（tap/swipe/text/keyevent/wake/screencap/screenrecord）
  executor.ts     工具目录（与方案 A 同名同 schema）+ 执行
```

## 注意点

- **本 CI/远程环境无 adb、无真机，无法运行验证**；仅完成静态编写 + `tsc` 类型检查。
- `dist/`、`node_modules/`、`.env`（保留 `.env.example`）已被 gitignore。
- adb 录屏不含音频（`screenrecord` 限制）；录屏最长 180s（adb 上限）。
