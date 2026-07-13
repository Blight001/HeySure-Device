# HeySure Linux 服务器端 Agent

把一台 **CentOS / Ubuntu 服务器**接入 HeySure 平台，成为 AI 成员可调用的
「自定义设备」（`deviceType: custom`）。无 GUI 的常驻进程，用 systemd 部署。

按 [`device/read.md`](../read.md) 协议实现（**边车式**，对系统零侵入）：

- **登录连接**：REST 换 token → Socket.IO 长连接 → 注册；断线 / token 失效自动恢复。
- **MCP 转换层**：把服务器运维能力封装成 MCP 工具，AI 调用时执行、恰好回一次结果。
- **命令行远程（`rt:*`）**：真人在网页控制台直接操作本机交互式 shell（PTY，走
  Socket.IO relay，**无需 TURN**，公网可用）。这是「管控」服务器最顺手的通道。

> 与旧的 `device/linux/` Electron 桌面端不同：那是有界面的桌面客户端，这是面向
> **服务器**的无界面 agent。两者定位不同，此目录已切换为服务器端实现。

## 工具清单

| 工具 | 作用 | 危险 |
| --- | --- | --- |
| `system.info` | 发行版 / 内核 / 架构 / CPU / 内存 / 运行时长 | 只读 |
| `system.metrics` | 实时 CPU% / 负载 / 内存 / 交换 / 各盘使用率 | 只读 |
| `process.list` | 进程列表（按 CPU/内存排序、按名过滤） | 只读 |
| `service.status` | systemd 服务状态 + 最近日志 | 只读 |
| `service.control` | start/stop/restart/enable/disable 服务 | **危险** |
| `journal.query` | journald 日志查询（按单元/时间/级别） | 只读 |
| `package.query` | 查软件包是否安装及版本（dpkg/rpm 自适应） | 只读 |
| `disk.usage` | 磁盘使用（df）+ 可选目录 du | 只读 |
| `network.info` | 网卡 IP / 监听端口 | 只读 |
| `file.read` | 读文本文件（头/尾，≤512KB） | 只读 |
| `shell.exec` | 执行任意 shell 命令（一次性） | **危险**（可关） |
| `console.open` | 新建常驻交互式控制台（PTY），返回 sessionId | **危险**（可关） |
| `console.send` | 向控制台输入内容（默认带回车），返回新增输出 | **危险**（可关） |
| `console.read` | 拉取控制台自上次以来的最新输出 | 只读 |
| `console.list` | 列出所有控制台会话及存活状态 | 只读 |
| `console.close` | 关闭控制台会话（杀进程组） | **危险**（可关） |

外加传输层能力字 `remote_terminal`（不是 MCP 工具，解锁命令行远程通道）。

`shell.exec` 是「万能」工具：默认开启（因为要「管控」本机），如需更保守的**纯只读画像**，
设 `HEYSURE_ENABLE_SHELL_EXEC=false` 即可从工具清单里去掉它。

### `console.*`：给 AI 的持续交互式控制台

`shell.exec` 是**一次性**的：起子进程 → 跑完 → 拿全部输出。碰上「安装到一半问你
`[Y/n]`、让你选镜像源」这类**交互式提示**就废了——命令不退出、也拿不到中间输出。

`console.*` 用 PTY 起一个**常驻 shell 会话**，AI 能像人一样一轮轮操作：

```
console.open                       → { sessionId: "a1b2c3", output: "[root@host ~]# " }
console.send  {sessionId, input:"apt install nginx", timeout_seconds:30}
                                   → output: "... Do you want to continue? [Y/n] "   ← 停在提示符
console.send  {sessionId, input:"y", timeout_seconds:120}
                                   → output: "...Setting up nginx... done"           ← 回答后的结果
console.read  {sessionId, timeout_seconds:20}   → 命令还在跑时，反复拉最新进展
console.close {sessionId}
```

要点：

