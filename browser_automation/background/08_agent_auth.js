// 08_agent_auth.js — 软件端账号登录 / 认证 HTTP 客户端
// 与 device/extension/src/lib/client.ts 对齐：调用与网页控制台相同的 REST 鉴权接口，
// 拿到 access_token + agent_socket_url 后由 09_agent_socket.js 建立 Socket.IO 连接。
// 认证状态存放在 chrome.storage.local['_agent_auth_state']（记住账号密码时保留）。

const AGENT_SETTINGS_KEY = 'agent-settings';
const AGENT_AUTH_KEY = '_agent_auth_state';

const AGENT_SETTINGS_DEFAULT = {
    serverUrl: 'http://127.0.0.1:3000',
    agentSocketUrl: '',
    agentName: '注册浏览器',
    agentGroup: '',
    deviceId: '',
    offlineMode: false,
    mouseFx: true
};

const AGENT_AUTH_DEFAULT = {
    token: '',
    account: '',
    password: '',
    rememberLogin: false,
    userId: null,
    userName: '',
    avatar: ''
};

function trimUrl(value) {
    return String(value || '').replace(/\/+$/, '');
}

// 携带 HTTP 状态码的错误：让调用方能可靠地把鉴权失败（401/403 → token 失效）
// 与网络/超时错误区分开，避免仅靠 message 文本匹配。
class AgentApiError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'AgentApiError';
        this.status = Number(status) || 0;
    }
}

function isAgentAuthError(err) {
    if (err && typeof err.status === 'number') {
        return err.status === 401 || err.status === 403;
    }
    return /\b(401|403)\b|令牌|凭证|credential|unauthor/i.test(String(err && err.message ? err.message : err));
}

async function parseAgentError(res, fallback) {
    try {
        const data = await res.json();
        return String((data && (data.detail || data.error)) || fallback);
    } catch (_error) {
        return `${fallback} (HTTP ${res.status})`;
    }
}

async function agentRequestJson(url, init, fallback) {
    const options = init && typeof init === 'object' ? init : {};
    const signal = options.signal || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined);
    const res = await fetch(url, { ...options, signal });
    if (!res.ok) {
        throw new AgentApiError(await parseAgentError(res, fallback), res.status);
    }
    return await res.json();
}

function agentAuthHeaders(token, withJson = false) {
    const headers = { Authorization: `Bearer ${token}` };
    if (withJson) {
        headers['Content-Type'] = 'application/json';
    }
    return headers;
}

// ── 设置读写 ────────────────────────────────────────────────────────────────
async function getAgentSettings() {
    const stored = await chrome.storage.local.get(AGENT_SETTINGS_KEY);
    const value = stored && stored[AGENT_SETTINGS_KEY];
    return { ...AGENT_SETTINGS_DEFAULT, ...(value && typeof value === 'object' ? value : {}) };
}

async function saveAgentSettings(partial) {
    const current = await getAgentSettings();
    const next = { ...current, ...(partial && typeof partial === 'object' ? partial : {}) };
    await chrome.storage.local.set({ [AGENT_SETTINGS_KEY]: next });
    return next;
}

// ── 认证状态读写 ────────────────────────────────────────────────────────────
async function getAgentAuth() {
    const stored = await chrome.storage.local.get(AGENT_AUTH_KEY);
    const value = stored && stored[AGENT_AUTH_KEY];
    return { ...AGENT_AUTH_DEFAULT, ...(value && typeof value === 'object' ? value : {}) };
}

async function saveAgentAuth(partial) {
    const current = await getAgentAuth();
    const next = { ...current, ...(partial && typeof partial === 'object' ? partial : {}) };
    await chrome.storage.local.set({ [AGENT_AUTH_KEY]: next });
    return next;
}

async function clearAgentAuth() {
    const current = await getAgentAuth();
    const remembered = current.rememberLogin === true;
    await chrome.storage.local.set({
        [AGENT_AUTH_KEY]: {
            ...AGENT_AUTH_DEFAULT,
            account: remembered ? current.account : '',
            password: remembered ? current.password : '',
            rememberLogin: remembered
        }
    });
}

// ── 鉴权接口 ────────────────────────────────────────────────────────────────
async function agentLogin(serverUrl, account, password) {
    const base = trimUrl(serverUrl);
    if (!base) {
        throw new Error('未配置服务器地址');
    }
    const data = await agentRequestJson(
        `${base}/api/auth/login`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account, password })
        },
        '登录失败'
    );
    if (!data || !data.access_token) {
        throw new Error('登录响应缺少令牌');
    }
    const agentSocketUrl = trimUrl(data.agent_socket_url || '');
    if (!agentSocketUrl) {
        throw new Error('登录响应缺少 Agent 连接地址');
    }
    return { token: data.access_token, user: data.user || {}, agentSocketUrl };
}

async function agentGetMe(serverUrl, token) {
    return agentRequestJson(
        `${trimUrl(serverUrl)}/api/auth/me`,
        { headers: agentAuthHeaders(token) },
        '获取用户信息失败'
    );
}

async function agentGetEndpoint(serverUrl, token) {
    const data = await agentRequestJson(
        `${trimUrl(serverUrl)}/api/auth/agent-endpoint`,
        { headers: agentAuthHeaders(token) },
        '获取 Agent 连接地址失败'
    );
    const agentSocketUrl = trimUrl((data && data.agent_socket_url) || '');
    if (!agentSocketUrl) {
        throw new Error('服务器未返回 Agent 连接地址');
    }
    return agentSocketUrl;
}

// ── 头像缓存 ────────────────────────────────────────────────────────────────
// 服务器返回的 avatar 是相对路径（如 /avatars/avatars3.png）。popup 处于
// chrome-extension:// 源，直接用相对/http URL 会解析失败或被 mixed-content 拦截，
// 所以在后台用 fetch 取回并转成 data URL 交给 popup 渲染（与 device/extension 一致）。
const AGENT_AVATAR_CACHE_KEY = '_agent_avatar_cache';

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

// 把 avatar 路径解析为可显示的 data URL；失败返回空串（永不抛出）。
// 命中缓存（src 未变）时直接返回缓存，避免每次 get-state 重新下载。
async function resolveAgentAvatarDataUrl(serverUrl, avatarPath, token) {
    const base = trimUrl(serverUrl);
    const path = String(avatarPath || '').trim();
    if (!base || !path) {
        return '';
    }
    const src = /^https?:\/\//i.test(path) ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    try {
        const cached = await chrome.storage.local.get(AGENT_AVATAR_CACHE_KEY);
        const entry = cached && cached[AGENT_AVATAR_CACHE_KEY];
        if (entry && entry.src === src && typeof entry.dataUrl === 'string' && entry.dataUrl) {
            return entry.dataUrl;
        }
    } catch (_error) {}
    try {
        const res = await fetch(src, {
            headers: token ? agentAuthHeaders(token) : {},
            signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
        });
        if (!res.ok) {
            return '';
        }
        const buf = await res.arrayBuffer();
        const type = res.headers.get('content-type') || 'image/png';
        const dataUrl = `data:${type};base64,${arrayBufferToBase64(buf)}`;
        await chrome.storage.local.set({ [AGENT_AVATAR_CACHE_KEY]: { src, dataUrl } }).catch(() => {});
        return dataUrl;
    } catch (_error) {
        return '';
    }
}
