// 客户端与服务器之间仅使用 HTTP 通信。
const { NETWORK_DIAG_CONFIG, getServerBase, setRuntimeServerBase } = require('../config');
const { postJson, postEventStream, getJson } = require('./http');
const { executeHttpRequest } = require('./http-client/transport-request');
const { isServerBaseAllowedForMode } = require('../utils/server-mode');
const { normalizeValidationRuntimeConfig } = require('../features/account/validation-runtime-config');

const RUNTIME_SERVER_BASE_FIELDS = [
    'serverBase',
    'server_base',
    'address_HTTP',
    'addressHttp',
    'address_http',
    'client_address',
    'clientAddress',
    'address',
];

function collectRuntimeServerBaseCandidates(source) {
    if (!source || typeof source !== 'object') return [];
    const roots = [source, source.result, source.data, source.payload]
        .filter((value) => value && typeof value === 'object');
    return roots.flatMap((root) => RUNTIME_SERVER_BASE_FIELDS.map((field) => root[field]));
}

function getClientConfigResultError(result) {
    if (!result || typeof result !== 'object') return '获取客户端配置失败';
    return result.message || result.error || '获取客户端配置失败';
}

function withHttpTransportMode(result) {
    return { ...result, transportMode: 'http' };
}

// HTTP 客户端：负责把客户端请求通过 HTTP 发送到服务器。
class HttpClient {
    /** @param {any} [options] */
    constructor(options = {}) {
        // 兼容旧调用：既支持直接传入 mainWindow，也支持 options 对象。
        const hasMainWindow =
            typeof options === 'object'
            && options !== null
            && Object.prototype.hasOwnProperty.call(options, 'mainWindow');
        const mainWindow = hasMainWindow ? options.mainWindow : options;

        // 主窗口引用（供上层使用）
        /** @type {any} */
        this.mainWindow = mainWindow;
        // 传输模式恒为 http（保留字段以兼容读取方）
        this.transportMode = 'http';
        // 运行时服务器地址（从响应中同步，优先于配置文件）
        this.runtimeServerBase = '';
    }

    _normalizeRuntimeServerBase(value) {
        const text = String(value || '').trim();
        if (!text) return '';
        try {
            const url = new URL(text.includes('://') ? text : `http://${text}`);
            const pathname = String(url.pathname || '').replace(/\/+$/, '');
            const normalized = `${url.protocol}//${url.host}${pathname === '/' ? '' : pathname}`.replace(/\/+$/, '');
            return isServerBaseAllowedForMode(normalized) ? normalized : '';
        } catch (_) {
            const normalized = text.replace(/\/+$/, '');
            return isServerBaseAllowedForMode(normalized) ? normalized : '';
        }
    }

    _extractRuntimeServerBase(source) {
        for (const candidate of collectRuntimeServerBaseCandidates(source)) {
            const normalized = this._normalizeRuntimeServerBase(candidate);
            if (normalized) {
                return normalized;
            }
        }
        return '';
    }

    _syncRuntimeServerBase(source) {
        const nextBase = this._extractRuntimeServerBase(source);
        if (!nextBase) {
            return '';
        }

        this.runtimeServerBase = nextBase;
        try {
            if (typeof setRuntimeServerBase === 'function') {
                setRuntimeServerBase(nextBase);
            }
        } catch (_) {}
        return nextBase;
    }

    _getPreferredHttpBase() {
        return this.runtimeServerBase || getServerBase() || '';
    }

    _getClientGatewayFallbackBases() {
        const preferred = this._getPreferredHttpBase();
        if (!preferred) return [];
        try {
            const parsed = new URL(preferred);
            const candidates = [];
            const push = (value) => {
                const normalized = String(value || '').replace(/\/+$/, '');
                if (normalized && normalized !== preferred.replace(/\/+$/, '') && !candidates.includes(normalized)) {
                    candidates.push(normalized);
                }
            };

            // 59000 是统一控制入口；未登录状态下的公开客户端能力由同主机 58111 提供。
            parsed.port = '58111';
            push(parsed.toString());

            // 若控制入口带有自身路径，再尝试客户端网关根地址。
            if (parsed.pathname && parsed.pathname !== '/') {
                parsed.pathname = '/';
                parsed.search = '';
                parsed.hash = '';
                push(parsed.toString());
            }
            return candidates;
        } catch (_) {
            return [];
        }
    }

