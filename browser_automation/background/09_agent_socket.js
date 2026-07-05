// 09_agent_socket.js — HeySure 服务器同步连接（登录后自动连接 + 设备登记 + AI 分配 + 任务调度）
// 与 device/extension/src/lib/background.ts 对齐：登录拿到 agent_socket_url 后建立 Socket.IO
// 连接，使用 DEVICE_ENROLL 上报本设备与工具目录；服务器（网页端「作坊」）为本设备分配 AI，
// 之后 AI 触发的工具调用经 Connector Runtime 以 task:dispatch 下发到这里执行。
//
// 依赖：vendor/socket.io.js 提供的全局 io（importScripts 顺序保证其先加载）；
//       08_agent_auth.js 的登录/设置读写；00-07 的自动化卡片 / Cookie 抓取实现。

const AGENT_KEEPALIVE_ALARM = 'agent-keepalive';
const AGENT_VERSION = '1.0.0';

// Protocol event names (kept for server compatibility)
const DEVICE_ENROLL = 'device:register';
const DEVICE_ENROLLED = 'device:registered';
const DEVICE_ENROLL_REJECTED = 'device:register_rejected';

let agentSocket = null;
let agentStatus = 'disconnected'; // disconnected | connecting | connected | enrolled | error
let agentBoundAiConfigId = null;
let agentCurrentId = null;
let agentMachineId = null;
let agentAuthRejected = false;
let agentConnectPromise = null;
const agentTaskOutcomes = new Map();
const MAX_AGENT_TASK_OUTCOMES = 100;

