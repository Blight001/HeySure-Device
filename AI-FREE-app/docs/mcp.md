# AI-FREE MCP 工具清单

更新时间：2026-08-10

本文档记录当前软件实际向 AI 提供的 MCP 工具。常规浏览器对话提供 9 个工具；只有最近用户消息明确涉及环境、指纹、代理、时区等配置时，才额外注入体积较大的 `browser_environment` schema，避免每轮重复传输。

## 总览

| 工具组 | 数量 | 可用条件 | 代码真源 |
| --- | ---: | --- | --- |
| 外部软件栏目 | 1 | 软件运行期间始终可用 | [`ai-browser-window-tools.js`](../src/app/main/services/ai-browser-window-tools.js) |
| 浏览器高级环境 | 1 | 用户消息命中环境/指纹/代理等配置意图 | [`ai-browser-window-tools.js`](../src/app/main/services/ai-browser-window-tools.js) |
| AI 工作区命令 | 1 | 软件运行期间始终可用 | [`ai-sandbox-file-tools.js`](../src/app/main/services/ai-sandbox-file-tools.js) |
| 浏览器自动化 | 7 | 至少有一个已完成 Runtime Bridge 握手的内置 Chromium | [`native-browser-tool-definitions.js`](../src/app/main/services/native-browser-tool-definitions.js) |

AI-FREE 本地 AI 对话使用下表中的“内部名称”。连接 HeySure 后，设备向服务器注册时会统一添加 `aifree.` 前缀。

| 内部名称 | HeySure 注册名称 | 用途 |
| --- | --- | --- |
| `windows_tab` | `aifree.windows+tab` | 查询、显示、新建、编辑和关闭外部软件栏目 |
| `browser_environment` | `aifree.browser+environment` | 按需读取或增量修改栏目的浏览器环境与指纹 |
| `run_command` | `aifree.run+command` | 在 AI-Workspace 工作目录中执行有界命令行 |
| `manage_card` | `aifree.manage+card` | 管理和运行浏览器自动化卡片 |
| `browser_file` | `aifree.browser+file` | 下载文件、上传本地文件，或保存当前页面 Cookie/Storage |
| `browser_tab` | `aifree.browser+tab` | 查询、切换、导航、刷新标签页和聚焦浏览器 |
| `browser_observe` | `aifree.browser+observe` | 获取页面中可交互或可见的元素 |
| `browser_screenshot` | `aifree.browser+screenshot` | 截取页面可视区或指定坐标区域 |
| `browser_action` | `aifree.browser+action` | 点击、输入、滚动和发送按键 |
| `browser_wait` | `aifree.browser+wait` | 等待元素出现或等待指定时间 |

## 外部软件栏目工具

`windows_tab` 不依赖浏览器连接，用于控制 AI-FREE 外部软件栏目的显示与记录。

### `windows_tab`

| `action` | 作用 | 主要参数 |
| --- | --- | --- |
| `list` | 列出全部栏目记录，包括当前未显示的历史栏目 | 无 |
| `open` | 显示、恢复或聚焦已有栏目 | `history_id` 或 `name` |
| `create` | 创建并显示新栏目 | 可选 `name`、`url` |
| `edit` | 编辑栏目名称 | `history_id` 或 `name`；提供 `new_name` |
| `close` | 关闭栏目显示但保留历史记录 | `history_id` 或 `name` |

工具整体标记为破坏性，因为 `create`、`edit` 和 `close` 会改变本地状态；`list` 为只读操作，`open` 只会打开或切换窗口。

### `browser_environment`

`browser_environment` 与常驻的 `windows_tab` 分离，避免普通对话携带整份高级环境 schema。它支持：

- `action=get`：传 `history_id` 或唯一 `name`，返回脱敏后的环境配置。
- `action=update`：传 `history_id` 或唯一 `name` 与 `settings`，按增量语义修改。
- 已打开栏目默认重启 Chromium 立即应用；传 `restart:false` 可只保存。

#### 环境配置

`settings` 使用增量更新语义：只修改本次传入的字段，其他环境配置保持不变。

支持的配置包括：

