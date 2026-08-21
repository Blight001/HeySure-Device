# HeySure 设备端点统一协议与第三方实施指南（read.md）

> 本文是官方设备端与第三方端点共同遵守的 Socket.IO、MCP 目录、任务和远程连接协议真源。
> 设备产品、设备大厅、发行包、登录和更新流程见
> [`../doc/design/device-hall-release-and-connection.md`](../doc/design/device-hall-release-and-connection.md)。
> 服务端实现仍是最终合同：注册与目录见
> `deploy/server/main/connector_runtime/socket_handlers/registration.py`，动态目录见
> `deploy/server/main/api/services/device_tools/device_workspace_tools.py`，远程连接见
> `remote_control.py` / `remote_terminal.py`。

> 本文后半的 Python / Node.js 模板面向 AI 编码代理和第三方服务开发者。按模板接入时，
> 交付两个模块：
>
> 1. **登录连接模块**：REST 登录换 token → Socket.IO 长连接 → 注册；断线、token
>    失效均自动恢复。
> 2. **MCP 转换层**：把本项目已有能力（函数 / 内部 API / DB 查询）封装成 MCP
>    工具，接收调用、路由执行、回传结果。
>
> 命名约定：协议事件与字段沿用历史命名 `device`（`device:register`、`deviceId`），
> 指的就是你注册的这个服务实例；网页控制台把它显示为一台"自定义设备"。

---

## U. 统一端点实现标准（所有设备必读）

本节使用“必须 / 禁止 / 应”表示统一规范要求，并明确区分两种状态：**[现行]** 是服务器或
端点已经实现的事实，**[目标 vNext]** 是所有端必须收敛到、但尚不能假定已上线的合同。
官方端的实现差异只能放在明确的端型 profile 里，不能各自重新解释事件、目录或远控协议。

### U.1 四层能力必须分开

| 层 | 权威与生命周期 | 是否进入 `capabilities` / `toolDefs` | 典型例子 |
| --- | --- | --- | --- |
| 原生执行原语（private builtin） | 端侧代码随版本发布，通常只供包装器调用 | **否**；它不是模型可见 MCP | 浏览器 DOM/CDP handler、Windows PowerShell/shell runner |
| 固定 MCP（device-owned static） | 端侧代码定义，升级客户端才变化 | **是**；每次注册完整自报 | Linux 运维工具、Android 触控/截屏、第三方业务工具 |
| 服务器动态 MCP（server-managed dynamic） | 服务器按“用户 + `deviceType`”保存，经 `device:tool-config` 下发；仅当前连接有效 | 应用后进入下一次完整注册 | Windows runtime 工具、浏览器 program 包装器、Android program 扩展 |
| 远程连接能力（transport capability） | 实时传输面，按 socket 会话生灭 | 只进 `capabilities`，**禁止**进 `toolDefs` | `remote_control`、`remote_terminal` |

本地持久化动态 MCP 是历史兼容层，不是新的官方标准。当前主浏览器扩展仍保留该能力，
但新端点不得再增加本地管理工具；官方目录的长期唯一写入方是服务器 / Web 控制台。
本地动态与服务器动态同名时服务器版本优先，断线时必须清掉服务器快照，不能拿旧快照继续上报。

### U.2 目标 vNext：有效目录与冲突规则

端侧每次注册上报的是一代**完整有效目录**，不是增量：

```text
effective MCP catalog = public fixed MCP
                      + current server dynamic snapshot
                      + explicitly allowed legacy local dynamic MCP
capabilities          = effective catalog names + implemented transport capabilities
toolDefs              = every effective MCP's complete definition
```

以下是 **[目标 vNext]** 的硬性规则；当前服务端仍兼容 capability 缺少 definition，部分官方端
也尚未原子应用动态目录，实际差距以 U.3 / U.7 为准：

1. `capabilities` 中的每个模型可调用名称都必须有且只有一个 `toolDefs`；`remote_*` 是唯一
   明确排除的传输能力字。协议 v2 不依赖“无 schema 宽松兜底”。
2. 动态工具默认不得覆盖公开固定 MCP。需要包装固定实现时，应把原生实现降为私有原语，
   用 `builtin:<name>` 等端型内部引用调用；私有原语本身不得上报。
3. 收到 `device:tool-config` 后必须校验完整 envelope 和全部工具，全部成功才原子替换上一快照；
   任一项失败则保留上一代并记录脱敏错误，禁止半新半旧。
4. 应用成功后重新发送 `device:register`，以合并后的 `capabilities` / `toolDefs` 为准。
   `device:registered` 返回的 generation/hash 是服务端最终权威。
5. socket 断开时清除服务器动态快照、停止新调用并清理远控会话；重连注册后等待服务器重发
   完整快照。服务器动态定义不得持久化成离线可执行代码。
6. `task:dispatch.tool` 必须同时存在于当前有效目录和 `allowedTools`；否则立即回
   `task:error`。每个 `taskId` 仍只允许一个终态回包。

### U.3 官方端型 profile 与当前状态

| 端型 | 当前分类 | 固定 / 私有能力 | 当前 `device:tool-config` 行为 | 当前远程连接行为 |
| --- | --- | --- | --- | --- | --- |
| Windows Tauri | 由旧特征推断 `desktop` | runner 为私有原语；公开固定 MCP 为 0 | 接受 `program/js/runtime(powershell,shell)`；忽略 envelope 代次并逐项应用 | desktop `rc:*` + `rt:*`；新画面会话替换旧会话，quality 生效 |
| Browser / Browser-win | 由旧特征推断 `browser` | handler 私有；仍公开本地 manager / 本地动态兼容层 | 端侧只接受 `program`；整组校验但不校验服务器 revision | browser-tab `rc:*`；可多会话，quality 当前忽略 |
| Android App | 由旧特征推断 `android` | 9 个固定 MCP | 接受 `program`，但静默跳过非法/冲突项，断线不清快照 | android `rc:*`；可多会话，quality 当前忽略 |
| Linux Agent | 显式 `custom` | 固定运维 MCP | 不监听动态目录 | 可选 `rt:*` |
| Android ADB | 由旧特征推断 `android` | 10 个固定 MCP（比 App 多 `touch.wake`） | 服务端仍会推送，但客户端不监听、不应用 | 无 |
| AI-FREE | 显式 `custom` | 运行时汇总并自报 `aifree.*` / `opencut.*` | 不下发 | managed-browser `rc:*`；新会话替换旧会话，quality 生效 |
| `browser_automation` | 历史实现 | 自带旧固定目录 | 非统一实现 | 非统一实现；legacy，不新增功能 |

“不监听/不应用动态目录”是该 profile 的显式能力边界，不代表所有官方端都可以忽略
`device:tool-config`。新增官方 GUI 端默认采用服务器动态目录；自建 `custom` 服务默认采用固定
MCP，除非服务器和端侧同时登记了新的受支持 profile。

### U.4 服务器地址、正式包与本地联调

官方设备的工作区唯一默认配置是 [`device.config.json`](device.config.json)：

```json
{
  "default_server_url": "http://49.234.181.190:58150",
  "local_test_server_url": "http://127.0.0.1:3000"
}
```

- `:58150` 是官方 Web/API 统一入口，也是普通运行和正式发行包的默认地址；`:3000` 是直连
  API Gateway，主要用于本地联调或明确的自建部署。
