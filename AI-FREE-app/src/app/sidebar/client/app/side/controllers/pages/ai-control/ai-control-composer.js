  function resizeInput() {
    const input = el('ai-chat-input');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
  }

  function focusElement(input) {
    if (!input) return;
    try {
      input.focus({ preventScroll: true });
    } catch (_) {
      try { input.focus(); } catch (__) {}
    }
  }

  /**
   * 侧栏是 WebContentsView：OS/Chromium 子窗口可能抢走键盘焦点，
   * 而 DOM 仍显示 textarea:focus，表现为“已聚焦但无法输入”。
   * 这里通过主进程把键盘焦点拉回侧栏 webContents，再回焦输入框。
   */
  function reclaimAiInputFocus(input) {
    if (!input || state._aiInputReclaiming) return;
    if (!window.aiFree?.ui?.focusSidebarInput) {
      focusElement(input);
      return;
    }

    const now = Date.now();
    // 短防抖：pointerdown/click 连续触发时只回收一次
    if (state._aiInputReclaimAt && now - state._aiInputReclaimAt < 120) return;
    state._aiInputReclaimAt = now;

    const token = Symbol('ai-input-focus');
    state._aiInputFocusToken = token;
    state._aiInputReclaiming = true;

    const refocus = () => {
      if (state._aiInputFocusToken !== token) return;
      if (aiInputHasActiveDraft()) return;
      // 若用户已点到别处，不要强行抢回
      if (document.activeElement && document.activeElement !== input) {
        const active = document.activeElement;
        if (active !== document.body && active !== document.documentElement) return;
      }
      focusElement(input);
    };

    // 等本轮 click 的原生聚焦完成后再向主进程要键盘焦点，避免互相打架
    window.setTimeout(() => {
      if (state._aiInputFocusToken !== token) {
        state._aiInputReclaiming = false;
        return;
      }
      void window.aiFree.ui.focusSidebarInput({ interaction: 'text-input' }).then(() => {
        refocus();
        state._aiInputReclaiming = false;
      }).catch((error) => {
        console.warn('[AI 控制] 恢复输入框焦点失败:', error?.message || error);
        refocus();
        state._aiInputReclaiming = false;
      });
    }, 0);
  }

  function openPersonalLogin() {
    window.openAccountCenterPanel?.();
  }

  async function ensureAuthenticatedForChat() {
    try {
      const session = await window.aiFree?.account?.getSession?.();
      state.accountAuthenticated = session?.authenticated === true;
      syncSendState();
      if (state.accountAuthenticated) return true;
    } catch (_) {}
    state.accountAuthenticated = false;
    syncSendState();
    openPersonalLogin();
    return false;
  }

  async function insertMessageDuringRun(content, input) {
    if (!state.activeRequestId || state.stopping) return;
    const messages = currentMessages();
    messages.push({ role: 'user', content });
    appendMessage('user', content, { messageIndex: messages.length - 1 });
    if (input) {
      input.value = '';
      resizeInput();
      flushDeferredAiControlRefresh();
    }
    syncSendState();
    // 用户输入先同步写入 localStorage，再通知正在运行的服务端会话。
    void persistCurrentSession();
    try {
      const result = await window.aiFree.ai.chatInsert({
        requestId: state.activeRequestId,
        content,
      });
      if (!result?.ok) throw new Error(result?.message || '当前 AI 回复已经结束');
    } catch (error) {
      const message = error?.message || String(error);
      messages.push({ role: 'assistant', content: `请求失败：${message}` });
      appendMessage('assistant', `请求失败：${message}`);
      await persistCurrentSession();
      setStatus(message, 'warning');
      syncSendState();
    }
  }

  async function stopAIOutput() {
    if (!state.loading || !state.activeRequestId || state.stopping) return;
    state.stopping = true;
    syncSendState();
    try {
      await window.aiFree.ai.chatStop({
        requestId: state.activeRequestId,
      });
    } catch (error) {
      state.stopping = false;
      syncSendState();
      setStatus(error?.message || String(error));
    }
  }

  async function refreshQuotaBeforeSend(useCustomApi) {
    if (useCustomApi) return;
    try {
      const result = await window.aiFree?.ai?.getModels?.();
      if (result?.quota) renderQuota(result.quota);
    } catch (_) {}
  }

  function prepareChatSend(input, select, content) {
    const useCustomApi = selectedModelIsCustom();
    if (!select?.value) return null;
    ensureSessionForSend();
    const messages = currentMessages();
    const wasFirstExchange = !messages.some((message) => message.role === 'assistant' && String(message.content || '').trim());
    messages.push({ role: 'user', content });
    appendMessage('user', content, { messageIndex: messages.length - 1 });
    updateSessionTitleUi();
    input.value = '';
    resizeInput();
    flushDeferredAiControlRefresh();
    state.loading = true;
    state.stopping = false;
    setStatus('');
    const run = { content, input, messages, select, useCustomApi, wasFirstExchange };
    updateCurrentSessionAfterChat(run);
    syncSendState();
    // 本地写入在函数首次 await 前同步完成；主进程文件保存排队在后台，不阻塞请求发送。
    void persistCurrentSession();
    return run;
  }

  function handleInsertedStreamMessage(run) {
    run.insertedDuringRun = true;
    run.streamView?.finalize();
    run.streamView = createAssistantView({ pending: true });
  }

  const chatStreamHandlers = {
    round_start: (run, event) => run.streamView?.addReasoning('', event.round),
    reasoning_delta: (run, event) => run.streamView?.addReasoning(event.delta, event.round),
    content_delta: (run, event) => run.streamView?.addContent(event.delta, event.round),
    content_replace: (run, event) => run.streamView?.replaceContent(event.content, event.round),
    tool_start: (run, event) => run.streamView?.upsertTool(event.tool || {}, event.round),
    tool_result: (run, event) => run.streamView?.upsertTool(event.tool || {}, event.round),
    browser_control_changed: (_run, event) => applyControlledBrowser(event.connectionId),
    user_inserted: (run) => handleInsertedStreamMessage(run),
  };

  function applyControlledBrowser(connectionId) {
    const id = String(connectionId || '').trim();
    if (!id || !state.availableBrowserIds.includes(id)) return;
    state.currentBrowserIds = [id];
    setSelectBrowserIds(el('ai-chat-browser'), [id]);
    syncSelectUi(el('ai-chat-browser'));
    notifyBrowserSelection();
  }

  function handleChatStreamEvent(run, event) {
    if (!event || event.requestId !== run.requestId) return;
    chatStreamHandlers[event.type]?.(run, event);
  }

  function subscribeChatStream(run) {
    run.streamView = createAssistantView({ pending: true });
    run.insertedDuringRun = false;
    return window.aiFree?.ai?.onChatEvent?.((event) => handleChatStreamEvent(run, event));
  }

  function buildChatRequest(run) {
    return {
      modelId: run.select.value,
      messages: run.messages,
      quota: run.useCustomApi ? null : state.quota,
      browserConnectionId: state.currentBrowserIds[0] || '',
      browserConnectionIds: [...state.currentBrowserIds],
      automationCardId: state.currentCardId,
      stream: true,
      requestId: run.requestId,
    };
  }

  function handleChatBusinessFailure(result) {
    const message = String(result?.message || result?.error || '对话请求失败');
    if (/请先.*登录|未登录/.test(message)) {
      openPersonalLogin();
    }
    if (isQuotaFailure(message)) {
      if (result?.quota) renderQuota(result.quota);
      showChatBusinessError(message);
    }
  }

  function applyReturnedMessages(run, result) {
    if (Array.isArray(result.messages) && result.messages.length) {
      state.messages = result.messages;
      return;
    }
    run.messages.push({ role: 'assistant', content: String(result.message?.content || '').trim() });
  }

  function applyFinalAssistantMetadata(result) {
    const finalAssistant = [...state.messages].reverse().find((item) => item?.role === 'assistant');
    if (!finalAssistant) return;
    finalAssistant.reasoning = String(result.message?.reasoning || '');
    finalAssistant.tool_events = Array.isArray(result.message?.tool_events) ? result.message.tool_events : [];
    finalAssistant.trace_events = Array.isArray(result.message?.trace_events) ? result.message.trace_events : [];
  }

  function updateCurrentSessionAfterChat(run) {
    if (!state.currentSession) return;
    state.currentSession.modelId = run.select.value;
    state.currentSession.browserConnectionId = state.currentBrowserIds[0] || '';
    state.currentSession.browserConnectionIds = [...state.currentBrowserIds];
    state.currentSession.automationCardId = state.currentCardId;
    if (!state.currentSession.title || state.currentSession.title === '新对话') {
      state.currentSession.title = provisionalTitle(run.content);
    }
  }

  async function applyChatResult(run, result) {
    applyControlledBrowser(result.browserConnectionId);
    applyReturnedMessages(run, result);
    const replyText = String(result.message?.content || '').trim();
    applyFinalAssistantMetadata(result);
    state.lastQuotaCost = result.quota_cost ?? result.quota_cost_increment ?? null;
    renderQuota(run.useCustomApi ? state.quota : (result.quota || state.quota));
    updateCurrentSessionAfterChat(run);
    if (result.stopped) {
      run.streamView?.finalize();
      renderConversation();
      await persistCurrentSession();
      return;
    }
    run.streamView?.setContent(replyText || '模型未返回内容');
    run.streamView?.finalize();
    if (run.insertedDuringRun) renderConversation();
    await persistCurrentSession();
    if (run.wasFirstExchange) void maybeGenerateTitle(run.select.value);
  }

  async function handleChatSendError(run, error) {
    const message = error?.message || String(error);
    const failureContent = `请求失败：${message}`;
    run.messages.push({ role: 'assistant', content: failureContent });
    run.streamView?.setContent(failureContent);
    run.streamView?.finalize();
    updateCurrentSessionAfterChat(run);
    await persistCurrentSession();
    setStatus(message);
  }

  async function requestChatResult(run) {
    if (!run.useCustomApi && !await ensureAuthenticatedForChat()) {
      throw new Error('请先在个人中心登录账号');
    }
    await refreshQuotaBeforeSend(run.useCustomApi);
    if (!run.useCustomApi && isQuotaExhausted()) {
      throw new Error('AI 对话额度已用尽，请联系管理员');
    }
    const result = await window.aiFree.ai.chat(buildChatRequest(run));
    if (result?.ok) return result;
    handleChatBusinessFailure(result);
    throw new Error(String(result?.message || result?.error || '对话请求失败'));
  }

  function finishChatSend(run) {
    run.unsubscribeStream?.();
    state.loading = false;
    state.stopping = false;
    state.activeRequestId = '';
    syncSendState();
    updateSessionTitleUi();
    run.input?.focus();
  }

  async function sendMessage() {
    const input = el('ai-chat-input');
    const select = el('ai-chat-model');
    const content = String(input?.value || '').trim();
    if (!content) return;
    if (state.loading) {
      await insertMessageDuringRun(content, input);
      return;
    }

    const run = prepareChatSend(input, select, content);
    if (!run) return;
    run.requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    state.activeRequestId = run.requestId;
    run.unsubscribeStream = subscribeChatStream(run);

    try {
      const result = await requestChatResult(run);
      await applyChatResult(run, result);
    } catch (error) {
      await handleChatSendError(run, error);
    } finally {
      finishChatSend(run);
    }
  }