- **只返回「新增」输出**：每次 `send` / `read` 只给上次以来的增量，不会把整屏历史重复灌给 AI。
- **何时返回**：输出**静默 ~0.4 秒**即返回（说明进程停下来等输入了），不必傻等命令结束；
  最长等 `timeout_seconds`（`send` 默认 3s、`read` 默认 0=立即取）。命令慢就把它调大。
- **有状态**：`cd` / 环境变量 / 后台任务在同一会话内跨调用保留。
- **控制键**：`console.send {sessionId, control:"c"}` = Ctrl+C 中断卡住的命令；`"d"` = Ctrl+D。
- **只按回车**：`input:""`（默认 `enter:true` 会补回车）。
- 输出已洗掉 ANSI 转义序列；单次最多回 60K 字符（超出保留**最新**部分）。
- 最多同时 8 个会话，用完请 `console.close`。会话**不随 socket 断线关闭**（长时间安装可跨重连
  继续），只在 agent 进程退出时统一回收。
- 关闭开关：`HEYSURE_ENABLE_CONSOLE=false`。

自检（在目标 Linux 机器上跑，不连服务器）：

```bash
cd device/linux && python3 selftest_console.py
```

会真起 PTY 走一遍「命令问确认 → 回答 y → 看结果 → Ctrl+C → 多开 → 关闭」的完整流程。

## 一键部署（推荐）

在服务器上（CentOS / Ubuntu 均可）：

```bash
# 依赖：Python 3.8+
#   Ubuntu: sudo apt install -y python3 python3-venv python3-pip
#   CentOS: sudo yum install -y python3 python3-pip

cd device/linux
cp .env.example .env
vi .env                     # 填 HEYSURE_SERVER / 账号 / 密码

sudo ./install.sh           # 建 venv、装依赖、装成 systemd 服务并启动
journalctl -u heysure-linux-agent -f   # 看到「✅ 已注册」即成功
```

改完 `.env` 后 `sudo systemctl restart heysure-linux-agent` 生效。

## 手动 / 开发运行

```bash
cd device/linux
cp .env.example .env && vi .env
./run.sh                    # 建 .venv、装依赖、前台运行（Ctrl-C 退出）
```

## 配置项（环境变量）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `HEYSURE_SERVER` | 是* | API Gateway 地址，默认 `http://127.0.0.1:3000` |
| `HEYSURE_ACCOUNT` / `HEYSURE_PASSWORD` | **是** | 与网页控制台同一账号 |
| `HEYSURE_SERVICE_ID` | 否 | 逻辑 ID，稳定唯一；默认 `linux-<主机名>-<machine-id>` |
| `HEYSURE_SERVICE_NAME` | 否 | 展示名；默认「Linux 服务器 (主机名)」 |
| `HEYSURE_ENABLE_REMOTE_TERMINAL` | 否 | 命令行远程开关，默认 `true` |
| `HEYSURE_ENABLE_SHELL_EXEC` | 否 | `shell.exec` 工具开关，默认 `true` |
| `HEYSURE_ENABLE_CONSOLE` | 否 | `console.*` 交互式控制台工具开关，默认 `true` |
| `HEYSURE_SHELL` | 否 | PTY/`shell.exec` 默认 shell，默认自动探测 |
| `HEYSURE_ICON` | 否 | 设备图标 `"1"`~`"8"` / 路径 / URL |
| `LOG_LEVEL` | 否 | `DEBUG`/`INFO`/`WARNING`，默认 `INFO` |

完整示例见 [`.env.example`](.env.example)。

## 权限（重要）

工具与命令行远程都以 **agent 进程自身的权限**运行：

- `install.sh` 默认让 systemd 以 **root** 运行，`service.control`、全量 `journal.query`、
  `shell.exec`、命令行远程才有完整能力。这台机器上该账号的 AI ≈ 拥有 root shell，请
  确保绑定的 AI 与授权范围可信。