    /** @param {{path: string, method?: string, data?: any, timeoutMs?: number}} options */
    async _executeHttpRequest({
        path,
        method = 'POST',
        data,
        timeoutMs = NETWORK_DIAG_CONFIG.REQUEST_TIMEOUT,
    }) {
        return executeHttpRequest({
            getServerBase: () => this._getPreferredHttpBase(),
            getJson,
            postJson,
            path,
            method,
            data,
            timeoutMs,
        });
    }

    // 统一的 HTTP 请求入口：执行请求、同步服务器地址、并附带 transportMode。
    /** @param {{actionLabel?: string, path: string, method?: string, data?: any, timeoutMs?: number}} options */
    async _request({
        actionLabel,
        path,
        method = 'POST',
        data,
        timeoutMs = NETWORK_DIAG_CONFIG.REQUEST_TIMEOUT,
    }) {
        const result = await this._executeHttpRequest({ path, method, data, timeoutMs })
            .catch((error) => {
                console.warn(`[HTTP] ${actionLabel || path} 请求失败:`, error?.message || error);
                return {
                    ok: false,
                    status: 0,
                    error: error?.message || String(error),
                };
            });
        this._syncRuntimeServerBase(result);
        if (result && typeof result === 'object') {
            return { ...result, transportMode: 'http' };
        }
        return result;
    }

    /**
     * 网络连接诊断（HTTP 版本）
     * @returns {Promise<Object>} 诊断结果
     */
    async diagnoseConnection() {
        const results = {
            httpConnection: false,
            httpConnectionTime: 0,
            httpError: null,
            transportMode: 'http',
            recommendations: [],
        };

        const base = this._getPreferredHttpBase();
        if (!base) {
            results.httpError = 'HTTP服务器地址未配置';
            results.recommendations.push('尚未获取到服务器地址，请先登录账号');
            return results;
        }

        try {
            const startTime = Date.now();
            // 使用公开、轻量的公告接口作为 HTTP 连通性探针。
            const resp = await this._executeHttpRequest({
                path: '/api/user_announcement',
                method: 'GET',
                timeoutMs: NETWORK_DIAG_CONFIG.REQUEST_TIMEOUT,
            });
            results.httpConnectionTime = Date.now() - startTime;
            results.httpConnection = !!(resp && (resp.ok || resp.status));
            if (!results.httpConnection) {
                results.httpError = resp?.error || 'HTTP请求未返回有效响应';
            }
        } catch (error) {
            results.httpError = error?.message || String(error);
            results.recommendations.push('HTTP连接失败，请检查网络或服务器地址');
        }

        if (results.httpConnectionTime > 3000) {
            results.recommendations.push('HTTP连接耗时较长，建议检查网络质量');
        }

        return results;
    }

    /** Validate the signed-in account session. */
    async validateSession(sessionToken, deviceId) {
        return this._request({
            actionLabel: 'validateSession',
            path: '/api/account/session',
            method: 'POST',
            data: { session_token: sessionToken, device_id: deviceId },
        });
    }

    async logoutAccount(sessionToken) {
        return this._request({
            actionLabel: 'logoutAccount',
            path: '/api/account/logout',
            method: 'POST',
            data: { session_token: sessionToken },
        });
    }

    /**
     * 获取服务器当前公开的教程入口，不依赖账号验证状态。
     */
    async getTutorialUrl() {
        return this._request({
            actionLabel: 'getTutorialUrl',
            path: '/api/get_tutorial_url',
            method: 'GET',
        });
    }

    /**
     * 获取Cookie
     */
    async fetchCookie(sessionToken, platform, deviceId) {
        return this._request({
            actionLabel: 'fetchCookie',
            path: '/api/fetch_cookie',
            method: 'POST',
            data: { session_token: sessionToken, platform, device_id: deviceId },
        });
    }

    /**
     * 自助解绑设备
     */
    async unbindDevice(sessionToken, deviceId) {
        return this._request({
            actionLabel: 'unbindDevice',
            path: '/api/unbind_device',
            method: 'POST',
            data: { session_token: sessionToken, device_id: deviceId, deviceId },
        });
    }

