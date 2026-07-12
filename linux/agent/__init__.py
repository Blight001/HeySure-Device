"""HeySure Linux 服务器端 agent（边车式接入服务）。

按 device/read.md 协议，把一台 CentOS / Ubuntu 服务器封装成 HeySure 平台上
AI 成员可调用的「自定义设备」（deviceType: custom）：

  - 登录换 token → Socket.IO 长连接 → device:register 注册（断线/失效自动恢复）；
  - MCP 转换层：把服务器运维能力（系统信息、进程、systemd、日志、磁盘、网络、
    软件包、文件、shell）封装成 MCP 工具，接收 task:dispatch，恰好回一次结果；
  - 命令行远程（rt:*）：真人操作者在网页控制台直接驱动本机交互式 shell（PTY）。

这是无 GUI 的常驻进程，适合用 systemd 部署到服务器。入口见 agent.main。
"""

__version__ = "1.0.0"