- 系统和内核：`os`、`browserVersion`、`kernelVersion`。
- 代理：`proxy`，包含模式、协议、主机、端口、用户名、密码和代理 API 地址。
- 页面与身份：`homepage`、`ua`、`secChUa`、`language`、`timezone`、`webrtc`、`geolocation`。
- 设备指纹：`resolution`、`fonts`、`canvas`、`webglImage`、`webglMetadata`、`webgpu`、`audioContext`、`clientRects`、`speechVoices`。
- 硬件与安全：`cpu`、`memory`、`deviceName`、`macAddress`、`doNotTrack`、`sslEnabled`、`portScanProtection`、`hardwareAcceleration`、`launchArgs`。

读取操作返回脱敏配置，其中 Cookie 不返回，代理用户名和密码被替换为 `[REDACTED]`，代理 API 地址和启动参数只标记为已配置。

Cookie 属于登录会话数据，不属于 `browser_environment.settings` 的可编辑字段；应使用 `browser_file` 的 `save_session` 操作在软件本机采集和保存。

## AI 工作区命令工具

### `run_command`

- 作用：以 `AI-Workspace` 为工作目录执行命令行，可创建、读取、转换和整理其中的文件。
- 参数：必填 `command`；可选 `shell`、`directory` 和 `timeout_ms`。
- `shell`：可用值为 `default`、`cmd`、`powershell`；默认使用当前平台 shell。
- `directory`：只接受 `AI-Workspace` 内的相对目录，拒绝 `..` 或绝对路径逃逸。
- 限制：默认超时 30 秒，最长 120 秒；标准输出和错误输出各最多返回 64 KiB，超出部分标记为截断。
- 隔离说明：进程使用精简环境变量，并把 HOME/USERPROFILE 指向 `AI-Workspace`；这是工作目录隔离，不是虚拟机或 Windows AppContainer 级系统隔离。

## 浏览器自动化工具

以下 7 个工具由受认证的 Chromium Runtime Bridge 提供。没有浏览器 MCP 连接时，它们不会出现在 AI 或 HeySure 的可用工具目录中。

### `manage_card`

- 作用：查询规则，列出、读取、新建、修改、删除和运行自动化卡片，也可增删、移动或修改卡片步骤。
- `action`：必填，可用值为 `rules`、`list`、`get`、`write`、`patch_step`、`insert_step`、`delete_step`、`move_step`、`delete`、`run`。
- 常用定位参数：`id`、`card_name`。
- 编辑参数：`cardData`、`step_index`、`to_step_index`、`insert_after`、`stepData`、`stepPatch`、`replace`。
- 运行参数：`inputs`、`account`、`password`、`email`、`start_step`、`timeout_seconds`、`tab_id`。
- 注意：不同 `action` 使用不同参数；`write`、步骤编辑和 `delete` 会修改本地卡片数据。
- 脚本限制：MCP 不公开 `external_script`，也不允许 `condition_mode=js`；写入、局部编辑和运行历史卡片时都会拒绝任意页面脚本。
- 失败语义：原生步骤返回 `success=false`/`ok=false` 时卡片立即失败并停止；需要把业务校验作为断言时，在 `condition` 步骤设置 `fail_on_false=true`。
- 流程终点：存在 `flow` 时严格按连线执行，没有出边的节点就是终点，不会继续落入 `steps` 数组中的后续步骤。
- 通用 MCP 节点：卡片步骤可使用 `{ "type": "mcp", "tool": "已有工具名", "arguments": {...} }`，直接复用运行时当前工具目录；`arguments` 内的字符串支持运行输入变量替换。
- 路由与安全：浏览器 MCP 默认使用工作台选择的窗口，也可在 `arguments.change_browser` 指定其它在线连接。为防止无限递归，卡片内禁止调用 `manage_card`。

### `browser_file`