// ── 工具目录（上报给服务器，AI 据此调用）────────────────────────────────────
// 与原 MCP Server 暴露的四个工具一致（get_status / write_card / run_card / save_cookies），
// 服务器存储这些 schema 并在 mcp.list_tools / describe_tool 中呈现。
function effectiveAgentToolDefs() {
    return [
        {
            name: 'get_status',
            description: '列出本浏览器插件当前保存的所有自动化卡片及其基本信息（id、名称、步骤数、保存时间、是否为当前选中卡片）。',
            input_schema: { type: 'object', properties: {} }
        },
        {
            name: 'write_card',
            description: '创建新的自动化卡片、用同一个 id 覆盖已有卡片，或删除一个已有卡片。action=create/overwrite 时需要提供 cardData（完整卡片 JSON，至少包含 name/website/steps）；action=delete 时需要提供 id。',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['create', 'overwrite', 'delete'], description: '操作类型。' },
                    id: { type: 'string', description: '目标卡片 id；create 可省略（自动生成），overwrite/delete 必填。' },
                    cardData: { type: 'object', description: '完整的卡片 JSON，仅 create/overwrite 需要。' }
                },
                required: ['action']
            }
        },
        {
            name: 'run_card',
            description: '在当前活动标签页运行一张已保存的自动化卡片，等待整个流程结束并返回最终结果（可能耗时数分钟，例如需等待邮箱验证码）。同一时间只能运行一个 run_card。',
            input_schema: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '要运行的卡片 id；省略则使用当前选中的卡片。' },
                    account: { type: 'string', description: '可选：指定执行账号。' },
                    email: { type: 'string', description: '可选：指定执行邮箱。' }
                }
            }
        },
        {
            name: 'save_cookies',
            description: '抓取当前活动标签页的 Cookie、localStorage、sessionStorage，默认保存为本地 JSON 文件；若提供 server_url 会额外把数据 POST 到该地址。返回值只含统计信息与上传状态，不含原始 Cookie 内容。',
            input_schema: {
                type: 'object',
                properties: {
                    account: { type: 'string', description: '可选：关联账号，用于文件命名。' },
                    password: { type: 'string', description: '可选：关联密码，用于文件命名。' },
                    server_url: { type: 'string', description: '可选：抓取结果额外 POST 上传的服务器地址。' },
                    card_key: { type: 'string', description: '可选：随上传附带的卡密/凭证标识。' }
                }
            }
        },
        // ── 导航与搜索 ─────────────────────────────────────────────────────
        {
            name: 'browser_tab',
            description: '浏览器标签页与导航管理：列出已打开页面、切换标签、在当前页覆盖跳转、新标签打开链接、关闭标签、前进后退。动作仅 7 种：list 获取全部页面及当前激活页；switch 切换到已有 tab_id；replace 在当前页（或 tab_id）覆盖跳转到 url；navigate 在新标签页打开 url；close 关闭标签；back/forward 历史导航。流程：先 list，目标页已开则 switch，要在当前页改地址用 replace，并行任务用 navigate。',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'switch', 'replace', 'navigate', 'close', 'back', 'forward'], description: 'list 列出全部标签并返回 activeTab；switch 切换到 tab_id（不改 URL）；replace 在当前/指定标签覆盖跳转到 url；navigate 在新标签打开 url；close 关闭 tab_id（默认当前标签）；back/forward 后退/前进一步。' },
                    url: { type: 'string', description: 'action=replace / navigate 时要打开的 URL（缺协议时按 https 补全）。' },
                    tab_id: { type: 'number', description: 'action=switch 必填；action=close/replace/back/forward 可选，指定目标标签，默认当前活动标签。' },
                    tabId: { type: 'number', description: 'tab_id 的兼容别名。' },
                    id: { type: 'number', description: 'tab_id 的兼容别名。' }
                },
                required: ['action']
            }
        },
        // ── 页面观察 ───────────────────────────────────────────────────────
        {
            name: 'browser_observe',
            description: '感知当前视口里用户能看到的内容：返回 items 混排列表，kind=interactive 是最顶层、未被遮挡的按钮/链接/输入框/下拉/菜单项等（每项带 id，用于 browser_action 的 ref 参数），kind=text 是普通可见文本。仅扫描当前标签页的主文档，不识别跨域 iframe 内部内容，也不识别 img/video/audio 媒体元素（这是与桌面端/其他浏览器扩展实现的差异，纯 JS 扩展没有 CDP/跨域访问能力）。若匹配条目超过 limit/max_items，默认不返回 items，只返回 tooMany=true 与 categoryCounts，提示继续用 filter/tag/keyword 缩小范围。默认会在页面上绘制无遮挡=绿色/被遮挡或不可点=红色的描边标记，便于配合 browser_screenshot 查看。用途：点击/输入前的首选观察手段。场景：先 observe 拿到 id，再用 browser_action {action:"click", ref:id} 精确点击；页面变化后重新 observe 以刷新 id（id 只在下一次 observe 前有效）。',
            input_schema: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: '最多返回的可交互元素条目数；超过时默认不返回 items，只返回 tooMany/categoryCounts。默认 120，最大 200。' },
                    max_items: { type: 'number', description: '最终 items 混排列表允许返回的最大总条数；超过时默认不返回 items，只返回 categoryCounts。默认约等于 limit + text_limit + 40，最大 500。' },
                    filter: {
                        type: ['string', 'array'],
                        items: { type: 'string' },
                        description: '按类别筛选，缩小噪音。可传单个字符串、逗号分隔字符串或字符串数组。可选类别：button（按钮）、link（链接）、input（输入框/文本域/可编辑区）、select（下拉框）、checkbox（复选/开关）、radio（单选）、tab（标签页）、menuitem（菜单项）、option（选项）、label（标签元素）、text（普通可见文本）。例：filter:"button" 只看按钮；filter:["input","select"] 只看输入框和下拉框；不传或传 "all" 则返回全部。'
                    },
                    tag: { type: ['string', 'array'], items: { type: 'string' }, description: '按 HTML 标签名进一步筛选，如 "button"、"a"、"input"，也可传数组或逗号分隔字符串。' },
                    tags: { type: ['string', 'array'], items: { type: 'string' }, description: 'tag 的别名。' },
                    keyword: { type: 'string', description: '按关键词筛选，匹配可见文本、aria-label/title、name/id、href 等常用字段；也兼容 query/text_filter。' },
                    query: { type: 'string', description: 'keyword 的兼容别名。' },
                    text_filter: { type: 'string', description: 'keyword 的兼容别名。' },
                    include_text: { type: 'boolean', description: '是否同时包含普通可见文本（items 中 kind=text 的条目）。默认 true；传 false 时只返回可交互元素。' },
                    text_limit: { type: 'number', description: '最多返回的普通可见文本条数。默认 200，最大 500。' },
                    allow_truncate: { type: 'boolean', description: '为 true 时即使超过 limit/max_items 也截断返回；默认 false，即超量时不返回 items，只给 categoryCounts 和筛选提示。' },
                    mark: { type: 'boolean', description: '是否在页面上绘制状态色描边标记，便于随后截图查看。默认 true；传 false 只清除已有标记、不重绘。标记为纯视觉叠加，不影响其他工具或点击。' }
                }
            }
        },
        {
            name: 'browser_screenshot',
            description: '对当前标签页截图并返回 base64 图片 dataUrl（服务器会据此自动保存并按需推送给用户）。仅支持可视区域截图（本插件无 debugger 权限，不支持整页/精确元素裁剪截图，也无法截取非前台标签页），若传 selector 会先尝试把该元素滚动进视口再截可视区。用途：让 AI「看见」页面，常与 browser_observe 的描边标记配合核对可点击元素。场景：核对页面状态、在无法读取文本时改用视觉理解。',
            input_schema: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: '截图前尝试滚动进视口的元素 CSS selector（仍是可视区域截图，不做元素裁剪）。' },
                    format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式。默认 png。' },
                    quality: { type: 'number', description: 'JPEG 质量，0-100。' }
                }
            }
        },
        // ── 页面交互 ───────────────────────────────────────────────────────
        {
            name: 'browser_action',
            description: '页面交互聚合工具：用 action 指定要做的动作——点击 click（单击）、双击 double_click、右键 right_click、滚动 scroll、输入文本 type、键盘按键 press_key。定位优先级 ref（browser_observe 返回的 id，最稳）> selector > text > 坐标；非坐标点击会先做遮挡检测，被遮挡时返回 occluded 诊断（需穿透点击传 force:true）。\n' +
                '· click / double_click / right_click：派发 pointer+mouse 合成事件序列（非 CDP trusted 事件，多数站点的框架事件监听能覆盖，但个别依赖真实用户手势的场景可能无效）。\n' +
                '· scroll：滚动页面，返回滚动前后位置与移动像素数。\n' +
                '· type：向 input/textarea/可编辑区输入文本（单字段；多字段请多次 type）；submit:true 时优先调用所在表单的 requestSubmit()（合成键盘事件不会触发浏览器原生 Enter 提交，这里用等效方式兜底）。\n' +
                '· press_key：在焦点元素或指定 selector 上派发合成键盘事件，可带 Ctrl/Shift/Alt/Meta 修饰键；同样不是 CDP trusted 事件，按 Enter 时会尝试兜底 requestSubmit()。\n' +
                '用途：统一的点击/滚动/输入/键盘入口。场景：先 browser_observe 拿到 id，再 browser_action {action:"click", ref:id} 点击；页面变化后如需查看结果，自行再调用一次 browser_observe（本工具不会自动附带增量观察）。',
            input_schema: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'scroll', 'type', 'press_key'], description: '要执行的交互动作。' },
                    ref: { type: ['number', 'string'], description: 'browser_observe 返回的元素 id（click/double_click/right_click/type 均可用），最稳的定位方式，优先使用；仅在下一次 browser_observe 之前有效。' },
                    selector: { type: 'string', description: '目标元素的 CSS selector（click/double_click/right_click 定位；type 指定输入框；press_key 指定先聚焦的元素；scroll 可指定滚动进视口的元素）。' },
                    text: { type: 'string', description: 'action=click/double_click/right_click 时用可见文本定位元素；action=type 时为「要输入的文本」。' },
                    x: { type: 'number', description: 'click/double_click/right_click 的 X 坐标（像素，视口坐标）。' },
                    y: { type: 'number', description: 'click/double_click/right_click 的 Y 坐标（像素，视口坐标）。' },
                    force: { type: 'boolean', description: 'action=click 时为 true 即使被遮挡也强制点击；默认 false：被遮挡返回 occluded 诊断。' },
                    direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'action=scroll 的方向：up 上、down 下、top 到顶、bottom 到底。' },
                    amount: { type: 'number', description: 'action=scroll 的滚动像素数。默认 400。' },
                    clear_first: { type: 'boolean', description: 'action=type 时输入前先清空字段。默认 true。' },
                    submit: { type: 'boolean', description: 'action=type 时输入后尝试提交所在表单。' },
                    key: { type: 'string', description: 'action=press_key 的键名，如 "Enter"、"Escape"、"Tab"、"ArrowDown"、"a"。' },
                    ctrl: { type: 'boolean', description: 'action=press_key 时按住 Ctrl。' },
                    shift: { type: 'boolean', description: 'action=press_key 时按住 Shift。' },
                    alt: { type: 'boolean', description: 'action=press_key 时按住 Alt。' },
                    meta: { type: 'boolean', description: 'action=press_key 时按住 Meta/Cmd。' }
                },
                required: ['action']
            }
        },
        {
            name: 'browser_wait',
            description: '等待某个 CSS selector 出现，或固定等待一段时间。用途：等待页面/元素就绪后再操作。场景：等异步加载的按钮出现、等动画结束、给页面留出渲染时间。',
            input_schema: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: '等待出现的 CSS 元素。' },
                    ms: { type: 'number', description: '固定等待的毫秒数（不传 selector 时使用；默认 1000）。' }
                }
            }
        },
        {
            name: 'browser_drag',
            description: '从源元素/点拖拽到目标元素/点并放下，派发 pointer/mouse 合成事件序列 + HTML5 dragstart/dragover/drop 事件，返回源元素是否发生了可观察位移。合成拖拽，不接入真实操作系统级拖拽，依赖原生文件拖拽等场景的页面可能无法响应。用途：拖放交互。场景：拖动排序、把元素拖入投放区、滑块操作。',
            input_schema: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: '源元素 CSS selector。' },
                    text: { type: 'string', description: '源元素可见文本。' },
                    x: { type: 'number', description: '源点 X 坐标（像素）。' },
                    y: { type: 'number', description: '源点 Y 坐标（像素）。' },
                    to_selector: { type: 'string', description: '目标元素 CSS selector。' },
                    to_text: { type: 'string', description: '目标元素可见文本。' },
                    to_x: { type: 'number', description: '目标点 X 坐标（像素）。' },
                    to_y: { type: 'number', description: '目标点 Y 坐标（像素）。' }
                }
            }
        }
    ];
}