    /**
     * 获取客户端配置
     * @param {string} sessionToken - 账号会话
     * @param {string} deviceId - 设备号
     */
    async getClientConfig(sessionToken, deviceId) {
        const qs = new URLSearchParams({
            session_token: String(sessionToken || ''),
            device_id: String(deviceId || ''),
        }).toString();
        const requestTimeoutMs = Math.max(NETWORK_DIAG_CONFIG.REQUEST_TIMEOUT * 4, 20000);

        const attempts = [
            {
                label: 'HTTP GET query',
                method: 'GET',
                path: `/api/client/config${qs ? `?${qs}` : ''}`,
            },
            {
                label: 'HTTP POST body',
                method: 'POST',
                path: '/api/client/config',
                data: { session_token: sessionToken, device_id: deviceId },
            },
        ];

        let lastError = null;
        for (const attempt of attempts) {
            try {
                console.log(`[HTTP] getClientConfig 尝试${attempt.label}`);
                const result = await this._executeHttpRequest({
                    path: attempt.path,
                    method: attempt.method,
                    data: attempt.data,
                    timeoutMs: requestTimeoutMs,
                });
                this._syncRuntimeServerBase(result);
                if (result && result.ok === true) {
                    return withHttpTransportMode(result);
                }
                lastError = new Error(getClientConfigResultError(result));
                // 非 ok 但已拿到响应对象时，仍返回该对象供上层判断。
                if (attempt === attempts[attempts.length - 1] && result && typeof result === 'object') {
                    return withHttpTransportMode(result);
                }
            } catch (error) {
                lastError = error;
                console.warn(`[HTTP] getClientConfig ${attempt.label}失败:`, error && error.message ? error.message : error);
            }
        }

        return {
            ok: false,
            status: 0,
            error: lastError && lastError.message ? lastError.message : 'HTTP获取客户端配置失败',
            transportMode: 'http',
        };
    }

    /**
     * 获取代理状态和流量信息
     */
    async getProxyStatus() {
        return this._request({
            actionLabel: 'getProxyStatus',
            path: '/api/get_proxy_status',
            method: 'GET',
        });
    }

    async getPacConfig(sessionToken, deviceId) {
        return this._request({
            actionLabel: 'getPacConfig',
            path: '/api/get_pac_config',
            method: 'POST',
            data: { session_token: sessionToken, device_id: deviceId },
        });
    }

    async controlProxy(sessionToken, deviceId, action) {
        return this._request({
            actionLabel: 'controlProxy',
            path: '/api/control_proxy',
            method: 'POST',
            data: { session_token: sessionToken, device_id: deviceId, action },
        });
    }

    async getAIControlModels(sessionToken, deviceId) {
        const primary = await this._request({
            actionLabel: 'getAIControlModels',
            path: '/api/ai-control/models',
            method: 'POST',
            data: { session_token: sessionToken, device_id: deviceId },
        });
        if (primary?.ok) return primary;

        let lastResult = primary;
        for (const base of this._getClientGatewayFallbackBases()) {
            console.log(`[HTTP] getAIControlModels 回退客户端网关: ${base}`);
            const result = await executeHttpRequest({
                getServerBase: () => base,
                getJson,
                postJson,
                path: '/api/ai-control/models',
                method: 'POST',
                data: { session_token: sessionToken, device_id: deviceId },
                timeoutMs: NETWORK_DIAG_CONFIG.REQUEST_TIMEOUT,
            }).catch((error) => ({
                ok: false,
                status: 0,
                error: error?.message || String(error),
            }));
            lastResult = result;
            if (result?.ok) {
                return { ...result, transportMode: 'http' };
            }
        }
        return lastResult && typeof lastResult === 'object'
            ? { ...lastResult, transportMode: 'http' }
            : primary;
    }

    async redeemAIControlGiftCode(sessionToken, deviceId, code) {
        return this._request({
            actionLabel: 'redeemAIControlGiftCode',
            path: '/api/ai-control/gift-codes/redeem',
            method: 'POST',
            data: { session_token: sessionToken, device_id: deviceId, code },
        });
    }

    async redeemWoolGiftCode(sessionToken, deviceId, code) {
        return this._request({
            actionLabel: 'redeemWoolGiftCode',
            path: '/api/wool-gift-codes/redeem',
            method: 'POST',
            data: { session_token: sessionToken, device_id: deviceId, code },
        });
    }