- **想最小权限**：把单元里的 `User=root` 改成专用用户，再给该用户配 `sudo NOPASSWD`
  仅限需要的 `systemctl` 子命令；agent 里的 `service.control` 会自动尝试 `sudo -n`。
  只读工具（system/process/disk/network/package/file）大多无需 root。

## 两道闸门（部署后由你在网页操作）

服务在线 ≠ AI 可调用（read.md 7）。部署成功后：

1. 到网页控制台**作坊面板**，给本服务**分配一个 AI**（闸门 1：绑定）。
2. 在该服务的 **MCP 权限**里**勾选要开放的工具并保存**（闸门 2：授权，默认全关）。
3. 对绑定的 AI 说一句会触发工具的话（如「看看服务器磁盘还剩多少」）验证。
4. 命令行远程：在网页控制台点开本设备的终端即可实时操作（需 `remote_terminal` 已声明，默认已开）。

## 验证与排查

注册成功最直接的信号是 agent 日志出现 **`✅ 已注册`**。要用 REST 复核，最可靠的是
查 **该设备的 MCP 权限**（读数据库 presence 快照，跨进程有效）：

```bash
TOKEN=$(curl -s -X POST http://<server>:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"account":"<账号>","password":"<密码>"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

# hasRecord=true 且 toolDefs 里是你上报的 16 个工具 = 注册成功、schema 已入库
curl -s "http://<server>:3000/api/devices/<你的 SERVICE_ID>/mcp-scope" \
  -H "Authorization: Bearer $TOKEN"
```

> 注意 `GET /api/devices/connected` 在**分进程/容器（docker-compose）部署**下可能返回
> 空 `agents`——该接口只反映网关进程自己的内存 socket，而端侧 socket 实际连在
> connector 进程上。**这不代表设备没连上**：绑定、任务派发、命令行远程都正常，网页
> 控制台作坊面板（走 Socket.IO 实时列表）也能看到本设备。以 agent 日志和上面的
> `mcp-scope` 为准。

| 症状 | 检查 |
| --- | --- |
| 日志无「已注册」 | `HEYSURE_SERVER`/账号密码是否正确；`journalctl -u heysure-linux-agent` 看 reason |
| 网页作坊面板看不到设备 | 登录账号是否与网页一致；用上面的 `mcp-scope` 确认已入库 |
| AI 提示词里没有工具 | 两道闸门：是否绑定 AI？MCP 权限是否勾选保存？ |
| 任务一直转圈 | 该 taskId 是否恰好回了一次结果（正常本 agent 保证恰好一次） |
| `service.control` 失败 | 是否 root，或 sudo NOPASSWD 是否配好 |
| 命令行远程「不支持」 | `HEYSURE_ENABLE_REMOTE_TERMINAL` 是否为 true（声明 `remote_terminal`） |
| `system.metrics` 报错 | `psutil` 未装：`.venv/bin/pip install psutil` |

## 目录结构

```
device/linux/
  agent/
    main.py            进程入口（python -m agent.main）
    config.py          环境变量配置契约（read.md 0.3）
    connection.py      登录 + Socket.IO + 注册 + 自动恢复（read.md 3、4）
    dispatch.py        MCP 转换层：task:dispatch → 工具 → 恰好一次回包（read.md 8）
    remote_terminal.py 命令行远程 rt:* PTY 通道（read.md 9.2）
    shellrun.py        受控子进程执行底座
    tools/
      base.py          Tool 类型与注册辅助
      system.py        system.info / system.metrics / process.list
      services.py      service.status / service.control / journal.query
      storage.py       disk.usage / file.read
      network.py       network.info
      packages.py      package.query（dpkg/rpm）
      shell.py         shell.exec（可开关）
      console.py       console.*：常驻 PTY 会话，供 AI 做多轮交互（可开关）
  requirements.txt
  .env.example
  run.sh               开发/手动运行
  install.sh           生产部署（venv + systemd）
  systemd/heysure-linux-agent.service
```