- 标准显式地址变量统一为 `HEYSURE_SERVER`。旧端若已有别名可暂时兼容，但新代码和文档
  不得再新增别名。
- 地址解析优先级统一为：**显式运行启动器/CLI override → `HEYSURE_SERVER` → 用户最后一次成功保存的
  地址 → `device.config.json.default_server_url` → 独立检出的生产 fallback**。
- `run.bat` 必须强制选择默认 profile 并抵消外部遗留的 local flag；`build.bat` 必须清除外部
  干扰并把默认服务器嵌入正式包，但正式包运行时仍允许用户已保存的自建地址优先。联调使用单独的
  `run-local.bat` / `build-local.bat`；本地产物必须带 `local`/`DEV` 标识，不得上传设备大厅。
- 启动器在 default/local 间切换且目标服务器改变时，必须丢弃旧服务器绑定的 JWT 与
  `agent_socket_url`，再向新地址登录；不得把旧 token 发给另一个服务器。
- 登录后的 Socket.IO 地址始终服从响应中的 `agent_socket_url`，不能用上述默认值自行拼端口。

这里的“本地”只指 HeySure Gateway。Tauri dev server、Windows 原生桥、OpenCut、Ollama、
代理等 `127.0.0.1` 端口属于产品内部边界，禁止批量替换成公网地址。

### U.5 身份、绑定和目录代次

- `deviceId` 是安装实例的稳定身份；升级、重连、切换网络都不得改变。克隆镜像必须在首次启动
  生成新的安装 ID，不能只用 hostname。
- **[目标 vNext]** 官方端必须明确声明 `deviceType` / 版本化 profile；第三方服务固定为
  `custom`。当前 Windows、Browser、Android App/ADB 仍依赖平台标记推断，不能把推断结果当成
  稳定能力合同。
- 设备与 AI 绑定是多对多；端侧不得自选 AI。`device:registered.aiConfigId` 仅是兼容的主绑定，
  完整集合读取 `boundAiConfigIds`。
- `catalogProtocolVersion` 当前参与校验、哈希和保存，但服务端还没有 v2 专属的一一对应分支；
  服务端会规范化、排序、限制数量/大小、过滤不安全描述并原子计算
  `catalogGeneration` / `catalogHash`，不是“原样存储”。目录/payload/persist 类拒绝通常带稳定
  `error_code`，认证或归属冲突可能只有 `reason`，客户端必须兼容两者。

### U.6 远程连接共同不变量

`remote_control` 与 `remote_terminal` 都是由真人操作者发起、独立于 AI/MCP 任务队列的数据面：

- 只有完整实现对应事件、资源清理和权限边界的端点才能声明能力字；不支持就不声明。
- `rc:*` 只让信令经过服务器，画面和输入走 WebRTC；公网部署按第 9.4 节取得服务器 ICE/TURN，
  禁止端侧写死 TURN 凭据。
- `rt:*` 的 PTY 字节流经 Socket.IO relay，`data` 固定为 base64；不使用 TURN。
- 两通道都必须做同账号所有权校验、按 `sessionId` 隔离、限制并发，并在 socket 断开、进程退出、
  `rc:stop` / `rt:close` 后释放抓屏、DataChannel、PTY 和子进程。
- 远程 shell 与系统级键鼠属于高风险能力，应以最小 OS 权限运行；日志不得记录屏幕内容、PTY
  字节、按键文本、token 或 ICE 凭据。

### U.7 已知收敛项（不得误写成已完成）

- 服务端当前只保证 `toolDefs` 名称都在 `capabilities`，尚未反向要求每个 MCP capability 都有
  definition；官方 Windows/Browser/Android 也尚未显式上报稳定 profile。
- 主浏览器扩展仍有本地动态 manager；迁移完成前只能作为 legacy 兼容源，不能复制到新端。
- 动态目录尚未统一原子应用：Windows 部分接受、Browser 自算 revision、Android 静默过滤且
  断线不清快照；服务端也尚未统一做跨工具环/深度检查。
- 服务端保存规则与端型执行器尚未完全锁步：Browser 可能收到自身不支持的 JS，Windows 可能
  收到自身不支持的 Python runtime。入库前必须按版本化 profile 拒绝不兼容 code kind。
- `permissionPolicy` 当前主要约束 Windows runtime 权限标签，尚不能保证 program/JS 的每个内部
  调用都受同一策略限制。
- Android App 与 Android ADB 共用 `deviceType=android`，但动态/固定工具/远控能力不同；服务端引入
  版本化 profile 前，Web 与测试必须按实际上报目录判断，不能只按 `deviceType` 推定能力。
- `remote_control` v1 尚无显式 surface/ready/maxSessions 描述；Android/Browser 的并发会话、
  quality 降级和权限就绪行为也还未完全收敛；服务端当前也不强制单画面会话或
  `busy/too_many`。增加这些字段必须先扩展服务端 schema、Web 控制端和所有主线端，再作为新协议版本启用。
- `device:tool-config` v1 没有独立的 applied/rejected 回执；当前以应用后重注册的实际目录为准。
  后续版本应回传 `revision/catalogHash/reason`，服务端不能仅凭“事件已发出”认定设备已应用。
- Windows `js` 动态执行尚无进程级隔离；完成隔离前只能运行受信服务器代码，不能宣传为沙箱。
- `allowedTools` 与终态 ACK 尚未全端收敛：当前 Windows 严格检查 allowlist，Browser 有 ACK
  outbox；其它主线端仍存在忽略 allowlist、空列表语义不一致或终态不重试的问题。
- 同一 AI 的多个已绑定端若公开同名工具，当前服务端没有稳定 tie-break；在确定性路由上线前，
  必须保证该 AI 的有效 scope 内工具名唯一。

---

## 0. 第三方服务实施流程（按序执行）

| 步骤 | 做什么 | 依据 | 验收 |
| --- | --- | --- | --- |
| 1 | 盘点项目能力，设计工具清单 | 0.1 | 产出工具表：名称 / 描述 / 参数 schema / 对应的项目函数 |
| 2 | 确定集成形态 | 0.2 | 嵌入项目进程，或独立 adapter 进程 |
| 3 | 实现登录模块 | 0.3、3 | 拿到 `access_token` 与 `agent_socket_url` |
| 4 | 实现连接与注册 | 3.2、4 | 收到 `device:registered` |
| 5 | 实现 MCP 转换层 | 5、8 | 每个 `taskId` 一个逻辑终态，并重试投递直到 ACK |
| 6 | 验证并交接给用户 | 12 | `GET /api/devices/connected` 可见本服务；提示用户去控制台绑定 AI + 勾选权限 |

### 0.1 工具设计规则

- 从项目**已有**能力中挑选，不要为接入新造功能。起步 3~10 个工具。
- 每个工具一个明确动作，参数尽量少。优先暴露只读查询；写操作 / 不可逆操作
  必须在描述中写明并标 `destructive: true`。
- **禁止**设计"万能工具"（如 `run_sql`、`eval`），除非用户明确要求。
- 命名 `<域>.<动作>`，全小写，域取业务域：`order.query`、`report.generate`。
  保留前缀见 5.1，**不得占用**。

### 0.2 集成形态二选一

- **A 嵌入式**：项目本身是常驻进程且可改代码 → 把接入模块作为项目的一个组件启动。
- **B 边车式**：项目不常驻、不便改动、或语言不便跑 Socket.IO → 写一个独立
  adapter 进程，通过项目已有的 API / CLI / DB 调用其能力。