- 作用：`download` 下载 HTTP/HTTPS 文件；`upload` 把 AI 工作区中的本地文件上传到当前页面；`save_session` 保存当前标签页 Cookie、`localStorage` 和 `sessionStorage`；`info` 返回 AI 工作区路径。
- 默认目录：`download` 写入安装目录下的 `AI-Workspace` 根目录；`save_session` 默认写入 `AI-Workspace/sessions`。
- 子目录：`directory` 只接受 AI 工作区内相对路径，例如 `downloads/models`；拒绝绝对路径、`..` 逃逸和指向工作区外的链接目录。
- 下载参数：`url`、`filename`、`media_type`、`transport`、`use_cookies`、`overwrite`、`timeout_ms`、`max_bytes`、`tab_id`。媒体下载应将 `browser_observe` 返回的 `category` 传给 `media_type`；`transport` 可取 `auto`、`browser`、`software`。
- 上传参数：本机调用使用 `path` 或 `paths` 指定 AI 工作区文件；HeySure 远程调用还可使用当前数字成员服务器工作区的 `file_ref` 或 `file_refs`。AI-FREE 会通过 HeySure 创建默认 5 分钟临时链接，下载并校验后物化到本机 `AI-Workspace/Incoming/<task_id>/`。两类参数不能混用。使用 `selector` 或 `ref` 定位页面文件输入控件；多文件可设置 `mode=open-multiple`。
- 上传目标：`action=upload` 把工作区文件放入当前网页文件控件；`action=upload_to_server` 直接把 `path` 指定的 AI 工作区文件上传到 HeySure 成员工作区并返回 `file_ref`，不经过网页。兼容旧调用：`action=download`、`url=file:///...` 且 `save_to_server=true` 时按 `upload_to_server` 处理。
- 会话参数：`filename`、`directory`、`overwrite`、`tab_id`。保存结果只返回路径和 Cookie 数量，不把 Cookie 原文放入聊天结果。
- Cookie 规则：`use_cookies` 默认开启，但只发送与目标 URL 域名、路径、Secure 属性和有效期匹配的 Cookie；重定向后会重新匹配，不向其它域泄漏。
- 网络边界：禁止 localhost、`.local`、IPv4/IPv6 私网、链路本地、组播和保留地址。每次重定向都重新解析，并将实际连接固定到已审核 IP，防止 DNS 重绑定。
- 写入规则：先写同目录随机 `.part` 文件，再原子提交；默认不覆盖同名文件。默认大小上限 250 MiB、硬上限 1 GiB。

### `browser_tab`

- 作用：通过当前受管 Chromium Profile 管理页面导航与焦点。
- `action`：必填，可用值为 `list`、`switch`、`replace`、`navigate`、`reload`。
- `list` 每次调用都从 Chromium TabStrip 读取全部标签页与当前活动页，不使用窗口首次打开时缓存的网址。
- `replace` 原生覆盖当前页；`navigate` 原生打开新标签、立即激活该标签并把当前受管浏览器打开到前台；`switch` 传入 `url`、`id` 或 `index` 时切换 Chromium 内部标签页，不传目标时仅聚焦当前受管浏览器。

### `browser_observe`

- 作用：读取当前页面中可见的交互元素、文本、媒体和框架信息，为后续操作生成元素引用。
- 数量参数：`limit`、`max_items`。
- 筛选参数：`filter`、`tag`、`tags`、`keyword`、`query`、`text_filter`。
- 框架参数：`frame`、`frame_path`。
- 文本与标记参数：`include_text`、`text_limit`（默认 120，范围 20–500）、`mark`、`highlight_duration_ms`。超长文本会截断并返回 `textTruncated=true`。
- 顶层可点击筛选：交互元素必须在当前视口的至少一个候选点通过 Chromium 命中测试；被遮罩完全覆盖、`pointer-events:none`或禁用的元素不返回。按钮内部的 `span/svg/path` 会归并到最近的按钮或链接。
- 控件语义：保留 `kind=interactive` 的兼容分类，同时返回 `role`、`controlType`、`editable`、`multiline`、`label`、`readOnly`、`required` 以及选中/展开/按下状态。可区分文本、密码、搜索、数字、日期时间、文件和富文本输入，以及按钮、链接、复选/单选、开关、滑块、下拉/列表、标签页和菜单项。`select` 还会返回最多 50 个选项及其选中状态；密码框的当前值不会进入 `text`、`value` 或关键字匹配。
- 语义筛选：`filter` 除原有 `interactive`、`media`、`text` 外，还可传 `input`、`form` 或具体 `role`/`controlType`，例如 `checkbox`、`combobox`、`text-input`。关键字匹配同时覆盖可见文本、`label`、`placeholder` 和 `aria-label`。
- Closed Shadow DOM：隔离世界无法访问的 closed shadowRoot 会由 Chromium Accessibility Tree 补充其中可见、可用的交互控件，并返回 `accessibilityFallback=true` 与真实 `clickX/clickY`；这类 item 不伪造 selector，后续应直接使用其 `ref` 点击。
- Fork 原生 Observe 默认在 Chromium UI 层绘制与元素 `id` 对应的边框标签，不写入网页 DOM、不接收鼠标事件；导航、滚动、窗口隐藏或超时后自动清除。最多绘制 120 个标记。
- 路由参数：`tab_id`。
- 下载链接：可见 HTTP/HTTPS 链接会在对应 item 中提供 `downloadUrl`，并汇总到顶层 `downloadLinks`；其中的 `url` 可直接交给 `browser_file`。
- 图片识别：可见 `img`（含 `picture/srcset`）、`video`、`audio`、`canvas` 和 CSS `background-image` 统一返回 `kind=media`；即使图片被网页包装成可点击元素，也保留 `interactive=true`，不会再被误报成普通按钮。
- 图片链接：媒体 item 返回 `mediaType`、`mediaUrl`、`mediaUrls`，HTTP(S) 原图候选同时写入 `downloadUrl`；`downloadLinks` 会携带对应 `ref`、`kind`、`mediaType` 和可选 `linkedUrl`，可直接按四张生成图筛选并下载。

