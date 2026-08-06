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

  function setPromptDiagnosticsText(id, text) {
    const target = el(id);
    if (target) target.textContent = String(text || '');
  }

  function setPromptDiagnosticsLoading(loading) {
    const refresh = el('ai-prompt-diagnostics-refresh');
    if (refresh) refresh.disabled = loading;
    if (loading) setPromptDiagnosticsText('ai-prompt-diagnostics-status', '正在读取主进程提示词…');
  }

  function renderPromptDiagnostics(result) {
    setPromptDiagnosticsText(
      'ai-prompt-tools-content',
      formatToolPromptDefinitions(result.preview?.tools),
    );
    setPromptDiagnosticsText('ai-prompt-full-content', JSON.stringify({
      nextRequestPreview: result.preview,
      lastActualRequest: result.lastRequest,
    }, null, 2));
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
    void refreshPromptDiagnostics();
  }

  function closePromptDiagnostics() {
    const dialog = el('ai-prompt-diagnostics-dialog');
    if (dialog) dialog.hidden = true;
    document.body.classList.remove('ai-prompt-diagnostics-open');
  }