- 判断不了就选 B（对原项目零侵入）。

### 0.3 配置契约

凭据必须走环境变量（或项目既有密钥体系），不得硬编码。地址使用统一变量；官方工作区读取
`device.config.json`，独立第三方 adapter 可保留受控的生产 fallback：

```
HEYSURE_SERVER=http://49.234.181.190:58150  # 官方统一入口；自建部署可覆盖
HEYSURE_ACCOUNT=<账号>               # 与网页控制台同一账号，服务属于该用户
HEYSURE_PASSWORD=<密码>
HEYSURE_SERVICE_ID=<项目名>-01       # 逻辑 ID：稳定唯一，重启/重连后必须不变
HEYSURE_SERVICE_NAME=<展示名>        # 网页面板与 AI 看到的服务名
```

---

## 1. 协议总览

```
你的项目 ──① POST /api/auth/login──────────► HeySure 统一入口（默认 :58150）
         ◄── access_token + agent_socket_url ─┘
         ──② Socket.IO 连接 + device:register ─►
         ◄── device:registered ───────────────┘
         ◄──③ task:dispatch {tool, args} ─────  （AI 发起调用）
         ──── task:result / task:error ───────►
```

硬性事实：

- 你的项目**不需要任何 AI 能力**。推理、编排、决定何时调用，全在 HeySure 服务端；
  项目只负责"被调用时执行、生成一个逻辑终态并可靠投递"。
- 工具目录由注册包自报（名称 + 描述 + JSON Schema），服务器会校验、规范化并原子保存整代；
  只有通过绑定与授权的有效子集才会进入 AI 的能力视图。
- 自建服务固定声明 `deviceType: "custom"`，与官方端同级调度（presence、绑定、
  权限、任务队列全部通用）。
- 服务在线 ≠ AI 可调用。还需两道闸门（绑定 + 授权，第 7 节），由人在网页控制台
  操作：新设备默认未绑定任何 AI；首次建立成员 scope 时以当前真实工具全集初始化，之后
  严格保留人工保存的子集或空集。

---

## 2. 实施模板（Python）

依赖：`pip install "python-socketio[client]" requests`（Socket.IO v4 协议）。
复制后只需替换 ①工具清单 与 ②工具实现，③④⑤ 原样保留即可。

```python
import os
import queue
import requests
import socketio

SERVER       = os.getenv("HEYSURE_SERVER", "http://49.234.181.190:58150")
ACCOUNT      = os.environ["HEYSURE_ACCOUNT"]
PASSWORD     = os.environ["HEYSURE_PASSWORD"]
SERVICE_ID   = os.getenv("HEYSURE_SERVICE_ID", "myproject-01")
SERVICE_NAME = os.getenv("HEYSURE_SERVICE_NAME", "我的项目")

# ── ① 工具清单（name/description/schema 全部对模型可见，见第 5 节） ──────────
TOOLS = [
    {
        "name": "order.query",
        "description": "按订单号查询订单状态与金额",
        "input_schema": {
            "type": "object",
            "properties": {"order_id": {"type": "string", "description": "订单号"}},
            "required": ["order_id"],
        },
    },
]

# ── ② 工具实现：工具名 → 项目内真实函数，返回 (result, summary) ──────────────
def handle_order_query(args):
    # TODO: 换成本项目已有的逻辑（调函数 / 内部 API / 查库）
    return {"order_id": args["order_id"], "status": "已发货"}, f"订单 {args['order_id']} 已发货"

HANDLERS = {"order.query": handle_order_query}

# ── ③ 登录模块：换 token；token 失效时重新调用 ──────────────────────────────
STATE = {
    "token": None, "socket_url": SERVER, "registered": False,
    "recovering": False, "register_blocked": False,
    "terminal_outbox": {}, "completed_terminals": {}, "delivering": set(),
    "in_flight": set(), "worker_started": False,
}
TASK_QUEUE = queue.Queue()

def login():
    r = requests.post(f"{SERVER}/api/auth/login",
                      json={"account": ACCOUNT, "password": PASSWORD}, timeout=10)
    r.raise_for_status()
    data = r.json()
    STATE["token"] = data["access_token"]
    STATE["socket_url"] = data.get("agent_socket_url") or SERVER  # 永远优先用该字段

# ── ④ 连接与注册 ────────────────────────────────────────────────────────────
sio = socketio.Client(reconnection=True, reconnection_delay=2)

def queue_terminal(event, payload):
    task_id = payload["taskId"]
    STATE["terminal_outbox"].setdefault(task_id, (event, payload))
    if task_id in STATE["delivering"]:
        return
    STATE["delivering"].add(task_id)
    def deliver():
        try:
            while task_id in STATE["terminal_outbox"]:
                if not sio.connected:
                    sio.sleep(1)
                    continue
                try:
                    ev, body = STATE["terminal_outbox"][task_id]
                    ack = sio.call(ev, body, timeout=10)
                    if isinstance(ack, dict) and ack.get("received"):
                        terminal = STATE["terminal_outbox"].pop(task_id)
                        STATE["completed_terminals"][task_id] = terminal
                        STATE["in_flight"].discard(task_id)
                        while len(STATE["completed_terminals"]) > 200:
                            STATE["completed_terminals"].pop(next(iter(STATE["completed_terminals"])))
                        return
                except Exception:
                    pass
                sio.sleep(2)
        finally:
            STATE["delivering"].discard(task_id)
    sio.start_background_task(deliver)

def register():
    sio.emit("device:register", {
        "id": SERVICE_ID,
        "name": SERVICE_NAME,
        "platform": "custom-service",   # 自由字符串；勿含 desktop/browser/android/workshop
        "deviceType": "custom",         # 固定值
        "token": STATE["token"],
        "version": "1.0.0",
        "capabilities": [t["name"] for t in TOOLS],
        "toolDefs": TOOLS,
        "aiDescription": "用于查询和处理本项目业务能力",
        "catalogProtocolVersion": 2,
    })

@sio.event
def connect():                          # 每次(重)连接都要重新注册
    STATE["registered"] = False
    STATE["register_blocked"] = False
    register()
    def retry():                        # 收到确认前每 3 秒重发，防握手期丢包
        while sio.connected and not STATE["registered"] and not STATE["register_blocked"]:
            sio.sleep(3)
            if not STATE["registered"] and not STATE["register_blocked"]:
                register()
    sio.start_background_task(retry)

@sio.on("device:registered")
def on_registered(data):
    STATE["registered"] = True          # data["aiConfigId"] 为 null 时提示用户去绑定

@sio.on("device:register_rejected")
def on_rejected(data):
    reason = str((data or {}).get("reason") or "")
    if not any(word in reason.lower() for word in ("token", "auth", "logged in", "expired")):
        STATE["register_blocked"] = True
        print(f"device catalog/register rejected: {reason}")  # 非鉴权错误不要死循环
        return
    if STATE["recovering"]:
        return
    STATE["recovering"] = True
    def recover():                      # 重登录后 endpoint 可能变化，必须重建 socket
        try:
            login()
            if sio.connected:
                sio.disconnect()
            sio.connect(STATE["socket_url"])
        finally:
            STATE["recovering"] = False
    sio.start_background_task(recover)

# ── ⑤ MCP 转换层：串行执行 + taskId 去重 + 单一终态可靠投递 ────────────────
def execute_task(task):
    task_id, tool = task.get("taskId"), task.get("tool")
    try:
        allowed = task.get("allowedTools")
        if not isinstance(allowed, list) or tool not in allowed:
            raise PermissionError(f"tool not allowed: {tool}")
        handler = HANDLERS.get(tool)
        if handler is None:
            raise ValueError(f"unknown tool: {tool}")
        result, summary = handler(task.get("args") or {})
        queue_terminal("task:result", {"taskId": task_id, "deviceId": SERVICE_ID,
                                       "success": True, "tool": tool,
                                       "result": result, "summary": summary})
    except Exception as exc:
        queue_terminal("task:error", {"taskId": task_id, "deviceId": SERVICE_ID,
                                      "error": str(exc)})

def task_worker():
    while True:
        execute_task(TASK_QUEUE.get())

@sio.on("task:dispatch")
def on_task(task):
    task_id = str(task.get("taskId") or "")
    if not task_id:
        return
    if task_id in STATE["terminal_outbox"]:
        queue_terminal(*STATE["terminal_outbox"][task_id])
        return
    if task_id in STATE["completed_terminals"]:
        queue_terminal(*STATE["completed_terminals"][task_id])
        return
    if task_id in STATE["in_flight"]:
        return
    STATE["in_flight"].add(task_id)
    TASK_QUEUE.put({**task, "taskId": task_id})
    if not STATE["worker_started"]:
        STATE["worker_started"] = True
        sio.start_background_task(task_worker)

login()
sio.connect(STATE["socket_url"])
sio.wait()
```