### `browser_screenshot`

- 作用：从 Chromium RenderWidget Surface 截图并返回 PNG base64 `dataUrl`。
- 精确截图：可用 `x`、`y`、`width`、`height` 截取当前视口区域；当前原生协议不公开扩展曾提供的分片整页截图。
- 展示与交付：`send_to_user`。截图不申请 `debugger` 权限，也不会显示浏览器调试提示。

### `browser_action`

- 作用：操作网页中的元素或坐标位置。
- `action`：必填，可用值为 `click`、`double_click`、`right_click`、`drag`、`scroll`、`type`、`insert_text`、`set_selection`、`press_key`。
- 元素定位：优先使用 `browser_observe` 返回的 `ref`。原生连接会保存该元素的视口中心坐标，后续点击直接在该坐标注入鼠标事件，由 Chromium 命中测试选择坐标处最上层元素；selector 用于字符选区和坐标缺失时回退。显式传入的 `x`、`y` 会覆盖 `ref` 默认中心。
- 点击实现：Runtime Bridge 与 AI-FREE 建立连接后，Chromium Views 层的虚拟指针会默认悬浮在网页视口中央，并在连接期间常驻；`click`、`double_click`、`right_click` 复用该指针完成平滑移动、按下、抬起和点击反馈，点击结束后停留在最后位置。覆盖层不进入页面 DOM、不接收事件，也不移动 Windows 全局鼠标；RenderWidgetHost 正常执行坐标命中测试，不会穿透遮挡元素。断开 Runtime Bridge 或页面销毁时指针会清除。
- 鼠标选文：`drag` 使用 `x`、`y` 作为起点，`to_x`、`to_y` 作为终点，真实发送移动、按下、拖动和抬起事件；虚拟指针同步显示拖动过程。
- 字符级编辑：`set_selection` 使用 UTF-16 `start`、`end` 精确放置光标或选择 input、textarea、contenteditable 文本；`start=end` 表示光标。`type` 保持整段覆盖，`insert_text` 仅替换当前选区或从光标位置插入。
- 键盘参数：`key` 支持字符键、方向键、Home/End、PageUp/PageDown、Backspace/Delete、Insert、F1–F24，以及 `Ctrl+A`、`Shift+ArrowLeft` 等组合键；也可用 `ctrl`、`shift`、`alt`、`meta` 显式指定修饰键，`repeat` 可重复 1–100 次。
- 滚动参数：`direction`（`up`、`down`、`top`、`bottom`）、`amount`。
- 其他参数：`force`、`tab_id`。

### `browser_wait`

- 作用：等待指定选择器对应的元素出现，或固定等待一段时间。
- 参数：`selector`、`ms`、`tab_id`。

## 多浏览器路由