// ── 状态广播（推送给已打开的 popup）──────────────────────────────────────────
function agentStatePayload() {
    return {
        status: agentStatus,
        boundAiConfigId: agentBoundAiConfigId,
        authRejected: agentAuthRejected
    };
}

function broadcastAgentStatus() {
    // popup 可能未打开；忽略「无接收方」错误。
    try {
        chrome.runtime.sendMessage({ type: 'agent:status', ...agentStatePayload() }).catch(() => {});
    } catch (_error) {}
}

function setAgentStatus(status, reason) {
    agentStatus = status;
    if (status !== 'enrolled' && status !== 'connected') {
        agentBoundAiConfigId = null;
    }
    const badgeColors = {
        disconnected: '#787878',
        connecting: '#f59e0b',
        connected: '#6366f1',
        enrolled: '#22c55e',
        error: '#ef4444'
    };
    try {
        chrome.action.setBadgeBackgroundColor({ color: badgeColors[status] || '#787878' });
        chrome.action.setBadgeText({ text: status === 'enrolled' ? '●' : status === 'error' ? '!' : '' });
        chrome.action.setTitle({ title: `AI自动化插件 — ${status}${reason ? `（${reason}）` : ''}` });
    } catch (_error) {}
    broadcastAgentStatus();
}

// ── 机器码 ──────────────────────────────────────────────────────────────────
async function getAgentMachineId() {
    if (agentMachineId) {
        return agentMachineId;
    }
    const stored = await chrome.storage.local.get('_agent_mid');
    if (stored && stored._agent_mid) {
        agentMachineId = stored._agent_mid;
        return agentMachineId;
    }
    const id = `ba-${Math.random().toString(36).slice(2, 10)}`;
    await chrome.storage.local.set({ _agent_mid: id });
    agentMachineId = id;
    return id;
}

