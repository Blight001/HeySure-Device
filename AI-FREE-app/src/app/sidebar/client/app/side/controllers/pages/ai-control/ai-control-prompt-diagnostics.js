  function promptDiagnosticsPayload() {
    return {
      modelId: String(el('ai-chat-model')?.value || ''),
      messages: currentMessages(),
      browserConnectionId: state.currentBrowserIds[0] || '',
      browserConnectionIds: [...state.currentBrowserIds],
      automationCardId: state.currentCardId,
    };
  }

  function formatToolPromptDefinitions(tools) {
    if (!Array.isArray(tools) || !tools.length) return '当前没有可用的 MCP 工具。';
    return tools.map((tool) => [
      `## ${String(tool?.name || '未命名工具')}`,
      String(tool?.description || '（无工具说明）'),
      JSON.stringify(tool?.input_schema || {}, null, 2),
    ].join('\n')).join('\n\n');
  }

  function formatMcpFunctions(tools) {
    if (!Array.isArray(tools) || !tools.length) return '当前没有可用的 MCP 工具。';
    const details = tools.map((tool, index) => {
      const actions = Array.isArray(tool?.actions) && tool.actions.length
        ? `\n支持操作：${tool.actions.join('、')}`
        : '';
      const risk = tool?.destructive ? '可能修改本地或页面状态' : '未标记为修改状态';
      return `${index + 1}. ${String(tool?.name || '未命名工具')}\n功能：${String(tool?.description || '暂无功能说明')}${actions}\n风险标记：${risk}`;
    });
    return `当前可用 ${tools.length} 个 MCP 工具。\n\n${details.join('\n\n')}`;
  }

  function setPromptDiagnosticsText(id, text) {
    const target = el(id);
    if (target) target.textContent = String(text || '');
  }

  function setPromptDiagnosticsLoading(loading) {
    const refresh = el('ai-prompt-diagnostics-refresh');
    if (refresh) refresh.disabled = loading;
    if (loading) setPromptDiagnosticsText('ai-prompt-diagnostics-status', '正在读取主进程提示词…');
  }

  function promptRequestMetrics(payload) {
    if (!payload) return '尚无请求数据';
    const serialized = JSON.stringify(payload);
    const characters = serialized.length;
    const messages = Array.isArray(payload.messages) ? payload.messages.length : 0;
    const tools = Array.isArray(payload.tools) ? payload.tools.length : 0;
    return `${messages} 条消息 · ${tools} 个工具 · ${characters.toLocaleString()} 字符 · 约 ${Math.ceil(characters / 3).toLocaleString()} tokens`;
  }

  function selectedPromptRequest() {
    if (!promptDiagnosticsResult) return null;
    if (promptDiagnosticsView === 'actual' && promptDiagnosticsResult.lastRequest) {
      return promptDiagnosticsResult.lastRequest;
    }
    return promptDiagnosticsResult.preview || null;
  }

  function renderSelectedPromptRequest() {
    const payload = selectedPromptRequest();
    setPromptDiagnosticsText('ai-prompt-full-content', payload ? JSON.stringify(payload, null, 2) : '尚无请求数据');
    setPromptDiagnosticsText('ai-prompt-request-metrics', promptRequestMetrics(payload));
    document.querySelectorAll('[data-ai-prompt-view]').forEach((button) => {
      const selected = button.dataset.aiPromptView === promptDiagnosticsView;
      button.setAttribute('aria-selected', String(selected));
    });
  }

  function selectPromptDiagnosticsView(view) {
    promptDiagnosticsView = view === 'preview' ? 'preview' : 'actual';
    if (promptDiagnosticsView === 'actual' && !promptDiagnosticsResult?.lastRequest) {
      promptDiagnosticsView = 'preview';
    }
    renderSelectedPromptRequest();
  }

  function renderPromptDiagnostics(result) {
    promptDiagnosticsResult = result;
    if (!result.lastRequest) promptDiagnosticsView = 'preview';
    setPromptDiagnosticsText(
      'ai-prompt-mcp-functions-content',
      formatMcpFunctions(result.mcpTools),
    );
    setPromptDiagnosticsText(
      'ai-prompt-tools-content',
      formatToolPromptDefinitions(result.preview?.tools),
    );
    renderSelectedPromptRequest();
    setPromptDiagnosticsText(
      'ai-prompt-diagnostics-status',
      result.lastRequest ? '已显示最近一次实际请求' : '尚无实际请求，当前显示下一次请求预览',
    );
  }

  async function refreshPromptDiagnostics() {
    const getDiagnostics = getAiSettingsMethod('getPromptDiagnostics');
    if (!getDiagnostics) return;
    setPromptDiagnosticsLoading(true);
    try {
      const result = await getDiagnostics(promptDiagnosticsPayload());
      if (!result?.ok) throw new Error(result?.message || result?.error || '读取 AI 提示词失败');
      renderPromptDiagnostics(result);
    } catch (error) {
      setPromptDiagnosticsText('ai-prompt-diagnostics-status', error?.message || String(error));
    } finally {
      setPromptDiagnosticsLoading(false);
    }
  }

  function openPromptDiagnostics() {
    closeAllSelects();
    const dialog = el('ai-prompt-diagnostics-dialog');
    if (!dialog) return;
    dialog.hidden = false;
    document.body.classList.add('ai-prompt-diagnostics-open');
    document.querySelectorAll('[data-ai-prompt-view]').forEach((button) => {
      button.onclick = () => selectPromptDiagnosticsView(button.dataset.aiPromptView);
    });
    void refreshPromptDiagnostics();
  }

  function closePromptDiagnostics() {
    const dialog = el('ai-prompt-diagnostics-dialog');
    if (dialog) dialog.hidden = true;
    document.body.classList.remove('ai-prompt-diagnostics-open');
  }
  let promptDiagnosticsResult = null;
  let promptDiagnosticsView = 'actual';