---

## 3. 登录与连接（协议细节）

### 3.1 登录

```
POST {SERVER}/api/auth/login
Content-Type: application/json

{"account": "<账号>", "password": "<密码>"}
```

响应（节选）：

```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "bearer",
  "agent_socket_url": "http://your-server:3000",
  "user": {"id": 1, "account": "heysure"}
}
```

规则：

- `access_token` 放进 `device:register` 的 `token` 字段；也是所有辅助 REST
  接口（第 11 节）的 Bearer token。
- Socket.IO 连接地址**必须用 `agent_socket_url`**，不要写死端口（服务器可能
  经反代或 `AGENT_SOCKET_URL` 配置了不同的对外地址）。
- token 有效期由服务端决定。收到 `device:register_rejected` 且 reason 提示
  token 无效 → 重新登录 → 重新注册（模板 ③ 已实现）。
- 已持有 token 时可用 `GET /api/auth/agent-endpoint` 单独刷新 `agent_socket_url`。

### 3.2 Socket.IO 连接参数

| 参数 | 值 |
| --- | --- |
| URL | 登录响应的 `agent_socket_url` |
| path / 命名空间 | `/socket.io/` / 默认命名空间 `/`（都用默认值） |
| 协议版本 | Socket.IO v4（JS `socket.io-client` ≥ 4.x / `python-socketio` ≥ 5.x） |
| 传输 | polling → websocket 自动升级 |
| 单帧上限 | 20 MB（大图压缩或分片） |

---

## 4. 注册协议：`device:register`

连接（含每次重连）成功后立即发送；收到 `device:registered` 前每 3 秒重发。

```jsonc
{
  // 必填
  "id": "myproject-01",          // 逻辑 ID：稳定唯一。绑定/权限/任务队列按它落库
  "name": "我的项目",             // 展示名
  "token": "<access_token>",     // 用户 JWT（服务器校验后即时删除，不落库）
  "deviceType": "custom",        // 固定 "custom"；勿冒充内置类型
                                 // （desktop/browser/android/workshop）
  // 强烈建议
  "platform": "custom-service",  // 自由字符串；勿含 desktop/windows/browser/
                                 // android/workshop（旧版按关键词分类）
  "capabilities": ["order.query"],   // 工具名清单
  "toolDefs": [ /* 第 5 节 */ ],     // 工具自描述；vNext 客户端必须与 MCP capability 一一对应
  "aiDescription": "用于管理订单并查询履约状态", // 给 AI 的简短用途元数据，不是指令
  "catalogProtocolVersion": 2,      // 当前工具目录注册合同版本
  "version": "1.0.0",
  // 可选
  "catalogGeneration": 12,         // 仅在客户端能持久化单调代次时上报；否则省略
  "icon": "3",                   // "1"~"8" 预置编号 / "/device_png/N.webp" / 绝对 URL；
                                 // 不填走网页默认；改后重注册生效
  "lifecycle": "registered",
  "group": "",
  "os": {"platform": "linux", "arch": "x64", "hostname": "prod-01"}   // 仅展示
}
```

服务器回应（发给当前 socket）：

| 事件 | 载荷 | 含义 |
| --- | --- | --- |
| `device:registered` | `{"id", "aiConfigId", "boundAiConfigIds", "catalogGeneration", "catalogHash", "catalogProtocolVersion"}` | 成功。`aiConfigId` 是兼容主绑定，完整绑定见 `boundAiConfigIds`；目录代次与哈希以服务端回执为准 |
| `device:register_rejected` | `{"reason", "error_code"?}` | 被拒。目录/payload/persist 类错误通常有机器码；鉴权、归属等拒绝可能只有 `reason` |

注册成功后服务器：写入在线 presence 快照（工具目录以此做发现）→ 重放掉线期间
积压的任务 → 向属主网页推送最新列表。

约束：

- **服务不能自选 AI**，绑定只由人在网页作坊面板分配，注册时自动套用已持久化的绑定。
- 当前绑定合同为多对多：一台设备可绑定多个 AI，一个 AI 也可绑定多个 endpoint。端侧不得根据
  `aiConfigId` 自行缩减目录或拒绝其它合法绑定的任务。
- 重连用同一个 `id` 重新注册即可，绑定与权限自动恢复。
- 目录发生变化时，客户端自管的 `catalogGeneration` 必须前进；不能可靠维护单调代次就省略该
  字段，让服务端按规范化目录哈希幂等处理并分配。相同 hash 的重注册会直接返回当前代次。

---

## 5. MCP 工具自描述：`toolDefs`

每个元素描述一个 MCP 工具。固定 MCP 的定义由服务自报，服务器会把整代目录规范化、排序、
限额、计算 hash，并依据绑定和权限投影给模型；动态 MCP 则以服务器下发定义为权威。

当前服务端硬上限：一代最多 256 个 capability / definition，工具名最多 160 字符且不得含
空白或控制字符，单个工具描述最多 2,000 字符，单个 `input_schema` 的规范化 JSON 最多
64 KiB，整代规范化目录最多 512 KiB，`aiDescription` 最多 240 字符。重复名、孤立定义、
非对象 schema 或超限会拒绝整代；服务端当前只强制 `toolDefs ⊆ capabilities`，仍兼容缺少
definition 的 capability。描述可以为空，凭据形态或提示注入语句还可能被清空，不能依赖原文保留。

```jsonc
{
  "name": "order.query",               // 必填，与 capabilities 中的名字一致
  "description": "按订单号查询订单状态与金额。",  // vNext 客户端规范必填；现服务端兼容空值
  "input_schema": {                    // 必填，标准 JSON Schema（也接受 inputSchema）
    "type": "object",
    "properties": {
      "order_id": {"type": "string", "description": "订单号，如 SO-2026-0001"}
    },
    "required": ["order_id"]
  },
  "destructive": false                 // 可选：危险/不可逆操作标记（UI 提示用）
}
```