function parseAiConfigId(raw) {
    const n = typeof raw === 'number' ? raw : (raw != null && String(raw).trim() !== '' ? Number(raw) : null);
    return Number.isFinite(n) ? n : null;
}

// ── 设备登记 ────────────────────────────────────────────────────────────────────
async function emitAgentEnrollOn(socket) {
    const settings = await getAgentSettings();
    const auth = await getAgentAuth();
    if (settings.offlineMode) {
        return;
    }
    const id = settings.deviceId || await getAgentMachineId();
    agentCurrentId = id;
    const toolDefs = effectiveAgentToolDefs();
    socket.emit(DEVICE_ENROLL, {
        id,
        // 与扩展端一致：设备不自选 AI，登录连接后由网页端「作坊」为其分配；服务器
        // 每次登记都会重新套用该绑定，因此这里始终发送 aiConfigId: null。
        aiConfigId: null,
        name: settings.agentName || 'AI自动化浏览器',
        group: settings.agentGroup || '',
        platform: `browser-extension (${(typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent.split(' ').pop() : 'chrome')})`,
        os: { platform: 'browser', arch: 'unknown', release: AGENT_VERSION, hostname: id },
        capabilities: toolDefs.map((t) => t.name),
        toolDefs,
        version: AGENT_VERSION,
        token: auth.token || '',
        userId: auth.userId != null ? auth.userId : null,
        workspaceRoot: '',
        lifecycle: 'registered',
        isWindowsDesktop: false,
        isBrowserExtension: true
    });
}

