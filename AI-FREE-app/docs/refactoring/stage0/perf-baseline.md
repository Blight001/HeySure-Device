# 性能与构建基线

采集日期：2026-07-19。环境：Windows 11、Node 24.12、Electron 40、项目版本 2.6.9。Electron 探针使用临时进程环境，不读取用户正在运行的正式版数据。

| 指标 | 当前值 | 采集方式 |
|---|---:|---|
| 334 个 Node 测试 | 2.52 s | `npm test` 的 `duration_ms` |
| 完整 verify | 11.9 s | `npm run verify` 墙钟时间 |
| 完整 Electron 验收 | 8.4 s | `npm run test:acceptance` 墙钟时间 |
| 真实 Electron 首次侧栏就绪 | 318.8 ms | `npm run check:browser-settings-ui` 内置探针，含 Electron ready、页面加载和 120ms 稳定等待 |
| UI 验收流程工作集 | 429.4 MB | 同一探针结束前汇总 Electron app metrics；包含侧栏、个人中心和 app shell 多页面流程 |
| Electron 测试窗口销毁 | 4.8 ms | 同一探针对 `BrowserWindow.destroy()` 计时 |
| Chromium phase 3 全流程 | 13.2 s | 两 Profile、重启、超限拒绝、graceful stop 与恢复 |
| Windows 正式构建 | 102.1 s | native host、win-unpacked、扩展混淆、资源验证和 NSIS |
| `win-unpacked` 主程序 | 213,683,712 bytes | `appbuild/win-unpacked/AI-FREE.exe` |
| NSIS 安装包 | 287,073,398 bytes | `appbuild/AI-FREE Setup 2.6.9.exe` |

这些数字用于发现明显回退，不作为跨机器硬阈值。杀毒扫描、磁盘缓存和 Chromium 首次初始化会影响墙钟与内存；功能门禁仍以行为结果、资源完整性和无孤儿进程为准。

真实 Electron 测试必须使用临时 `userData`，避免与用户正在运行的打包版共享 `%APPDATA%/ai-free`；AutomationBridge 应使用随机空闲端口。