### 5.1 命名规范与保留字

- 第三方统一规范是 `<域>.<动作>`、全小写；当前固定目录校验器只强制名称不超过 160 字符且
  不含空白/控制字符，不能把宽松兼容当成新命名标准。
- **规范保留，禁止使用**：`browser_` / `card_`、`evolution.` / `librarian.`、
  `remote_control` / `remote_terminal`、点号远控别名以及 `rc:` / `rt:`。当前服务端实际会剥离
  非 Browser 的 `browser_` / `card_`、非 Workshop 的 `evolution.` 和精确的远控 transport 名；
  `librarian.`、`rc:`、`rt:` 尚未全部按前缀过滤，所以客户端仍必须主动避让。
- 只有下划线能力字 `remote_control` / `remote_terminal` 会解锁远控；
  `remote.control` / `remote.terminal` 即使从 MCP 目录中被剥离，也不会开启通道。
- 旧客户端只进 `capabilities` 不写 `toolDefs` 时，服务器可能给出宽松 schema 兼容；协议 v2
  **禁止依赖该兜底，必须始终写全 `toolDefs`。**

### 5.2 描述写法

`description` 是模型决定"何时调用、怎么传参"的唯一依据：一句话说清做什么 +
关键参数含义 + 明显限制（"仅支持 PNG"、"耗时约 10s"）。参数逐个写
`properties.*.description`，必填项进 `required`。

---

## 6. 服务器动态 MCP：`device:tool-config`

当前服务器只向 `deviceType=desktop|browser|android` 推送本通道。普通第三方服务应注册为
`custom` 并使用第 5 节的固定 `toolDefs`，不会收到动态目录；不要仅靠监听事件假装支持。

|  | 固定 MCP（第 5 节） | 服务器动态 MCP（本节） |
| --- | --- | --- |
| 定义权威 | 设备代码 / adapter | 服务器工作区（按用户 + 端型） |
| 修改入口 | 开发者改代码并发布 | 人在控制台修改，或经受治理的服务端工具修改 |
| 生命周期 | 随客户端版本持久存在 | 每次连接的内存快照；断线清除 |
| 生效方式 | 下一次完整注册 | 当前各端行为不一；目标是完整快照原子应用后重新注册 |

服务器实际 envelope：

```jsonc
{
  "version": 1,
  "deviceType": "desktop",
  "revision": "<规范化 tools 的哈希>",
  "tools": [{
    "name": "fs.read_better",
    "description": "...",
    "input_schema": { "type": "object", "properties": {} },
    "code_kind": "js",              // "program" | "js" | "runtime"
    "js": "return await cap.call('fs.read', args)",
    // program → "code": [{op:'call'|'set'|'return', ...}]
    // runtime → "runtime": "powershell"|"shell"|"python" + "source": "..."
    "permissions": ["filesystem.read"]
  }],
  "permissionPolicy": { "...": "..." }
}
```

下表是端侧**当前实际执行能力**，不是服务端保存层已经完全强制的规则：

| `deviceType` | `program` | `js` | `runtime` |
| --- | --- | --- | --- |
| `desktop`（Windows 主线） | 是 | 是 | `powershell` / `shell`；当前 Windows 不接 `python` |
| `browser` | 是 | 否 | 否 |
| `android` | 是 | 否 | 否 |
| `custom`（含当前 Linux / AI-FREE） | 当前不下发 | 当前不下发 | 当前不下发 |

当前保存层要求动态名称匹配小写点式 regex、描述非空、schema 为对象；`program` 为 1～32 步且
只允许 `call` / `set` / `return`，JS/source 最长 64K 字符，runtime 名可为
`python|powershell|shell`。它尚无整组工具数上限、跨工具环/深度预检，也尚未按具体客户端
profile 阻断 Browser JS 或 Windows Python；最终重注册仍受第 5 节目录总上限约束。

**[目标 vNext]** 处理顺序固定为：校验 envelope 版本与端型 → 校验整组工具、保留名、大小、
步骤和端型支持 → 原子替换服务器快照 → 合并有效目录 → 重新 `device:register`。
`revision` 只覆盖 `tools`，相同 revision 时工具应用应幂等，但 `permissionPolicy` 仍须独立处理。
执行器还应限制嵌套深度并拒绝调用环。

`js` 和 `runtime` 都是服务器下发后以设备进程权限执行的**受信代码**。当前 Windows 的 JS
执行器不是安全沙箱，文档、UI 和日志都不得声称它能隔离恶意代码。当前
`permissionPolicy` 主要约束 Windows runtime 权限标签，尚未统一覆盖 program/JS 内部调用；
即使收敛后也不能替代 OS 级沙箱。调用协议与固定工具相同（第 8 节）。

如果用户 / AI 在控制台创建了动态工具而你的服务"调不到"：这是预期行为，
`custom` profile 当前不实现该通道；应改用固定 MCP 或先完成服务端与端侧的版本化 profile 扩展。

---

## 7. 绑定与授权：两道闸门

服务在线 ≠ AI 可调用。新设备默认没有 AI 绑定；第一次以非空 MCP 目录注册时，服务端先建立
`(用户, deviceId, NULL)` 默认全量 scope，之后新绑定的成员继承该默认值：

```
服务在线（presence）
   └─► 闸门 1：服务 ↔ AI 绑定       PUT /api/devices/{id}/member-bindings/{aiConfigId}
          └─► 闸门 2：工具授权范围   PUT /api/devices/{id}/mcp-scope
                 └─► 工具出现在 AI 的系统提示词中，可被调用
```

- **闸门 1**：新增/移除单个成员使用
  `PUT /api/devices/{deviceId}/member-bindings/{aiConfigId}`，body `{"bound": true|false}`；
  旧 `POST /api/devices/bind` 仍兼容，但会把整个集合替换成零或一个成员。绑定按
  `(用户, deviceId, AI)` 持久化，重连自动恢复，也可在设备离线时保留。
- **闸门 2**：`PUT /api/devices/{deviceId}/mcp-scope`，body
  `{"aiConfigId": 3, "tools": ["order.query"]}`。GET/PUT 都要求设备在线；显式 AI 必须已绑定，
  否则返回 409，PUT 保存时会先与当前在线 capability 取交集。旧 scope 若表达“上一代全选”会
  自动纳入新 capability；人工保存的部分集合或显式空集绝不静默扩权。
- 同一 AI 的多个已绑定端必须避免公开同名工具；当前 resolver 没有稳定 tie-break，直到服务端
  增加显式 endpoint 路由前，唯一命名才是确定性保证。
- AI 成员的其它工具选择、消息级选择和角色策略还会继续收窄最终可调用集合；端侧 scope
  不是绕过服务端治理的总开关。

**实施提示**：两道闸门在网页控制台作坊面板都有 UI，正常应由人操作。你完成部署后，
在交接说明中明确提示用户："去作坊面板给本服务分配 AI，并在 MCP 权限中勾选工具"。
仅当用户明确授权时才代为调用上述 REST。

---

## 8. 任务协议：接收调用、回报结果

### 8.1 服务器 → 服务：`task:dispatch`

