  async function bootstrapHistory() {
    try {
      await refreshHistoryList();
    } catch (error) {
      console.warn('[AI 控制] 初始化历史失败:', error?.message || error);
    }
    // 启动与账号刷新只补齐历史列表，不恢复上次会话。异步恢复会在用户已经
    // 新建或开始输入后覆盖当前状态，表现为对话自动跳回旧会话。
    if (!state.currentSession) await startNewConversation({ skipSave: true });
  }

  function bindAiHeaderEvents() {
    const resizeOpenBrowserMenu = () => {
      updateBrowserMenuAvailableHeight(document.querySelector('.ai-browser-gear-select.open'));
    };
    window.addEventListener('resize', resizeOpenBrowserMenu);
    window.visualViewport?.addEventListener?.('resize', resizeOpenBrowserMenu);
    el('ai-chat-redeem-gift')?.addEventListener('click', redeemGiftCode);
    el('ai-chat-gift-code')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        redeemGiftCode();
      }
    });
    window.addEventListener('ai-control-quota-updated', (event) => {
      state.lastQuotaCost = null;
      renderQuota(event?.detail || null);
      syncSendState();
    });
    el('ai-chat-model')?.addEventListener('change', () => {
      state.lastQuotaCost = null;
      renderQuota(state.quota);
      syncSendState();
      if (state.currentSession) {
        state.currentSession.modelId = String(el('ai-chat-model')?.value || '');
        if (currentMessages().length) void persistCurrentSession();
      }
    });
    el('ai-custom-api-form')?.addEventListener('submit', saveCustomApi);
    el('ai-custom-api-clear')?.addEventListener('click', clearCustomApi);
    document.querySelectorAll('[data-ai-custom-api-close]').forEach((button) => {
      button.addEventListener('click', closeCustomApiDialog);
    });
    document.querySelectorAll('[data-ai-prompt-diagnostics-close]').forEach((button) => {
      button.addEventListener('click', closePromptDiagnostics);
    });
    el('ai-prompt-diagnostics-refresh')?.addEventListener('click', refreshPromptDiagnostics);
  }

  function bindBrowserSelection() {
    el('ai-chat-browser')?.addEventListener('change', (event) => {
      state.currentBrowserIds = getSelectBrowserIds(event.target).slice(0, 1);
      state.browserSelectionTouched = true;
      state.browserSelectionExplicitlyDisabled = !state.currentBrowserIds.length;
      if (state.currentSession) {
        state.currentSession.browserConnectionId = state.currentBrowserIds[0] || '';
        state.currentSession.browserConnectionIds = [...state.currentBrowserIds];
        if (currentMessages().length) void persistCurrentSession();
      }
      if (!currentMessages().length) renderWelcome();
      notifyBrowserSelection();
      syncSendState();
    });
  }

  function bindChatForm() {
    el('ai-chat-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (state.loading) stopAIOutput();
      else sendMessage();
    });
  }

  function handleCompositionEnd(chatInput, event) {
    const unexpectedlyCleared = !state.aiInputCompositionCancelled
      && !String(event.data || '')
      && chatInput.value === state.aiInputCompositionBase
      && state.aiInputCompositionDraft !== state.aiInputCompositionBase;
    if (unexpectedlyCleared) chatInput.value = state.aiInputCompositionDraft;
    state.aiInputComposing = false;
    state.aiInputCompositionBase = '';
    state.aiInputCompositionDraft = '';
    state.aiInputCompositionCancelled = false;
    delete document.documentElement.dataset.aiInputComposing;
    resizeInput();
    syncSendState();
    flushDeferredAiControlRefresh();
  }

  function bindChatInput() {
    const chatInput = el('ai-chat-input');
    // 用户点击文本框时由全局侧栏输入路由统一处理原生焦点，避免这里再发起
    // 第二套主页面 → 侧栏焦点切换。程序化聚焦仍通过 reclaimAiInputFocus。
    chatInput?.addEventListener('input', () => {
      if (state.aiInputComposing) {
        state.aiInputCompositionDraft = chatInput.value;
      }
      resizeInput();
      syncSendState();
      if (!chatInput.value) flushDeferredAiControlRefresh();
    });
    chatInput?.addEventListener('compositionstart', () => {
      state.aiInputComposing = true;
      state.aiInputCompositionBase = chatInput.value;
      state.aiInputCompositionDraft = chatInput.value;
      state.aiInputCompositionCancelled = false;
      document.documentElement.dataset.aiInputComposing = 'true';
    });
    chatInput?.addEventListener('compositionend', (event) => handleCompositionEnd(chatInput, event));
    chatInput?.addEventListener('blur', () => {
      window.setTimeout(flushDeferredAiControlRefresh, 0);
    });
    chatInput?.addEventListener('keydown', (event) => {
      if (state.aiInputComposing && event.key === 'Escape') {
        state.aiInputCompositionCancelled = true;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing
        && event.keyCode !== 229 && !state.aiInputComposing) {
        event.preventDefault();
        sendMessage();
      }
    });
    window.setTimeout(() => {
      if (document.getElementById('ai-control-panel')?.classList.contains('active')) {
        reclaimAiInputFocus(chatInput);
      }
    }, 150);
  }

  function bindAiPanelRefresh() {
    document.querySelector('[data-tab="ai-control-panel"]')?.addEventListener('click', () => {
      loadModels();
      loadBrowserConnections();
      loadAutomationCards(state.currentSession?.automationCardId || '');
      void refreshHistoryList();
      window.setTimeout(() => reclaimAiInputFocus(el('ai-chat-input')), 50);
    });
    window.aiFree?.account?.onSessionUpdated?.(() => {
      if (aiInputHasActiveDraft()) {
        state.accountSessionRefreshQueued = true;
        return;
      }
      loadModels();
      loadBrowserConnections();
      loadAutomationCards(state.currentSession?.automationCardId || '');
      void bootstrapHistory();
    });
  }

  function startAiControlPolling() {
    loadModels();
    loadBrowserConnections();
    loadAutomationCards();
    void bootstrapHistory();
    // 保留连接离线和外部卡片修改的发现速度；两个加载函数内部先比对快照，
    // 数据未变化时不会重建菜单、欢迎页或重复广播主窗口状态。
    window.setInterval(loadBrowserConnections, 750);
    window.setInterval(loadAutomationCards, 1000);
  }

  // 正常关闭/刷新时再做一次同步本地检查点；即使 IPC 来不及完成，消息也不会丢失。
  window.addEventListener('pagehide', () => {
    if (currentMessages().length) checkpointCurrentSession();
  });

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('ai-control-panel')) return;
    initCustomSelects();
    bindAiHeaderEvents();
    bindBrowserSelection();
    bindChatForm();
    bindChatInput();
    bindAiPanelRefresh();
    startAiControlPolling();
  });
