// 09_agent_socket.js — HeySure 服务器同步连接（登录后自动连接 + 注册 + AI 分配 + 任务调度）
// 与 device/extension/src/lib/background.ts 对齐：登录拿到 agent_socket_url 后建立 Socket.IO
// 连接，device:register 上报本设备与工具目录；服务器（网页端「作坊」）为本设备分配 AI，
// 之后 AI 触发的工具调用经 Connector Runtime 以 task:dispatch 下发到这里执行。
//
// 依赖：vendor/socket.io.js 提供的全局 io（importScripts 顺序保证其先加载）；
//       08_agent_auth.js 的登录/设置读写；00-07 的自动化卡片 / Cookie 抓取实现。

const AGENT_KEEPALIVE_ALARM = 'agent-keepalive';
const AGENT_VERSION = '1.0.0';

let agentSocket = null;
let agentStatus = 'disconnected'; // disconnected | connecting | connected | registered | error
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
    if (status !== 'registered' && status !== 'connected') {
        agentBoundAiConfigId = null;
    }
    const badgeColors = {
        disconnected: '#787878',
        connecting: '#f59e0b',
        connected: '#6366f1',
        registered: '#22c55e',
        error: '#ef4444'
    };
    try {
        chrome.action.setBadgeBackgroundColor({ color: badgeColors[status] || '#787878' });
        chrome.action.setBadgeText({ text: status === 'registered' ? '●' : status === 'error' ? '!' : '' });
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

// ── 设备注册 ────────────────────────────────────────────────────────────────────
async function emitAgentRegisterOn(socket) {
    const settings = await getAgentSettings();
    const auth = await getAgentAuth();
    if (settings.offlineMode) {
        return;
    }
    const id = settings.deviceId || await getAgentMachineId();
    agentCurrentId = id;
    const toolDefs = effectiveAgentToolDefs();
    socket.emit('device:register', {
        id,
        // 与扩展端一致：设备不自选 AI，登录连接后由网页端「作坊」为其分配；服务器
        // 每次注册都会重新套用该绑定，因此这里始终发送 aiConfigId: null。
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

async function agentRegister() {
    const settings = await getAgentSettings();
    if (settings.offlineMode || !agentSocket) {
        return;
    }
    await emitAgentRegisterOn(agentSocket);
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
        await agentRegister();
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

    socket.on('device:registered', (data) => {
        agentBoundAiConfigId = parseAiConfigId(data && data.aiConfigId);
        setAgentStatus('registered');
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

    socket.on('device:register_rejected', (data) => {
        const reason = (data && data.reason) || '设备注册被服务器拒绝';
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
                        await emitAgentRegisterOn(agentSocket);
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
