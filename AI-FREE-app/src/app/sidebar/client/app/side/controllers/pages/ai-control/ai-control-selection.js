  function normalizeBrowserIds(list) {
    return [...new Set((Array.isArray(list) ? list : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean))];
  }

  function browserConnectionsSnapshot(connections) {
    return JSON.stringify((Array.isArray(connections) ? connections : []).map((connection) => ({
      id: String(connection?.id || ''),
      profileId: String(connection?.profileId || ''),
      browserName: String(connection?.browserName || connection?.name || ''),
      toolCount: Number(connection?.toolCount || 0),
    })));
  }

  function automationCardsSnapshot(cards, selectedId) {
    return JSON.stringify({
      selectedId: String(selectedId || ''),
      cards: (Array.isArray(cards) ? cards : []).map((card) => ({
        id: String(card?.id || ''),
        name: String(card?.name || ''),
        stepCount: Number(card?.stepCount || 0),
        savedAt: String(card?.savedAt || ''),
      })),
    });
  }

  function sessionBrowserIds(session) {
    return normalizeBrowserIds(Array.isArray(session?.browserConnectionIds)
      ? session.browserConnectionIds
      : (session?.browserConnectionId ? [session.browserConnectionId] : [])).slice(0, 1);
  }

  function getSelectBrowserIds(select) {
    return Array.from(select?.selectedOptions || [])
      .map((option) => String(option.value || ''))
      .filter(Boolean)
      .slice(0, 1);
  }

  function setSelectBrowserIds(select, ids) {
    if (!select) return;
    const wanted = new Set(normalizeBrowserIds(ids).slice(0, 1));
    Array.from(select.options).forEach((option) => {
      option.selected = Boolean(option.value) && wanted.has(option.value);
    });
  }

  function notifyBrowserSelection() {
    const connectionIds = normalizeBrowserIds(state.currentBrowserIds);
    const profileIds = normalizeBrowserIds(
      connectionIds.map((id) => String(state.browserConnectionProfileById[id] || '')),
    );
    window.aiFree?.ai?.emitBrowserSelectionChanged?.({
      connectionId: connectionIds[0] || '',
      connectionIds,
      profileId: profileIds[0] || '',
      profileIds,
    });
  }

  function currentMessages() {
    return state.messages;
  }

  function aiInputHasActiveDraft() {
    const input = el('ai-chat-input');
    return input === document.activeElement
      && (state.aiInputComposing || Boolean(String(input?.value || '')));
  }

  function flushDeferredAiControlRefresh() {
    if (aiInputHasActiveDraft()) return;
    if (state.dynamicUiRefreshPending) {
      state.dynamicUiRefreshPending = false;
      syncSelectUi(el('ai-chat-browser'));
      if (!currentMessages().length) renderWelcome();
    }
    if (state.dynamicDataRefreshQueued) {
      state.dynamicDataRefreshQueued = false;
      void loadBrowserConnections();
      void loadAutomationCards(state.currentSession?.automationCardId || '');
    }
    if (state.accountSessionRefreshQueued) {
      state.accountSessionRefreshQueued = false;
      void loadModels();
      void loadBrowserConnections();
      void loadAutomationCards(state.currentSession?.automationCardId || '');
      void bootstrapHistory();
    }
  }

  function makeSessionId() {
    try {
      if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch (_) {}
    return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function historyLocalScope() {
    const username = String(el('account-username-display')?.value || '').trim();
    const deviceId = String(el('device-id')?.value || '').trim();
    return username || deviceId || 'local';
  }

  function readLocalHistoryStore() {
    try {
      const raw = localStorage.getItem(HISTORY_LS_PREFIX + historyLocalScope());
      if (!raw) return { version: 1, sessions: [], currentId: '' };
      const data = JSON.parse(raw);
      return {
        version: 1,
        sessions: Array.isArray(data?.sessions) ? data.sessions : [],
        currentId: String(data?.currentId || ''),
      };
    } catch (_) {
      return { version: 1, sessions: [], currentId: '' };
    }
  }

  function writeLocalHistoryStore(store) {
    try {
      localStorage.setItem(HISTORY_LS_PREFIX + historyLocalScope(), JSON.stringify({
        version: 1,
        sessions: Array.isArray(store?.sessions) ? store.sessions : [],
        currentId: String(store?.currentId || ''),
      }));
      return true;
    } catch (error) {
      console.warn('[AI 控制] localStorage 历史写入失败:', error?.message || error);
      return false;
    }
  }

  function selectionString(value, fallback = '') {
    return String(value || fallback);
  }

  function selectionTimestamp(value) {
    return Number(value) || Date.now();
  }

  function sessionSummaryLocal(session) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    return {
      id: selectionString(session?.id),
      title: selectionString(session?.title, '新对话'),
      titleGenerated: session?.titleGenerated === true,
      modelId: selectionString(session?.modelId),
      browserConnectionId: selectionString(session?.browserConnectionId),
      browserConnectionIds: sessionBrowserIds(session),
      automationCardId: selectionString(session?.automationCardId),
      preview: selectionString(session?.preview),
      messageCount: messages.length,
      createdAt: selectionTimestamp(session?.createdAt),
      updatedAt: selectionTimestamp(session?.updatedAt),
    };
  }

  function upsertLocalSession(session) {
    if (!session?.id) return;
    const store = readLocalHistoryStore();
    const next = {
      ...session,
      messages: Array.isArray(session.messages) ? session.messages : [],
      updatedAt: Date.now(),
    };
    // 对话内容被全部撤回/删除后，也要清掉之前落盘的旧记录。
    if (!next.messages.length) {
      deleteLocalSession(next.id);
      return;
    }
    const index = store.sessions.findIndex((item) => String(item.id) === String(next.id));
    if (index >= 0) store.sessions[index] = next;
    else store.sessions.unshift(next);
    store.sessions = store.sessions
      .filter((item) => Array.isArray(item.messages) && item.messages.length)
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    store.currentId = next.id;
    writeLocalHistoryStore(store);
  }

  function deleteLocalSession(sessionId) {
    const store = readLocalHistoryStore();
    const id = String(sessionId || '');
    store.sessions = store.sessions.filter((item) => String(item.id) !== id);
    if (store.currentId === id) store.currentId = store.sessions[0]?.id || '';
    writeLocalHistoryStore(store);
    return store;
  }

  function renameLocalSession(sessionId, title) {
    const store = readLocalHistoryStore();
    const id = String(sessionId || '');
    const session = store.sessions.find((item) => String(item.id) === id);
    if (!session) return null;
    session.title = String(title || '').trim().slice(0, 40);
    session.titleGenerated = true;
    writeLocalHistoryStore(store);
    return session;
  }

  function getLocalSession(sessionId) {
    const store = readLocalHistoryStore();
    const found = store.sessions.find((item) => String(item.id) === String(sessionId || ''));
    if (!found) return null;
    store.currentId = found.id;
    writeLocalHistoryStore(store);
    return found;
  }

  function setStatus(message, type = 'error') {
    const target = el('ai-chat-status');
    if (target) {
      target.textContent = '';
      target.dataset.type = '';
    }

    const text = String(message || '').trim();
    if (!text) return;

    const handlers = {
      warning: window.MessageModal?.showWarningMessage,
      info: window.MessageModal?.showInfoMessage,
      success: window.MessageModal?.showSuccessMessage,
      error: window.MessageModal?.showErrorMessage,
    };
    const handler = handlers[type] || handlers.error;
    if (handler) handler.call(window.MessageModal, text);
    else console.error('[AI 对话]', text);
  }

  function selectedModelIsCustom() {
    const option = el('ai-chat-model')?.selectedOptions?.[0];
    return option?.dataset?.customApi === 'true';
  }

  function closeCustomApiDialog() {
    const dialog = el('ai-custom-api-dialog');
    if (dialog) dialog.hidden = true;
    el('ai-chat-model-trigger')?.focus?.();
  }

  function updateCustomApiDialogBusy(busy) {
    state.customApiSaving = busy === true;
    el('ai-custom-api-form')?.querySelectorAll?.('input, button')?.forEach?.((control) => {
      control.disabled = state.customApiSaving;
    });
    const save = el('ai-custom-api-save');
    if (save) save.textContent = state.customApiSaving ? '保存中…' : '保存并使用';
  }

  function customApiAccessAllowed() {
    if (window.isSidebarVipActive?.() === true || state.vipActive === true) return true;
    window.openVipAccountCenter?.();
    return false;
  }

  function applyCustomApiDialogConfig(config) {
    state.customApiHasKey = config.hasApiKey === true;
    el('ai-custom-api-name').value = String(config.name || '自定义 API');
    el('ai-custom-api-base-url').value = String(config.baseUrl || '');
    el('ai-custom-api-key').value = '';
    el('ai-custom-api-key').placeholder = state.customApiHasKey ? '已保存，留空则保持不变' : '可选，支持无鉴权的本地接口';
    el('ai-custom-api-model').value = String(config.model || '');
    el('ai-custom-api-image-input').checked = config.supportsImageInput === true;
    el('ai-custom-api-clear').hidden = !config.enabled;
  }

  function customApiErrorMessage(error, fallback = '') {
    return String(error?.error || error?.message || fallback || error || '');
  }

  function handleCustomApiVipRequired(result) {
    if (!result?.vipRequired) return false;
    closeCustomApiDialog();
    window.openVipAccountCenter?.();
    return true;
  }

  async function openCustomApiDialog() {
    if (!customApiAccessAllowed()) return;
    const dialog = el('ai-custom-api-dialog');
    const status = el('ai-custom-api-status');
    const getCustomApi = window.aiFree?.ai?.getCustomApi;
    if (!dialog || !getCustomApi) return;
    if (status) status.textContent = '';
    dialog.hidden = false;
    showAiConfigPage('custom');
    updateCustomApiDialogBusy(true);
    try {
      const result = await getCustomApi();
      if (handleCustomApiVipRequired(result)) return;
      if (!result?.ok) throw new Error(customApiErrorMessage(result, '读取自定义 API 失败'));
      applyCustomApiDialogConfig(result.config || {});
    } catch (error) {
      if (status) status.textContent = customApiErrorMessage(error);
    } finally {
      updateCustomApiDialogBusy(false);
      el('ai-custom-api-base-url')?.focus?.();
    }
  }

  function buildCustomApiPayload() {
    const payload = {
      enabled: true,
      name: String(el('ai-custom-api-name')?.value || '').trim(),
      baseUrl: String(el('ai-custom-api-base-url')?.value || '').trim(),
      model: String(el('ai-custom-api-model')?.value || '').trim(),
      supportsImageInput: el('ai-custom-api-image-input')?.checked === true,
    };
    const apiKey = String(el('ai-custom-api-key')?.value || '').trim();
    if (apiKey || !state.customApiHasKey) payload.apiKey = apiKey;
    return payload;
  }

  async function saveCustomApi(event) {
    event?.preventDefault?.();
    const setCustomApi = window.aiFree?.ai?.setCustomApi;
    if (state.customApiSaving || !setCustomApi) return;
    const status = el('ai-custom-api-status');
    if (status) status.textContent = '';
    const payload = buildCustomApiPayload();
    updateCustomApiDialogBusy(true);
    try {
      const result = await setCustomApi(payload);
      if (!result?.ok) throw new Error(customApiErrorMessage(result, '保存自定义 API 失败'));
      closeCustomApiDialog();
      await loadModels('__custom_openai_api__');
      setStatus('自定义 API 已保存并选中', 'success');
    } catch (error) {
      if (status) status.textContent = customApiErrorMessage(error);
    } finally {
      updateCustomApiDialogBusy(false);
    }
  }

  async function clearCustomApi() {
    if (state.customApiSaving || !window.aiFree?.ai?.setCustomApi) return;
    updateCustomApiDialogBusy(true);
    try {
      const result = await window.aiFree.ai.setCustomApi({ clear: true });
      if (!result?.ok) throw new Error(result?.error || result?.message || '移除自定义 API 失败');
      closeCustomApiDialog();
      await loadModels();
      setStatus('自定义 API 配置已移除', 'success');
    } catch (error) {
      const status = el('ai-custom-api-status');
      if (status) status.textContent = error?.message || String(error);
    } finally {
      updateCustomApiDialogBusy(false);
    }
  }

  function confirmDestructiveAction(message, onConfirm) {
    const run = async () => {
      try {
        await onConfirm();
      } catch (error) {
        setStatus(error?.message || String(error), 'warning');
      }
    };
    const modal = window.MessageModal;
    if (modal?.showConfirmDialog) {
      modal.showConfirmDialog(message, run, null, 'warning');
      return;
    }
    // 弹窗模块尚未就绪时保留浏览器原生确认，避免无确认直接执行破坏性操作。
    if (typeof window.confirm === 'function' && window.confirm(message)) {
      void run();
    }
  }

  function isQuotaFailure(message) {
    return /AI\s*对话额度(?:不足|已用尽)|对话额度(?:不足|已用尽)|额度(?:不足|已用尽).*联系管理员/.test(String(message || ''));
  }

  function isQuotaExhausted(quota = state.quota) {
    if (!quota || quota.unlimited === true) return false;
    const total = Number(quota.quota);
    const used = Number(quota.used || 0);
    const remaining = Number(quota.remaining ?? (total - used));
    return Number.isFinite(remaining) && remaining <= 0;
  }

  function showChatBusinessError(message) {
    const text = String(message || '对话请求失败');
    if (window.MessageModal?.showWarningMessage) {
      window.MessageModal.showWarningMessage(text);
      return;
    }
    setStatus(text);
  }

  function formatQuota(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return '0';
    if (Number.isInteger(number)) return String(number);
    return number.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  }

  function selectedModelMultiplier() {
    const option = el('ai-chat-model')?.selectedOptions?.[0];
    const multiplier = Number(option?.dataset?.quotaMultiplier || 0);
    return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 0;
  }

  function provisionalTitle(text) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return '新对话';
    return cleaned.slice(0, 20) + (cleaned.length > 20 ? '…' : '');
  }

  function sanitizeGeneratedTitle(raw) {
    let title = String(raw || '').trim();
    title = title.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
    title = title
      .replace(/^["'「『【\[]+|["'」』】\]]+$/g, '')
      .replace(/^(标题|题目)[:：\s]*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) return '';
    return title.slice(0, 24);
  }

  function formatRelativeTime(ts) {
    const time = Number(ts) || 0;
    if (!time) return '';
    const diff = Date.now() - time;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 86_400_000 * 7) return `${Math.floor(diff / 86_400_000)} 天前`;
    try {
      return new Date(time).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_) {
      return '';
    }
  }

  /* ---------------- 自定义下拉 ---------------- */