async function agentEnroll() {
    const settings = await getAgentSettings();
    if (settings.offlineMode || !agentSocket) {
        return;
    }
    await emitAgentEnrollOn(agentSocket);
}

// ── 连接 ────────────────────────────────────────────────────────────────────
async function agentConnect() {
    if (agentSocket && agentSocket.connected) {
        return;
    }
    if (agentConnectPromise) {
        return agentConnectPromise;
    }
    agentConnectPromise = agentDoConnect().finally(() => {
        agentConnectPromise = null;
    });
    return agentConnectPromise;
}

async function agentDoConnect() {
    if (typeof io !== 'function') {
        setAgentStatus('error', 'socket.io 未加载');
        return;
    }
    const settings = await getAgentSettings();
    if (agentSocket && agentSocket.connected) {
        return;
    }
    if (settings.offlineMode) {
        return;
    }

    const auth = await getAgentAuth();
    if (!auth.token) {
        setAgentStatus('disconnected', '未登录');
        return;
    }

    let agentSocketUrl = String(settings.agentSocketUrl || '').trim();
    if (!agentSocketUrl) {
        try {
            agentSocketUrl = await agentGetEndpoint(settings.serverUrl, auth.token);
            await saveAgentSettings({ agentSocketUrl });
        } catch (error) {
            setAgentStatus('error', '无法获取 Agent 连接地址');
            return;
        }
    }

    try {
        agentSocketUrl = new URL(agentSocketUrl).href.replace(/\/$/, '');
    } catch (_error) {
        setAgentStatus('error', 'Agent 连接地址格式无效');
        return;
    }

    if (agentSocket) {
        agentSocket.removeAllListeners();
        agentSocket.disconnect();
        agentSocket = null;
    }

    agentAuthRejected = false;
    setAgentStatus('connecting');

    agentSocket = io(agentSocketUrl, {
        transports: ['websocket', 'polling'],
        reconnectionDelay: 2000,
        reconnectionAttempts: Infinity
    });
    attachAgentListeners(agentSocket);
}

function attachAgentListeners(socket) {
    socket.on('connect', async () => {
        setAgentStatus('connected');
        await agentEnroll();
        flushUnsentAgentOutcomes();
    });

    socket.on('disconnect', (reason) => {
        setAgentStatus('disconnected', reason);
        // 传输层断开 Socket.IO 会自动重连；但服务器显式关闭（io server disconnect，
        // 例如服务端重启）不会自动重连，这里主动补一次。
        if (reason === 'io server disconnect' && !agentAuthRejected) {
            setTimeout(() => {
                if (agentSocket && !agentSocket.connected && !agentSocket.active) {
                    agentSocket.connect();
                }
            }, 2000);
        }
    });

    socket.on('connect_error', (err) => {
        setAgentStatus('error', err && err.message ? err.message : '连接失败');
    });

    socket.on(DEVICE_ENROLLED, (data) => {
        agentBoundAiConfigId = parseAiConfigId(data && data.aiConfigId);
        setAgentStatus('enrolled');
    });

    socket.on('device:list', (rows) => {
        if (!agentCurrentId || !Array.isArray(rows)) {
            return;
        }
        const mine = rows.find((row) => String((row && row.id) || '') === agentCurrentId);
        if (!mine) {
            return;
        }
        const next = parseAiConfigId(mine.aiConfigId != null ? mine.aiConfigId : mine.ai_config_id);
        if (next !== agentBoundAiConfigId) {
            agentBoundAiConfigId = next;
            broadcastAgentStatus();
        }
    });

    socket.on(DEVICE_ENROLL_REJECTED, (data) => {
        const reason = (data && data.reason) || '设备登记被服务器拒绝';
        // 非瞬时错误（token 失效或 AI 归属不符）：用同一 token 重连会无限循环，
        // 因此锁定 authRejected、关闭自动重连并断开，等用户重新登录后再连。
        agentAuthRejected = true;
        try { socket.io.reconnection(false); } catch (_error) {}
        agentDisconnect();
        setAgentStatus('error', reason);
    });

    socket.on('task:dispatch', (task) => { void handleAgentTask(task); });
}