    async redeemVipGiftCode(sessionToken, deviceId, code) {
        return this._request({
            actionLabel: 'redeemVipGiftCode',
            path: '/api/vip-gift-codes/redeem',
            method: 'POST',
            data: { session_token: sessionToken, device_id: deviceId, code },
        });
    }

    async getVipPlans(sessionToken, deviceId) {
        return this._request({
            actionLabel: 'getVipPlans',
            path: '/api/vip/plans',
            method: 'POST',
            data: { session_token: sessionToken, device_id: deviceId },
        });
    }

    async getProxyTrafficQuota(sessionToken, deviceId) {
        return this._request({
            actionLabel: 'getProxyTrafficQuota',
            path: '/api/proxy/client/quota',
            method: 'POST',
            data: { session_token: sessionToken, device_id: deviceId },
        });
    }

    async createProxyTrafficSession(sessionToken, deviceId) {
        return this._request({
            actionLabel: 'createProxyTrafficSession',
            path: '/api/proxy/client/session',
            method: 'POST',
            data: { session_token: sessionToken, device_id: deviceId },
        });
    }

    async reportProxyTraffic(data) {
        return this._request({
            actionLabel: 'reportProxyTraffic',
            path: '/api/proxy/client/usage',
            method: 'POST',
            data,
            timeoutMs: 15000,
        });
    }

    async redeemProxyTrafficGiftCode(sessionToken, deviceId, code) {
        return this._request({
            actionLabel: 'redeemProxyTrafficGiftCode',
            path: '/api/proxy/gift-codes/redeem',
            method: 'POST',
            data: { session_token: sessionToken, device_id: deviceId, code },
        });
    }

    async sendAIControlMessage(sessionToken, deviceId, modelId, messages, options = {}) {
        return this._request({
            actionLabel: 'sendAIControlMessage',
            path: '/api/ai-control/chat',
            method: 'POST',
            data: {
                session_token: sessionToken,
                device_id: deviceId,
                model_id: modelId,
                messages,
                tools: Array.isArray(options.tools) ? options.tools : [],
                run_id: String(options.runId || ''),
            },
            timeoutMs: 120000,
        });
    }

    async streamAIControlMessage(sessionToken, deviceId, modelId, messages, options = {}, onEvent) {
        const base = this._getPreferredHttpBase();
        if (!base) return { ok: false, message: 'HTTP服务器地址未配置' };
        const url = `${base.replace(/\/+$/, '')}/api/ai-control/chat/stream`;
        try {
            return await postEventStream(url, {
                session_token: sessionToken,
                device_id: deviceId,
                model_id: modelId,
                messages,
                tools: Array.isArray(options.tools) ? options.tools : [],
                run_id: String(options.runId || ''),
            }, onEvent, 240000, { signal: options.signal });
        } catch (error) {
            console.warn('[HTTP] streamAIControlMessage 请求失败:', error?.message || error);
            return { ok: false, message: error?.message || String(error) };
        }
    }

    /**
     * 关闭连接（HTTP 模式下无持久连接，保留为兼容 no-op）
     */
    close() {}
}

// 创建全局 HTTP 客户端实例
/** @type {HttpClient | null} */
let globalHttpClient = null;

// Update the shared HTTP client options.
function updateGlobalHttpClientOptions(opts = {}) {
    const optionRecord = /** @type {Record<string, any>} */ (opts);
    if (Object.prototype.hasOwnProperty.call(optionRecord, 'mainWindow')) {
        globalHttpClient.mainWindow = optionRecord.mainWindow;
    }
}

// Return the shared HTTP client instance.
function ensureGlobalHttpClient(options = {}) {
    const opts = (options && typeof options === 'object') ? options : { mainWindow: options };
    if (!globalHttpClient) {
        globalHttpClient = new HttpClient(opts);
    }
    updateGlobalHttpClientOptions(opts);
    return globalHttpClient;
}

// Create or reuse the shared HTTP client.
function createHttpClient(options = {}) {
    return ensureGlobalHttpClient(options);
}

module.exports = {
    createHttpClient,
    normalizeValidationRuntimeConfig,
};