```jsonc
{
  "taskId": "atask_9f2c01ab34de",   // 回包必须原样带回
  "userId": 1,
  "aiConfigId": 3,                  // 发起调用的 AI
  "sessionId": "sess_...",          // 关联聊天会话（可能为空）
  "instruction": "Run endpoint MCP tool order.query",
  "tool": "order.query",
  "args": {"order_id": "SO-2026-0001"},   // 按你的 input_schema 传入
  "allowedTools": ["order.query"]
}
```

### 8.2 服务 → 服务器：三种回包

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `task:result` | `{"taskId", "deviceId", "success", "tool", "result", "summary"}` | `result` 任意可 JSON 序列化值；`summary` 一句话人话总结（展示给用户/模型） |
| `task:error` | `{"taskId", "deviceId", "error"}` | 失败终态（等价 success=false） |
| `task:progress` | `{"taskId", "deviceId", "message", "progress"?}` | 可选，`progress` 为数值；长任务中途进度实时推送到网页 |

### 8.3 队列与超时（硬规则）

- **每个任务只能有一个逻辑终态，但网络至少投递一次**。缓存相同 terminal payload 并重试
  `task:result` / `task:error`，直到收到 Socket.IO ACK
  `{"received": true, "taskId": "...", "duplicate": false|true}`；服务端按 `taskId` 幂等去重。
  收到不认识的 `tool`、`allowedTools` 缺失/非法、或 `tool` 不在该列表中，都回
  `task:error`，不要沉默。
- 同一端点必须串行执行 dispatch，并以 `taskId` 维护 in-flight + completed terminal 缓存；重复
  dispatch 只能重投原终态，禁止再次执行可能有副作用的 handler。
- **每个服务一条串行队列**：前一个任务出终态（result/error/超时）才派发下一个。
  不回包会卡死队列，直到 deadline/owner lease 到期并由周期 sweeper 回收。当前 lease 默认
  180 秒、sweeper 约每 60 秒运行；300 秒只是无 owner 遗留记录的兜底，不是统一“最长时间”。
- 调用默认等 **120 秒**；模型可传 `args.timeout_seconds`（上限 300）延长。
  可能超 120 秒的工具，要在描述里写明"请传 timeout_seconds"。
- 掉线重连后服务器按序重放排队任务；等待过久的会被主动作废。

### 8.4 返回图片的约定

只有被服务器识别为 canonical screenshot 的工具名（如 `screen.capture` /
`screen.capture_region` / `vision.capture` / `vision.capture_mouse`）才进入图片管线；单独在任意
result 中写 `send_to_user: true` 不会触发。`dataUrl` 支持 PNG/JPEG/JPG/WebP，解码后文件上限
30 MiB；传输仍须服从第 3.2 节 Socket.IO 单帧限制。

---

## 9. 远程连接：画面远程 + 命令行远程（可选，默认不实施）

> 仅当项目运行在"有屏幕或能开 shell 的主机"且用户明确要求时才实施本节。
> 纯业务型服务直接跳过。这不是 AI 调工具，而是**真人操作者**在网页控制台实时
> 驱动服务所在主机的独立数据面。

| | **画面远程**（screen） | **命令行远程**（terminal） |
| --- | --- | --- |
| 用途 | 实时屏幕镜像 + 键鼠注入 | 交互式 shell（ANSI / TUI / Ctrl-C / resize） |
| 能力字（`capabilities`） | `remote_control` | `remote_terminal` |
| 事件前缀 | `rc:*` | `rt:*` |
| 传输 | **WebRTC P2P**（仅 SDP/ICE 信令过服务器） | **Socket.IO relay**（字节流经服务器转发） |
| 需要 TURN | 需要（公网跨 NAT，见 9.4） | 不需要 |
| 官方参考实现 | 服务端 `connector_runtime/dispatch/remote_control.py`；Windows `src-tauri/src/rc.rs` + `src/remote-control.ts` | 服务端 `connector_runtime/dispatch/remote_terminal.py`；Windows `src-tauri/src/pty.rs` + `src/remote-terminal.ts` |

在 `capabilities` 里声明哪个下划线能力字就解锁哪条通道；都不声明就都不开。这两个
能力字是**传输层保留字，不是 MCP 工具**（见 5.1）。点号别名不会解锁通道。

`remote_control` 当前是 v1 兼容能力字，实际画面范围由端型 profile 决定，控制端不得把
“支持画面远控”自动解释为“可控制整台桌面”：

| 端点 | 画面 surface | 输入范围 |
| --- | --- | --- |
| Windows Tauri | `desktop`（主屏） | 系统级鼠标、键盘、文本 |
| Android App | `android`（手机屏幕） | 无障碍手势与文本输入；受系统授权状态限制 |
| Browser / Browser-win | `browser-tab`（活动标签页） | CDP/DOM 或 Windows 原生桥支持的页面输入 |
| AI-FREE | `managed-browser`（托管浏览器） | 仅该工作台托管的浏览器会话 |

后续扩展 surface、输入类型或会话上限时必须升级版本化描述合同，不能继续只靠同一个布尔能力字
猜测。v1 的 `qualityPreset` 是请求值；端点只能提供近似档位时必须保持连接可用，并以实际
`rc:ready.width/height` 为准，不能虚报分辨率。

### 9.1 会话所有权闸门（两通道通用）

开会话时服务器统一校验：① 控制端（网页）用同一套用户 JWT（放 `rc:start` /
`rt:open` 的 `token` 字段）；② 目标是该用户名下的在线服务；③ 该服务声明了对应
能力字。不满足则回 `rc:error` / `rt:error`（`code`：`unauthorized` / `offline` /
`forbidden` / `unsupported`）。会话按 `sessionId` 存服务器内存，任一方断线即清理。

**[目标 vNext]** 同一端点同一时刻只允许一个画面远控会话，第二个请求返回 `busy`；命令行
远程可多会话但必须有明确上限，超限返回 `too_many`。当前服务端未实施每设备上限：Windows / AI-FREE
会替换旧画面，Android / Browser 允许多画面，各 terminal 也尚无统一上限。

### 9.2 命令行远程协议：`rt:*`

低带宽字节流经服务器 relay。`data` 一律是 **PTY 原始字节的 base64**（让 ANSI
控制序列原样穿过 JSON，服务器只转发不解码）。

```
控制端（web） → 服务器
    rt:open    {deviceId, token, shell?, cols?, rows?, cwd?}

服务器 → 服务
    rt:open    {sessionId, shell, cols, rows, cwd}   // 不转发 token/deviceId

控制端（web） → 服务器 → 服务
    rt:input   {sessionId, data}          写入 PTY（base64）
    rt:resize  {sessionId, cols, rows}
    rt:close   {sessionId}

服务 → 服务器 → 控制端
    rt:data    {sessionId, data}          PTY 输出（base64）
    rt:exit    {sessionId, code}          shell 退出（code 可为 null）
    rt:error   {sessionId, code, message}

服务器 → 控制端
    rt:opened  {sessionId, deviceId, shell}   只表示服务端受理，不保证 PTY 已就绪
    rt:error   {code, message}
```

服务侧实现要点：收到 `rt:open` 按 `shell`/`cols`/`rows`/`cwd` 起 PTY（Windows
ConPTY，Linux/macOS openpty）→ 持续读输出发 `rt:data`，退出发 `rt:exit` →
`rt:input` 解 base64 写入，`rt:resize` 调行列，`rt:close` 杀进程 → 支持多会话
（按 `sessionId` 路由）→ socket 断线时杀掉全部 PTY。
**安全**：这是该用户对主机的完整 shell（服务器已做属主校验），PTY 应以不超出
预期的权限与工作目录启动。