function agentDisconnect() {
    if (agentSocket) {
        agentSocket.disconnect();
        agentSocket = null;
    }
    setAgentStatus('disconnected');
}

// ── 任务结果缓存与回传 ──────────────────────────────────────────────────────
function rememberAgentOutcome(taskId, outcome) {
    agentTaskOutcomes.delete(taskId);
    agentTaskOutcomes.set(taskId, outcome);
    for (const key of agentTaskOutcomes.keys()) {
        if (agentTaskOutcomes.size <= MAX_AGENT_TASK_OUTCOMES) {
            break;
        }
        if (agentTaskOutcomes.get(key) && agentTaskOutcomes.get(key).kind === 'running') {
            continue;
        }
        agentTaskOutcomes.delete(key);
    }
}

function emitAgentOutcome(taskId, outcome) {
    if (!agentSocket || !agentSocket.connected) {
        outcome.unsent = true;
        return;
    }
    if (outcome.kind === 'result') {
        agentSocket.emit('task:result', outcome.payload);
    } else if (outcome.kind === 'error') {
        agentSocket.emit('task:error', { taskId, userId: outcome.userId, error: outcome.error });
    }
    outcome.unsent = false;
}

function flushUnsentAgentOutcomes() {
    if (!agentSocket || !agentSocket.connected) {
        return;
    }
    for (const [taskId, outcome] of agentTaskOutcomes) {
        if (outcome && outcome.unsent) {
            emitAgentOutcome(taskId, outcome);
        }
    }
}

// ── 工具命令执行（task.tool → 自动化卡片 / Cookie 抓取实现）────────────────────
async function runAgentToolCommand(tool, args) {
    const payload = args && typeof args === 'object' ? args : {};
    switch (tool) {
        case 'get_status': {
            const state = await loadCardCacheState();
            return { items: state.items, selectedId: state.selectedId };
        }
        case 'write_card': {
            const action = String(payload.action || '').trim();
            if (action === 'delete') {
                return await deleteCardCacheEntry(String(payload.id || '').trim());
            }
            if (action === 'create' || action === 'overwrite') {
                const saved = await saveCardCacheState(payload.cardData, String(payload.id || '').trim());
                return { action, id: saved.selectedId, items: saved.items, selectedId: saved.selectedId };
            }
            throw new Error(`未知的 write_card action: ${action || '(空)'}`);
        }
        case 'run_card': {
            const state = await loadCardCacheState();
            const targetId = String(payload.id || '').trim();
            const entry = targetId ? state.items.find((item) => item.id === targetId) : null;
            if (targetId && !entry) {
                throw new Error(`未找到自动化卡片: ${targetId}`);
            }
            return await runStandaloneCard({
                cardData: entry ? entry.cardData : undefined,
                account: payload.account || '',
                email: payload.email || '',
                isLooping: false,
                debugMode: false
            });
        }
        case 'save_cookies':
        case 'capture_cookies': {
            const raw = await captureCurrentTab({
                account: payload.account || '',
                password: payload.password || '',
                serverUrl: payload.serverUrl || payload.server_url || '',
                cardKey: payload.cardKey || payload.card_key || ''
            });
            // 只回传统计信息与上传状态，避免把原始 Cookie 内容带出。
            return {
                success: raw && raw.success !== false,
                fileName: raw && raw.fileName,
                cookieCount: raw && raw.cookieCount,
                browserStorageCount: raw && raw.browserStorageCount,
                pageUrl: raw && raw.pageUrl,
                upload: raw && raw.upload
            };
        }
        case 'browser_tab':
            return await toolBrowserTab(payload);
        case 'browser_observe':
            return await toolBrowserObserve(payload);
        case 'browser_screenshot':
            return await toolBrowserScreenshot(payload);
        case 'browser_action':
            return await toolBrowserAction(payload);
        case 'browser_wait':
            return await toolBrowserWait(payload);
        case 'browser_drag':
            return await toolBrowserDrag(payload);
        default:
            throw new Error(`未知工具: ${tool || '(空)'}`);
    }
}

