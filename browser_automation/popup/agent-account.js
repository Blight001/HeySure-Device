// popup/agent-account.js — 服务器同步 UI（登录 / 连接 / AI 分配 / 选项）
// 通过 chrome.runtime.sendMessage 与 background/09_agent_socket.js 通信：登录后自动连接，
// 状态经 background 主动推送的 agent:status 消息实时刷新头部状态条。

(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const statusDot = $('agent-status-dot');
    const statusLabel = $('agent-status-label');
    const accountName = $('agent-account-name');
    const accountAva = $('agent-account-ava');
    const modal = $('agent-modal');
    const chip = $('agent-account-chip');

    if (!statusDot || !modal || !chip) {
        return; // 页面未包含同步 UI（异常布局）时安全退出。
    }

    const loginCard = $('agent-login-card');
    const accountCard = $('agent-account-card');
    const serverInput = $('agent-server-url');
    const accountInput = $('agent-account');
    const passwordInput = $('agent-password');
    const rememberInput = $('agent-remember');
    const loginBtn = $('agent-login-btn');
    const loginFeedback = $('agent-login-feedback');
    const currentAccount = $('agent-current-account');
    const connectBtn = $('agent-connect-btn');
    const disconnectBtn = $('agent-disconnect-btn');
    const logoutBtn = $('agent-logout-btn');
    const mouseFxInput = $('agent-mousefx');
    const nameInput = $('agent-name');
    const saveOptionsBtn = $('agent-save-options');
    const optionsFeedback = $('agent-options-feedback');
    const connStatus = $('agent-conn-status');
    const aiStatus = $('agent-ai-status');

    function send(message) {
        try {
            return chrome.runtime.sendMessage(message);
        } catch (error) {
            return Promise.reject(error);
        }
    }

    function feedback(node, text, ok) {
        if (!node) return;
        node.textContent = text || '';
        node.className = `agent-feedback ${text ? (ok ? 'is-ok' : 'is-err') : ''}`.trim();
    }

    const STATUS_LABELS = {
        disconnected: '未连接',
        connecting: '连接中',
        connected: '已连接',
        registered: '已连接',
        error: '连接错误'
    };

    function applyStatus(state) {
        const status = (state && state.status) || 'disconnected';
        const bound = state && state.boundAiConfigId;
        const hasAi = bound != null;
        let cls = 'is-red';
        let label = STATUS_LABELS[status] || '未连接';

        if (status === 'registered' || status === 'connected') {
            cls = hasAi ? 'is-green' : 'is-yellow';
            label = hasAi ? '已连接 · 已分配AI' : '已连接 · 未分配AI';
        } else if (status === 'connecting') {
            cls = 'is-yellow';
        }

        statusDot.className = `agent-status-dot ${cls}`;
        statusLabel.textContent = label;

        if (connStatus) {
            connStatus.textContent = status === 'registered'
                ? '已注册到服务器'
                : status === 'connected'
                    ? '已连接（注册中）'
                    : status === 'connecting'
                        ? '连接中…'
                        : status === 'error'
                            ? '连接错误'
                            : '未连接到服务器';
        }
        if (aiStatus) {
            aiStatus.textContent = hasAi ? `已分配（#${bound}）` : '未分配';
        }
    }

    function applyAuth(auth) {
        const loggedIn = !!(auth && auth.loggedIn);
        const name = (auth && (auth.userName || auth.account)) || '未登录';
        accountName.textContent = loggedIn ? name : '未登录';
        if (accountAva) {
            if (loggedIn && auth.avatar) {
                accountAva.innerHTML = `<img src="${auth.avatar}" alt="">`;
            } else {
                accountAva.textContent = loggedIn ? (name.slice(0, 1) || '·') : '·';
            }
        }
        if (loginCard) loginCard.classList.toggle('is-hidden', loggedIn);
        if (accountCard) accountCard.classList.toggle('is-hidden', !loggedIn);
        if (currentAccount) currentAccount.textContent = (auth && auth.account) || '-';
        if (rememberInput && auth) rememberInput.checked = auth.rememberLogin === true;
        if (loggedIn && accountInput && !accountInput.value) accountInput.value = (auth && auth.account) || '';
    }

    function applySettings(settings) {
        if (!settings) return;
        if (serverInput && !serverInput.value) serverInput.value = settings.serverUrl || '';
        if (mouseFxInput) mouseFxInput.checked = settings.mouseFx !== false;
        if (nameInput && !nameInput.value) nameInput.value = settings.agentName || '';
    }

    async function refreshState() {
        try {
            const res = await send({ type: 'agent:get-state' });
            if (!res || !res.ok) return;
            applyStatus(res);
            applyAuth(res.auth);
            applySettings(res.settings);
        } catch (_error) {}
    }

    function openModal() {
        modal.classList.remove('is-hidden');
        feedback(loginFeedback, '');
        feedback(optionsFeedback, '');
        void refreshState();
    }

    function closeModal() {
        modal.classList.add('is-hidden');
    }

    chip.addEventListener('click', openModal);
    const closeBtn = $('agent-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    if (loginBtn) {
        loginBtn.addEventListener('click', async () => {
            const serverUrl = (serverInput && serverInput.value.trim()) || '';
            const account = (accountInput && accountInput.value.trim()) || '';
            const password = (passwordInput && passwordInput.value) || '';
            const rememberLogin = !!(rememberInput && rememberInput.checked);
            if (!account || !password) {
                feedback(loginFeedback, '请填写账号和密码', false);
                return;
            }
            feedback(loginFeedback, '登录中…', true);
            loginBtn.disabled = true;
            try {
                if (serverUrl) {
                    await send({ type: 'agent:save-settings', payload: { serverUrl } });
                }
                const res = await send({ type: 'agent:login', payload: { account, password, rememberLogin } });
                if (res && res.ok) {
                    feedback(loginFeedback, '登录成功，正在连接…', true);
                    if (passwordInput && !rememberLogin) passwordInput.value = '';
                    await refreshState();
                } else {
                    feedback(loginFeedback, (res && res.error) || '登录失败', false);
                }
            } catch (error) {
                feedback(loginFeedback, error && error.message ? error.message : '登录失败', false);
            } finally {
                loginBtn.disabled = false;
            }
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            await send({ type: 'agent:logout' }).catch(() => {});
            if (passwordInput) passwordInput.value = '';
            await refreshState();
        });
    }

    if (connectBtn) {
        connectBtn.addEventListener('click', async () => {
            await send({ type: 'agent:connect' }).catch(() => {});
            await refreshState();
        });
    }

    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', async () => {
            await send({ type: 'agent:disconnect' }).catch(() => {});
            await refreshState();
        });
    }

    if (saveOptionsBtn) {
        saveOptionsBtn.addEventListener('click', async () => {
            const payload = {
                mouseFx: !!(mouseFxInput && mouseFxInput.checked),
                agentName: (nameInput && nameInput.value.trim()) || ''
            };
            const serverUrl = (serverInput && serverInput.value.trim()) || '';
            if (serverUrl) payload.serverUrl = serverUrl;
            try {
                const res = await send({ type: 'agent:save-settings', payload });
                feedback(optionsFeedback, res && res.ok ? '已保存 ✓' : ((res && res.error) || '保存失败'), !!(res && res.ok));
            } catch (error) {
                feedback(optionsFeedback, error && error.message ? error.message : '保存失败', false);
            }
            setTimeout(() => feedback(optionsFeedback, ''), 2200);
        });
    }

    // 后台主动推送的连接状态。
    chrome.runtime.onMessage.addListener((message) => {
        if (message && message.type === 'agent:status') {
            applyStatus(message);
        }
        return false;
    });

    void refreshState();
})();