### 9.3 画面远程协议：`rc:*`

高带宽视频走 WebRTC 点对点，仅信令过服务器：

```
控制端（web） → 服务器
    rc:start   {deviceId, token, qualityPreset?}   smooth | balanced | clear

服务器 → 服务
    rc:start   {sessionId, qualityPreset}          // 不转发 token/deviceId

控制端（web） → 服务器 → 服务
    rc:answer  {sessionId, sdp}
    rc:ice     {sessionId, candidate}
    rc:stop    {sessionId}

服务 → 服务器 → 控制端
    rc:offer   {sessionId, sdp}           服务侧发起 offer
    rc:ice     {sessionId, candidate}
    rc:ready   {sessionId, width, height, rotation}
    rc:error / rc:stopped

服务器 → 控制端
    rc:started {sessionId, deviceId}       只表示服务端受理；首帧/输入仍等 rc:ready
    rc:error   {code, message}
```

服务侧负责：屏幕采集成 WebRTC 视频轨 + `control` DataChannel 接收归一化到
`[0,1]` 的鼠标/键盘事件并注入本机 OS。实现成本远高于命令行远程，
**多数第三方服务只接命令行远程即可**。

下表是 **[目标 vNext]** 的统一 `control` DataChannel 输入合同；当前 v1 各端消息形状仍有差异，
不能假定已经线上协商完成。`x/y/x2/y2` 都是相对当前
`rc:ready.width/height` 的 `[0,1]` 坐标；端点必须 clamp，禁止把越界值直接交给 OS：

| 消息 | 必填/关键字段 | 语义 |
| --- | --- | --- |
| `{"type":"move"}` | `x`, `y` | 移动指针；允许合并或丢弃过密的中间帧 |
| `{"type":"down"}` / `{"type":"up"}` | `x`, `y`, `button: left|right|middle` | 指针按下/释放；会话结束时必须释放仍按下的按钮 |
| `{"type":"scroll"}` | `dx`, `dy`；可带 `x`, `y` | 与浏览器 WheelEvent 同方向的滚动增量 |
| `{"type":"key"}` | `key`, `action: down|up`，可带 `ctrl/alt/shift/meta` | 键盘按下/释放；未知键不得退化成命令或脚本 |
| `{"type":"text"}` | `text` | IME/Unicode 文本输入；单帧最多 64 KiB |
| `tap` / `long_press` / `swipe` | 归一化坐标、`durationMs` | Android surface 的兼容手势；其它 surface 可不支持 |
| `{"kind":"quality"}` | `preset: smooth|balanced|clear` | 会话内调档请求；不支持时保持当前档，不得断开 |
| `{"kind":"browser",...}` | 第 9.3 表面声明允许的导航/标签动作 | 仅 `browser-tab` / `managed-browser`，其它 surface 必须忽略 |

端点必须限制输入帧大小/频率、串行处理同一会话输入、忽略并诊断畸形或未知消息；诊断不得
记录文本/按键原文。DataChannel 关闭、socket 断开或 `rc:stop` 时必须释放所有按下状态。
`rc:ready` 只能在采集链路已建立后发送，并返回实际宽高/rotation；输入权限暂不可用时，
端点不得伪装成整套已就绪。v2 将把 `surface`、`inputKinds`、`ready/reason`、
`qualityPresets` 和 `maxSessions` 放入版本化注册描述符；在服务端与 Web 完成协商前仍以本节
v1 能力字 + 端型矩阵为准，禁止客户端自行添加一套不兼容事件。

### 9.4 TURN

命令行远程走 relay，公网直接可用。画面远程是 P2P：纯 STUN 在公网跨 NAT 常失败，
需部署 TURN 中继（房主在网页管理控制台「远程控制（STUN/TURN）」卡片填凭据）。
服务侧从登录响应或 `GET /api/rtc/ice-servers` 取 ICE 配置，**不要写死**。

### 9.5 实施清单

- 只要命令行远程：`capabilities` 加 `remote_terminal`，实现 9.2 + 本机 PTY。
- 要画面远程：`capabilities` 加 `remote_control`，实现 9.3 + 按 9.4 取 ICE 配置。
- 两条通道与第 8 节任务循环互不干扰：不进任务队列、不入库、不走聊天管线。

---

## 10. 实施模板（Node.js）

结构与第 2 节 Python 模板一致（登录 → 连接注册 → HANDLERS 路由）：

```js
// npm i socket.io-client axios
const { io } = require('socket.io-client')
const axios = require('axios')

const SERVER = process.env.HEYSURE_SERVER || 'http://49.234.181.190:58150'
const SERVICE_ID = process.env.HEYSURE_SERVICE_ID || 'myproject-01'
const TERMINAL_OUTBOX = new Map()
const COMPLETED_TERMINALS = new Map()
const IN_FLIGHT = new Set()
let taskChain = Promise.resolve()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const TOOLS = [{
  name: 'report.daily_summary',
  description: '汇总昨日业务数据（订单量、销售额、新增用户）',
  input_schema: { type: 'object', properties: {}, required: [] },
}]
const HANDLERS = {
  'report.daily_summary': async () => {
    // TODO: 接本项目的真实数据
    const result = { orders: 42, revenue: 8360, new_users: 7 }
    return [result, '昨日 42 单，销售额 8360 元，新增用户 7 人']
  },
}

async function main() {
  const { data: login } = await axios.post(`${SERVER}/api/auth/login`, {
    account: process.env.HEYSURE_ACCOUNT, password: process.env.HEYSURE_PASSWORD,
  })
  const socket = io(login.agent_socket_url || SERVER, {
    reconnectionDelay: 2000, reconnectionAttempts: Infinity,
  })
  let registered = false
  let retired = false
  let retryTimer = null
  const stopRetry = () => { if (retryTimer) clearInterval(retryTimer); retryTimer = null }
  const delivering = new Set()
  const deliverTerminal = async taskId => {
    if (delivering.has(taskId)) return
    delivering.add(taskId)
    try {
      while (!retired && TERMINAL_OUTBOX.has(taskId)) {
        if (!socket.connected) { await sleep(1000); continue }
        const terminal = TERMINAL_OUTBOX.get(taskId)
        const ack = await new Promise(resolve => {
          socket.timeout(10000).emit(terminal.event, terminal.payload,
            (err, value) => resolve(err ? null : value))
        })
        if (ack?.received) {
          TERMINAL_OUTBOX.delete(taskId)
          COMPLETED_TERMINALS.set(taskId, terminal)
          IN_FLIGHT.delete(taskId)
          while (COMPLETED_TERMINALS.size > 200) {
            COMPLETED_TERMINALS.delete(COMPLETED_TERMINALS.keys().next().value)
          }
        } else await sleep(2000)
      }
    } finally {
      delivering.delete(taskId)
    }
  }
  const queueTerminal = (event, payload) => {
    if (!TERMINAL_OUTBOX.has(payload.taskId)) TERMINAL_OUTBOX.set(payload.taskId, { event, payload })
    void deliverTerminal(payload.taskId)
  }

  const register = () => socket.emit('device:register', {
    id: SERVICE_ID, name: process.env.HEYSURE_SERVICE_NAME || '我的项目',
    platform: 'custom-service', deviceType: 'custom',
    token: login.access_token, version: '1.0.0',
    capabilities: TOOLS.map(t => t.name), toolDefs: TOOLS,
    aiDescription: '用于查询和处理本项目业务能力',
    catalogProtocolVersion: 2,
  })

  socket.on('connect', () => {
    registered = false
    register()
    stopRetry()
    retryTimer = setInterval(() => { if (socket.connected && !registered) register() }, 3000)
    for (const taskId of TERMINAL_OUTBOX.keys()) void deliverTerminal(taskId)
  })
  socket.on('disconnect', stopRetry)
  socket.on('device:registered', d => {
    registered = true
    stopRetry()
    console.log('registered, ai =', d.aiConfigId, 'all =', d.boundAiConfigIds || [])
  })
  socket.on('device:register_rejected', d => {
    stopRetry()
    console.error('rejected:', d.reason, d.error_code || '')
    if (!/token|auth|logged in|expired/i.test(String(d.reason || ''))) return
    // 重登录响应可能给出新的 agent_socket_url；销毁旧 socket 后完整重建。
    retired = true
    socket.removeAllListeners()
    socket.disconnect()
    setTimeout(() => main().catch(console.error), 2000)
  })

  socket.on('task:dispatch', task => {
    const taskId = String(task.taskId || '')
    if (!taskId) return
    if (TERMINAL_OUTBOX.has(taskId)) return void deliverTerminal(taskId)
    if (COMPLETED_TERMINALS.has(taskId)) {
      TERMINAL_OUTBOX.set(taskId, COMPLETED_TERMINALS.get(taskId))
      return void deliverTerminal(taskId)
    }
    if (IN_FLIGHT.has(taskId)) return
    IN_FLIGHT.add(taskId)
    taskChain = taskChain.then(async () => {
      try {
        if (!Array.isArray(task.allowedTools) || !task.allowedTools.includes(task.tool)) {
          throw new Error(`tool not allowed: ${task.tool}`)
        }
        const handler = HANDLERS[task.tool]
        if (!handler) throw new Error(`unknown tool: ${task.tool}`)
        const [result, summary] = await handler(task.args || {})
        queueTerminal('task:result', {
          taskId, deviceId: SERVICE_ID,
          success: true, tool: task.tool, result, summary,
        })
      } catch (err) {
        queueTerminal('task:error', { taskId, deviceId: SERVICE_ID, error: String(err) })
      }
    })
  })
}
main().catch(console.error)
```

