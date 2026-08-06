  function getSelectShell(select) {
    return select?.closest?.('.ai-select') || null;
  }

  function closeAllSelects(exceptShell = null) {
    document.querySelectorAll('.ai-select.open').forEach((shell) => {
      if (exceptShell && shell === exceptShell) return;
      closeSelect(shell);
    });
  }

  function closeSelect(shell) {
    if (!shell) return;
    shell.classList.remove('open');
    const trigger = shell.querySelector('.ai-select-trigger');
    const menu = shell.querySelector('.ai-select-menu');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (menu) menu.hidden = true;
  }

  function updateBrowserMenuAvailableHeight(shell) {
    if (!shell || shell.dataset.aiSelect !== 'browser') return;
    const trigger = shell.querySelector('.ai-select-trigger');
    const menu = shell.querySelector('.ai-select-menu');
    if (!trigger || !menu) return;
    const viewportTop = Number(window.visualViewport?.offsetTop) || 0;
    const availableHeight = Math.max(0, Math.floor(trigger.getBoundingClientRect().top - viewportTop - 10));
    menu.style.setProperty('--ai-browser-menu-available-height', `${availableHeight}px`);
  }

  function openSelect(shell) {
    if (!shell) return;
    const trigger = shell.querySelector('.ai-select-trigger');
    const menu = shell.querySelector('.ai-select-menu');
    const select = shell.querySelector('select');
    if (!trigger || !menu) return;
    // 历史下拉无 native select；其余下拉依赖 native select 状态
    if (select && (select.disabled || trigger.disabled)) return;
    if (!select && trigger.disabled) return;
    closeAllSelects(shell);
    shell.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    updateBrowserMenuAvailableHeight(shell);
    const selected = menu.querySelector('[aria-selected="true"]');
    (selected || menu.querySelector('.ai-select-option'))?.focus?.();
  }

  function optionDisplayText(option) {
    if (!option) return '';
    const name = String(option.textContent || '');
    const multiplier = option.dataset?.quotaMultiplier;
    if (!multiplier) return name;
    return `${name} ×${formatQuota(multiplier)}`;
  }

  function updateBrowserMcpSettingUi() {
    const input = el('ai-browser-mcp-call-limit');
    const button = el('ai-browser-mcp-call-limit-save');
    const status = el('ai-browser-mcp-call-limit-status');
    if (input) {
      input.min = String(state.mcpCallLimitMin);
      input.max = String(state.mcpCallLimitMax);
      if (document.activeElement !== input) input.value = state.mcpCallLimitDraft;
      input.disabled = state.mcpSettingsLoading || state.mcpSettingsSaving;
    }
    if (button) {
      button.disabled = state.mcpSettingsLoading || state.mcpSettingsSaving;
      button.textContent = state.mcpSettingsSaving ? '保存中' : '保存';
    }
    if (status) {
      status.textContent = state.mcpSettingsLoading ? '读取中…' : state.mcpSettingsStatus;
      status.dataset.type = state.mcpSettingsStatusType;
    }
  }

  function getAiSettingsMethod(method) {
    const aiApi = window.aiFree && window.aiFree.ai;
    return aiApi && typeof aiApi[method] === 'function' ? aiApi[method].bind(aiApi) : null;
  }

  function applyLoadedAiControlSettings(response) {
    const limits = response && response.limits && response.limits.mcpCallLimit || {};
    const settings = response && response.settings || {};
    const min = Number(limits.min);
    const max = Number(limits.max);
    const value = Number(settings.mcpCallLimit);
    if (Number.isFinite(min)) state.mcpCallLimitMin = min;
    if (Number.isFinite(max)) state.mcpCallLimitMax = max;
    if (Number.isFinite(value)) {
      state.mcpCallLimit = value;
      state.mcpCallLimitDraft = String(value);
    }
  }

  function isValidMcpCallLimit(value) {
    return Number.isInteger(value) && value >= state.mcpCallLimitMin && value <= state.mcpCallLimitMax;
  }

  async function loadAiControlSettings() {
    const getSettings = getAiSettingsMethod('getSettings');
    if (state.mcpSettingsLoading || state.mcpSettingsLoaded || !getSettings) return;
    state.mcpSettingsLoading = true;
    state.mcpSettingsStatus = '';
    state.mcpSettingsStatusType = '';
    updateBrowserMcpSettingUi();
    try {
      const response = await getSettings();
      if (!response || !response.ok) throw new Error(response && response.error || '读取 MCP 设置失败');
      applyLoadedAiControlSettings(response);
      state.mcpSettingsLoaded = true;
    } catch (error) {
      state.mcpSettingsStatus = error?.message || String(error);
      state.mcpSettingsStatusType = 'error';
    } finally {
      state.mcpSettingsLoading = false;
      updateBrowserMcpSettingUi();
    }
  }

  async function saveAiControlSettings() {
    const input = el('ai-browser-mcp-call-limit');
    const setSettings = getAiSettingsMethod('setSettings');
    if (!input || state.mcpSettingsSaving || !setSettings) return;
    const value = Number(input.value);
    if (!isValidMcpCallLimit(value)) {
      state.mcpSettingsStatus = `请输入 ${state.mcpCallLimitMin}–${state.mcpCallLimitMax} 的整数`;
      state.mcpSettingsStatusType = 'error';
      updateBrowserMcpSettingUi();
      input.focus();
      return;
    }
    state.mcpSettingsSaving = true;
    state.mcpSettingsStatus = '';
    state.mcpSettingsStatusType = '';
    updateBrowserMcpSettingUi();
    try {
      const response = await setSettings({ mcpCallLimit: value });
      if (!response || !response.ok) throw new Error(response && response.error || '保存 MCP 设置失败');
      const settings = response.settings || {};
      state.mcpCallLimit = Number(settings.mcpCallLimit) || value;
      state.mcpCallLimitDraft = String(state.mcpCallLimit);
      state.mcpSettingsLoaded = true;
      state.mcpSettingsStatus = '已保存';
      state.mcpSettingsStatusType = 'success';
    } catch (error) {
      state.mcpSettingsStatus = error?.message || String(error);
      state.mcpSettingsStatusType = 'error';
    } finally {
      state.mcpSettingsSaving = false;
      updateBrowserMcpSettingUi();
    }
  }

  function appendBrowserMcpSetting(menu) {
    const item = document.createElement('li');
    item.className = 'ai-browser-menu-setting ai-browser-mcp-setting';

    const label = document.createElement('label');
    label.htmlFor = 'ai-browser-mcp-call-limit';
    label.textContent = 'MCP 调用上限';

    const editor = document.createElement('div');
    editor.className = 'ai-browser-mcp-setting-editor';
    const input = document.createElement('input');
    input.id = 'ai-browser-mcp-call-limit';
    input.type = 'number';
    input.step = '1';
    input.inputMode = 'numeric';
    input.value = state.mcpCallLimitDraft;
    input.setAttribute('aria-label', 'MCP 调用上限');
    input.addEventListener('input', () => {
      state.mcpCallLimitDraft = input.value;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      void saveAiControlSettings();
    });
    const unit = document.createElement('span');
    unit.textContent = '次';
    const button = document.createElement('button');
    button.id = 'ai-browser-mcp-call-limit-save';
    button.type = 'button';
    button.textContent = '保存';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void saveAiControlSettings();
    });
    editor.append(input, unit, button);

    const status = document.createElement('span');
    status.id = 'ai-browser-mcp-call-limit-status';
    status.className = 'ai-browser-mcp-setting-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const promptButton = document.createElement('button');
    promptButton.type = 'button';
    promptButton.className = 'ai-prompt-diagnostics-open';
    promptButton.textContent = '查看 AI 提示词与完整 Prompt';
    promptButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPromptDiagnostics();
    });
    item.append(label, editor, status, promptButton);
    menu.appendChild(item);
    updateBrowserMcpSettingUi();
  }