function summarizeAgentResult(tool, result) {
    if (result && typeof result === 'object') {
        if (typeof result.summary === 'string' && result.summary.trim()) {
            return result.summary.trim();
        }
        if (tool === 'run_card' && result.cardName) {
            return `${result.success ? '执行完成' : '执行未完成'}: ${result.cardName}`;
        }
        if (tool === 'save_cookies') {
            return `已抓取 Cookie ${Number(result.cookieCount || 0)} 条`;
        }
        if (tool === 'get_status' && Array.isArray(result.items)) {
            return `共 ${result.items.length} 张自动化卡片`;
        }
        if (tool === 'browser_tab') {
            return `browser_tab ${result.action || ''} 完成${result.url ? `: ${result.url}` : ''}`;
        }
        if (tool === 'browser_observe') {
            return result.tooMany
                ? `匹配元素过多（${result.itemCount || 0} 个），已收窄筛选提示`
                : `共 ${Number(result.count || 0)} 个可交互元素、${Number(result.textCount || 0)} 段文本`;
        }
        if (tool === 'browser_screenshot') {
            return result.success === false ? `截图失败: ${result.error || ''}` : '已截取当前可视区域';
        }
        if (tool === 'browser_action') {
            return result.success === false
                ? `${result.code || 'browser_action'} 未成功: ${result.error || ''}`
                : `browser_action 完成`;
        }
        if (tool === 'browser_wait') {
            return result.success === false ? `等待超时: ${result.error || ''}` : '等待完成';
        }
        if (tool === 'browser_drag') {
            return result.success === false ? `拖拽失败: ${result.error || ''}` : `拖拽完成（源元素${result.moved ? '' : '未'}发生位移）`;
        }
    }
    return `${tool} 执行完成`;
}

async function handleAgentTask(task) {
    const taskId = task && task.taskId;
    if (!taskId) {
        return;
    }

    const cached = agentTaskOutcomes.get(taskId);
    if (cached) {
        if (cached.kind === 'result' || cached.kind === 'error') {
            emitAgentOutcome(taskId, cached);
        }
        return;
    }

    agentTaskOutcomes.set(taskId, { kind: 'running' });
    const tool = task.tool || '';
    if (agentSocket && agentSocket.connected) {
        agentSocket.emit('task:progress', { taskId, progress: 0, message: `执行 ${tool}...` });
    }

    try {
        const result = await runAgentToolCommand(tool, task.args || {});
        const success = !(result && result.success === false);
        const payload = {
            taskId,
            userId: task.userId,
            aiConfigId: task.aiConfigId,
            sessionId: task.sessionId,
            tool,
            success,
            result,
            summary: summarizeAgentResult(tool, result)
        };
        const entry = { kind: 'result', payload };
        rememberAgentOutcome(taskId, entry);
        emitAgentOutcome(taskId, entry);
    } catch (error) {
        const errMsg = error && error.message ? error.message : String(error);
        const entry = { kind: 'error', error: errMsg, userId: task.userId };
        rememberAgentOutcome(taskId, entry);
        emitAgentOutcome(taskId, entry);
    }
}

// ── 生命周期 / 保活 ─────────────────────────────────────────────────────────
async function restoreAndConnectAgent() {
    const settings = await getAgentSettings();
    const auth = await getAgentAuth();
    if (!settings.offlineMode && auth.token && !agentAuthRejected) {
        await agentConnect();
    }
}

function nudgeAgentSocket() {
    if (agentAuthRejected) {
        return;
    }
    if (!agentSocket) {
        void restoreAndConnectAgent();
        return;
    }
    if (!agentSocket.connected && !agentSocket.active) {
        agentSocket.connect();
    }
}

try {
    chrome.alarms.create(AGENT_KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
} catch (_error) {}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === AGENT_KEEPALIVE_ALARM) {
        nudgeAgentSocket();
    }
});

chrome.runtime.onStartup.addListener(() => {
    void restoreAndConnectAgent();
});

// 登录/登出通常经 popup → background 消息触发，这里再兜底监听 auth 存储变化，
// 保证令牌变化时始终尝试连接/断开。
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[AGENT_AUTH_KEY]) {
        return;
    }
    const oldToken = String((changes[AGENT_AUTH_KEY].oldValue && changes[AGENT_AUTH_KEY].oldValue.token) || '');
    const newToken = String((changes[AGENT_AUTH_KEY].newValue && changes[AGENT_AUTH_KEY].newValue.token) || '');
    if (oldToken === newToken) {
        return;
    }
    agentAuthRejected = false;
    if (newToken) {
        if (agentSocket) {
            agentDisconnect();
        }
        void agentConnect();
    } else {
        agentDisconnect();
    }
});