AI 对话和 HeySure 设备端都会发现当前所有已连接浏览器的工具，但任一时刻只维护一个“当前控制浏览器”，不允许同时控制多个目标。AI 控制栏的浏览器选择器也是单选。

所有浏览器工具都会额外获得一个可选参数：

- `change_browser`：切换当前控制浏览器，可填写连接 ID 或唯一的连接名称；省略时沿用当前控制目标。

连接列表可以包含多个浏览器，但每次页面工具只会派发到一个连接。切换成功后，同一轮任务中的后续调用继续使用新目标，直到再次传入 `change_browser`。旧 `browser_id`、`browser_name` 和 `browser` 参数仅保留执行兼容，不再向 AI 的新工具 Schema 暴露。

用户在 AI-FREE 顶部标签栏切换活动独立浏览器时，外部 MCP 的当前控制目标也会同步切换。若 MCP 通过 `change_browser` 显式选择后台浏览器，该目标会持续到用户再次切换活动独立浏览器，或后续调用再次传入 `change_browser`。

软件内 AI 会按当前实际工具目录动态注入 MCP 使用提示：同一时间最多控制一个浏览器；需要操作其他连接时先通过 `change_browser` 切换；页面导航、标签页切换或页面状态变化后重新执行 `browser_observe`，不跨窗口或跨页面复用旧元素引用，并以工具的实际返回结果判断任务是否完成。

`windows_tab list` 返回的 `history_id`、`tab_id` 和栏目 `name` 属于外部软件栏目管理层。显示或聚焦已有栏目应调用 `windows_tab` 的 `open`；`history_id` 和 `tab_id` 不能用于 `change_browser`，栏目名称只有同时出现在 MCP 连接列表时才能用于切换。栏目显示为已打开不代表其原生 Runtime Bridge 已就绪。

`windows_tab` 的 `open`、`create`、`edit` 和 `close` 返回值包含 `browser_total`、`browser_open_count`、`browser_names`、`open_browser_names` 和 `active_browser`。显示已有栏目或创建新栏目时会请求将它设为控制目标；MCP 连接建立后，AI 控制栏会自动切换到它。关闭当前控制栏目后会回退到仍在线的一个连接。

`open` 和 `create` 使用两阶段完成条件：先完成 Chromium 窗口打开，再等待对应窗口的认证 Runtime Bridge 握手（默认最多等待 20 秒）。只有返回 `success: true`、`mcp_connected: true` 和 `control_browser_id` 才表示该窗口已经可以继续调用 `browser_tab` 等页面工具。超时会返回 `success: false`、`mcp_connected: false`，同时明确说明窗口已经打开但原生控制通道暂未就绪。同一轮对话会在连接就绪后动态补入新连接及其工具定义，无需等待下一次用户消息。

## HeySure 注册与可用性

- HeySure 设备工具注册由 [`ai-server-device-service.js`](../src/app/main/features/ai-chat/ai-server-device-service.js) 负责，内部名称会转换为 `aifree.<工具名>`。
- 注册同时上报 AI 用途说明“用于连接 AI-FREE，调用其中已启用的软件窗口、浏览器与自动化 MCP 工具”和 `catalogProtocolVersion=2`，让 HeySure AI 能把该设备与普通浏览器、桌面或 Android 执行器区分开；该说明仅是能力元数据，不是执行指令。
- 外部调用目录由 [`browser-automation-external-gateway.js`](../src/app/main/services/browser-automation-external-gateway.js) 汇总，并执行会员权限、浏览器路由和敏感参数限制。
- 只有服务器实时校验为有效会员时，软件才会向 HeySure 注册为在线设备并接受调用。
- 浏览器连接建立或断开后，设备会自动刷新工具目录。因此 HeySure 端可见工具数量可能在 2 个和 9 个之间变化。
- 本地 AI、Codex Bridge 和 HeySure adapter 共用
  [`automation-tool-contract.js`](../src/app/main/services/automation-tool-contract.js)
  中的 Schema、浏览器路由、超时、路由参数清理和错误规范化规则；三端仅保留各自的传输与鉴权适配。
- 旧 `software_window`、`sandbox_files` 和 `browser_download` 名称只在执行层保留兼容，不再出现在公开工具目录；新调用分别使用 `windows_tab`、`run_command` 和 `browser_file`。