---

## 11. 辅助 REST 接口（Bearer `access_token`）

| 接口 | 用途 |
| --- | --- |
| `GET /api/devices/connected` | 当前账号的服务快照（在线 + 离线遗留），验证注册 |
| `PUT /api/devices/{id}/member-bindings/{aiConfigId}` | 增删一个 AI 绑定（`{"bound": true|false}`），保留其它绑定 |
| `POST /api/devices/bind` | 旧兼容入口；把绑定集合替换成零或一个 AI |
| `GET /api/devices/{id}/mcp-scope?ai_config_id=N` | 设备须在线；查看指定已绑定 AI 的工具清单与授权子集，否则 404/409 |
| `PUT /api/devices/{id}/mcp-scope` | 设备须在线且显式 AI 已绑定；保存时只保留当前在线 capability 交集 |
| `DELETE /api/devices/{id}` | 遗忘一个**离线**服务（删绑定 + presence + 授权） |
| `GET /api/auth/agent-endpoint` | 用现有 token 重新获取 `agent_socket_url` |

---

## 12. 验收与排查

### 12.1 验收步骤（AI 实施完成后逐条执行）

1. 启动接入模块，日志出现"已注册"（收到 `device:registered`）。
2. `curl -H "Authorization: Bearer <token>" {SERVER}/api/devices/connected`
   → 列表中出现你的 `SERVICE_ID`，且工具清单完整。
3. 交接给用户：提示去网页控制台作坊面板 ① 给本服务分配 AI，② 在 MCP 权限中
   勾选工具并保存。
4. 用户对绑定的 AI 发一句会触发工具的话（如"查一下订单 SO-2026-0001"），
   确认 `task:dispatch` 到达、回包成功、AI 回复中含结果。
5. 断网 / 重启服务进程各一次，确认自动重连重注册，绑定与权限无需重配。

### 12.2 排查表

| 症状 | 检查 |
| --- | --- |
| 连上就断 / `device:register_rejected` | token 过期 → 重新登录；reason 字段有具体原因 |
| 注册成功但网页看不到 | 登录账号是否与网页账号相同；`GET /api/devices/connected` 里有没有 |
| 控制台显示"设备端/未知"而非"自定义设备" | 注册包缺 `deviceType: "custom"`；或服务端版本过旧 |
| AI 提示词里看不到工具 | 两道闸门：是否绑定了 AI？MCP 权限是否勾选并保存？ |
| AI 能看到工具但报"no agent connected" | 服务是否在线；`capabilities` 是否含该工具名 |
| 任务派发后一直转圈 | 该 taskId 是否恰好回了一次 `task:result` / `task:error` |
| 后续任务全部排队 | 前一个任务没回终态，卡住串行队列；回包或等超时清扫 |
| 大结果发不出去 | Socket.IO 单帧上限；图片还受解码后 30 MiB 限制，压缩或改回摘要 + 服务器路径 |
| 工具改名/增删后权限异常 | 检查该 AI 的独立 scope；全选状态会自动纳入新工具，显式子集/空集不会被静默放宽 |
| 控制台建了动态 MCP 工具但 `custom` 服务调不到 | 当前 profile 不下发动态目录（第 6 节），应改固定 MCP 或扩展双方协议 |
| 命令行远程报"不支持" | `capabilities` 是否声明 `remote_terminal`（第 9 节） |
| 画面远程公网连上就断 | STUN 打洞失败，需 TURN（9.4）；命令行远程无此问题 |
| 命令行远程有回显但输入无效 | `rt:input` 的 `data` 是否 base64 |

---

## 13. 服务器行为契约

服务器对遵循本协议的服务保证：

1. 注册包的 `name` / `deviceType` / `capabilities` / `toolDefs` 会经过端型过滤、规范化、
   限额和整代原子校验后进入 presence；固定工具以有效自报定义为准；
2. 自建服务与官方端走**同一条**调度通道（串行队列、超时、重放、结果入库、
   网页实时推送），无功能阉割；
3. 同一 AI 绑定的多个执行端若申报同名工具，当前没有稳定优先级；协议使用方必须保证有效
   scope 内名称唯一，或等待版本化 endpoint 路由合同；
4. 绑定按 `(用户, deviceId, AI)`、授权按 `(用户, deviceId, AI)` 持久化，跨重连、跨服务器
   重启保持；
5. 服务器动态 MCP 定义（第 6 节）由服务器工作区写入；`custom` 端不实现该通道不影响固定
   `toolDefs` 调度；
6. 远程连接两通道（第 9 节）开会话时统一做所有权校验，与任务循环互不干扰。

协议演进以服务端实现为最终权威：`deploy/server/main/connector_runtime/dispatch/device_dispatch.py`
（任务分发）、`remote_control.py`（`rc:*`）、`remote_terminal.py`（`rt:*`）。