// ── popup 消息接口 ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string' || !message.type.startsWith('agent:')) {
        return false;
    }

    (async () => {
        try {
            switch (message.type) {
                case 'agent:get-state': {
                    const settings = await getAgentSettings();
                    const auth = await getAgentAuth();
                    // avatar 是服务器相对路径，转成 data URL 后 popup 才能显示。
                    const avatarDataUrl = auth.token
                        ? await resolveAgentAvatarDataUrl(settings.serverUrl, auth.avatar, auth.token)
                        : '';
                    sendResponse({
                        ok: true,
                        ...agentStatePayload(),
                        settings,
                        auth: {
                            loggedIn: !!auth.token,
                            account: auth.account || '',
                            userName: auth.userName || '',
                            userId: auth.userId,
                            avatar: avatarDataUrl,
                            rememberLogin: auth.rememberLogin === true
                        }
                    });
                    break;
                }
                case 'agent:save-settings': {
                    const prev = await getAgentSettings();
                    const payload = { ...(message.payload || {}) };
                    const serverChanged = payload.serverUrl !== undefined && payload.serverUrl !== prev.serverUrl;
                    // 换服务器后旧的 agentSocketUrl 失效，清掉让其重新解析。
                    if (serverChanged && payload.agentSocketUrl === undefined) {
                        payload.agentSocketUrl = '';
                    }
                    const next = await saveAgentSettings(payload);
                    if (payload.offlineMode === true && agentSocket && agentSocket.connected) {
                        agentDisconnect();
                    } else if ((serverChanged || payload.agentSocketUrl !== undefined) && agentSocket) {
                        agentDisconnect();
                        if (!next.offlineMode) {
                            void agentConnect();
                        }
                    }
                    sendResponse({ ok: true, settings: next });
                    break;
                }
                case 'agent:login': {
                    const settings = await getAgentSettings();
                    const account = String((message.payload && message.payload.account) || '').trim();
                    const password = String((message.payload && message.payload.password) || '');
                    const remember = (message.payload && message.payload.rememberLogin) === true;
                    if (!account || !password) {
                        sendResponse({ ok: false, error: '请填写账号和密码' });
                        break;
                    }
                    const result = await agentLogin(settings.serverUrl, account, password);
                    agentAuthRejected = false;
                    await saveAgentAuth({
                        token: result.token,
                        account,
                        password: remember ? password : '',
                        rememberLogin: remember,
                        userId: result.user && result.user.id != null ? result.user.id : null,
                        userName: (result.user && (result.user.name || result.user.account)) || account,
                        avatar: (result.user && result.user.avatar) || ''
                    });
                    await saveAgentSettings({ agentSocketUrl: result.agentSocketUrl });
                    void agentConnect();
                    sendResponse({
                        ok: true,
                        auth: {
                            loggedIn: true,
                            account,
                            userName: (result.user && (result.user.name || result.user.account)) || account
                        }
                    });
                    break;
                }
                case 'agent:logout': {
                    agentAuthRejected = false;
                    agentDisconnect();
                    await clearAgentAuth();
                    await saveAgentSettings({ agentSocketUrl: '' });
                    await chrome.storage.local.remove(AGENT_AVATAR_CACHE_KEY).catch(() => {});
                    sendResponse({ ok: true });
                    break;
                }
                case 'agent:connect': {
                    agentAuthRejected = false;
                    if (agentSocket && agentSocket.connected) {
                        await emitAgentEnrollOn(agentSocket);
                    } else {
                        await agentConnect();
                    }
                    sendResponse({ ok: true, ...agentStatePayload() });
                    break;
                }
                case 'agent:disconnect': {
                    agentDisconnect();
                    sendResponse({ ok: true, ...agentStatePayload() });
                    break;
                }
                case 'agent:test-connection': {
                    const settings = await getAgentSettings();
                    const auth = await getAgentAuth();
                    let http = { ok: false };
                    try {
                        const base = trimUrl(settings.serverUrl);
                        const start = Date.now();
                        const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) });
                        http = { ok: true, status: res.status, ms: Date.now() - start };
                    } catch (error) {
                        http = { ok: false, error: error && error.message ? error.message : String(error) };
                    }
                    sendResponse({ ok: http.ok, http, needsLogin: !auth.token });
                    break;
                }
                default:
                    sendResponse({ ok: false, error: `未知指令: ${message.type}` });
            }
        } catch (error) {
            sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
        }
    })();

    return true; // async sendResponse
});

// 模块加载即尝试恢复连接（SW 被唤醒时）。
void restoreAndConnectAgent();
