  async function copyTextToClipboard(text) {
    const value = String(text || '');
    if (!value) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) {}
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  /** 从 userIndex 起，到下一条 user（不含）或数组末尾 */
  function findTurnEndExclusive(messages, userIndex) {
    let end = userIndex + 1;
    while (end < messages.length && messages[end]?.role !== 'user') end += 1;
    return end;
  }

  function resolveUserMessageIndex(row) {
    const fromAttr = Number(row?.dataset?.messageIndex);
    if (Number.isInteger(fromAttr) && fromAttr >= 0) return fromAttr;
    return -1;
  }

  async function copyUserBubble(row) {
    const text = String(row?.dataset?.content || row?.querySelector?.('.ai-chat-bubble')?.textContent || '');
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setStatus('已复制到剪贴板', 'success');
    } else {
      setStatus('复制失败，请手动选择文本', 'warning');
    }
  }

  async function performRecallUserBubble(row) {
    if (state.loading) {
      setStatus('请等待当前回复完成后再撤回', 'warning');
      return;
    }
    const userIndex = resolveUserMessageIndex(row);
    const messages = currentMessages();
    if (userIndex < 0 || userIndex >= messages.length || messages[userIndex]?.role !== 'user') {
      setStatus('无法定位该消息', 'warning');
      return;
    }
    const content = String(messages[userIndex].content || '');
    // 撤回：删除该气泡及之后的全部内容
    messages.splice(userIndex);
    const input = el('ai-chat-input');
    if (input) {
      input.value = content;
      resizeInput();
      syncSendState();
      reclaimAiInputFocus(input);
    }
    if (!messages.length) {
      if (state.currentSession) {
        state.currentSession.title = '新对话';
        state.currentSession.titleGenerated = false;
      }
      renderWelcome();
    } else {
      renderConversation();
    }
    updateSessionTitleUi();
    await persistCurrentSession();
  }

  function recallUserBubble(row) {
    if (state.loading) {
      setStatus('请等待当前回复完成后再撤回', 'warning');
      return;
    }
    const userIndex = resolveUserMessageIndex(row);
    const messages = currentMessages();
    if (userIndex < 0 || userIndex >= messages.length || messages[userIndex]?.role !== 'user') {
      setStatus('无法定位该消息', 'warning');
      return;
    }
    confirmDestructiveAction(
      '确认撤回这条消息吗？该消息及其之后的对话内容将被移除，消息内容会放回输入框。',
      () => performRecallUserBubble(row),
    );
  }

  async function performDeleteUserTurn(row) {
    if (state.loading) {
      setStatus('请等待当前回复完成后再删除', 'warning');
      return;
    }
    const userIndex = resolveUserMessageIndex(row);
    const messages = currentMessages();
    if (userIndex < 0 || userIndex >= messages.length || messages[userIndex]?.role !== 'user') {
      setStatus('无法定位该消息', 'warning');
      return;
    }
    // 删除：仅移除本轮用户消息及其对应 AI 回复（含中间 tool 消息），不影响后续轮次
    const end = findTurnEndExclusive(messages, userIndex);
    messages.splice(userIndex, end - userIndex);
    if (!messages.length) {
      if (state.currentSession) {
        state.currentSession.title = '新对话';
        state.currentSession.titleGenerated = false;
      }
      renderWelcome();
    } else {
      renderConversation();
    }
    updateSessionTitleUi();
    await persistCurrentSession();
  }

  function deleteUserTurn(row) {
    if (state.loading) {
      setStatus('请等待当前回复完成后再删除', 'warning');
      return;
    }
    const userIndex = resolveUserMessageIndex(row);
    const messages = currentMessages();
    if (userIndex < 0 || userIndex >= messages.length || messages[userIndex]?.role !== 'user') {
      setStatus('无法定位该消息', 'warning');
      return;
    }
    confirmDestructiveAction(
      '确认删除这轮对话吗？该条消息及其对应的 AI 回复将被删除，删除后无法恢复。',
      () => performDeleteUserTurn(row),
    );
  }

  function attachUserBubbleActions(row, content, messageIndex) {
    if (!row) return;
    row.dataset.messageIndex = String(messageIndex);
    row.dataset.content = String(content || '');

    const wrap = document.createElement('div');
    wrap.className = 'ai-chat-user-wrap';

    const actions = document.createElement('div');
    actions.className = 'ai-chat-user-actions';
    actions.setAttribute('aria-label', '消息操作');

    const makeBtn = (action, title, symbol) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ai-chat-msg-action';
      btn.dataset.action = action;
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.innerHTML = `<span class="ai-chat-msg-action-icon" aria-hidden="true">${symbol}</span>`;
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (action === 'copy') void copyUserBubble(row);
        else if (action === 'recall') void recallUserBubble(row);
        else if (action === 'delete') void deleteUserTurn(row);
      });
      return btn;
    };

    // 从左到右：复制、撤回、删除
    actions.append(
      makeBtn('copy', '复制', '❐'),
      makeBtn('recall', '撤回', '↩'),
      makeBtn('delete', '删除', '✕'),
    );

    const bubble = row.querySelector('.ai-chat-bubble');
    if (bubble) {
      wrap.append(actions, bubble);
      row.appendChild(wrap);
    }
  }

  function hasAssistantMessageContent(content, options) {
    if (String(content || '').trim()) return true;
    if (options.pending || String(options.reasoning || '').trim()) return true;
    return (Array.isArray(options.toolEvents) && options.toolEvents.length > 0)
      || (Array.isArray(options.traceEvents) && options.traceEvents.length > 0);
  }

  function appendMessage(role, content, options = {}) {
    const container = el('ai-chat-messages');
    if (!container) return null;
    if (role === 'tool' || role === 'system') return null;
    if (role === 'assistant' && !hasAssistantMessageContent(content, options)) return null;
    if (role === 'assistant') {
      return createAssistantView({ ...options, content });
    }
    const welcome = container.querySelector('.ai-chat-welcome');
    if (welcome) welcome.remove();
    const row = document.createElement('div');
    row.className = `ai-chat-message ${role}${options.pending ? ' pending' : ''}`;
    const bubble = document.createElement('div');
    bubble.className = 'ai-chat-bubble';
    bubble.textContent = content;
    row.appendChild(bubble);
    if (role === 'user') {
      const messageIndex = Number.isInteger(options.messageIndex)
        ? options.messageIndex
        : currentMessages().length - 1;
      attachUserBubbleActions(row, content, messageIndex);
    }
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
    return row;
  }

  function welcomePromptItems(hasBrowser) {
    if (hasBrowser) {
      return [
        ['览', '总结当前页面', '总结当前页面的核心信息，并列出关键结论。'],
        ['取', '提取页面数据', '提取当前页面中的关键数据，并整理成清晰的表格。'],
        ['流', '规划自动化流程', '根据当前浏览器页面，帮我规划一套可执行的自动化流程。'],
      ];
    }
    return [
      ['梳', '梳理一个任务', '帮我梳理这个任务，明确目标、步骤和需要注意的风险：'],
      ['写', '生成执行方案', '请根据我的目标，写一份清晰、可执行的方案：'],
      ['析', '分析一段内容', '请分析并解释下面这段内容，提炼重点和结论：'],
    ];
  }

  function applyWelcomePrompt(prompt) {
    const input = el('ai-chat-input');
    if (!input) return;
    input.value = prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  function createWelcomePrompts(hasBrowser) {
    const section = document.createElement('section');
    section.className = 'ai-chat-prompts';
    section.setAttribute('aria-label', '推荐任务');
    const heading = document.createElement('span');
    heading.className = 'ai-chat-prompts-heading';
    heading.textContent = '快速开始';
    const list = document.createElement('div');
    list.className = 'ai-chat-prompt-list';
    welcomePromptItems(hasBrowser).forEach(([iconText, titleText, prompt]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ai-chat-prompt-item';
      const icon = document.createElement('span');
      icon.textContent = iconText;
      const title = document.createElement('b');
      title.textContent = titleText;
      const arrow = document.createElement('i');
      arrow.textContent = '→';
      button.append(icon, title, arrow);
      button.addEventListener('click', () => applyWelcomePrompt(prompt));
      list.appendChild(button);
    });
    section.append(heading, list);
    return section;
  }

  function createWelcomeHero(browserText, browserCount, logoUrl) {
    const hero = document.createElement('div');
    hero.className = 'ai-chat-welcome-hero';
    const brand = document.createElement('div');
    brand.className = 'ai-chat-welcome-brand';
    const logoFrame = document.createElement('span');
    logoFrame.className = 'ai-chat-welcome-logo';
    const logo = document.createElement('img');
    logo.className = 'ai-chat-welcome-icon';
    logo.src = logoUrl;
    logo.alt = '';
    logo.setAttribute('aria-hidden', 'true');
    logo.setAttribute('data-app-logo', '');
    logoFrame.appendChild(logo);
    const brandName = document.createElement('span');
    brandName.textContent = 'AI-FREE COPILOT';
    const status = document.createElement('span');
    status.className = 'ai-chat-welcome-status';
    const statusDot = document.createElement('i');
    const statusText = document.createElement('span');
    statusText.textContent = browserCount ? `${browserCount} 个浏览器已连接` : '普通对话模式';
    status.append(statusDot, statusText);
    brand.append(logoFrame, brandName, status);
    const kicker = document.createElement('span');
    kicker.className = 'ai-chat-welcome-kicker';
    kicker.textContent = 'NEW CONVERSATION';
    const title = document.createElement('strong');
    title.textContent = '准备好一起完成什么？';
    const summary = document.createElement('p');
    summary.textContent = browserText;
    hero.append(brand, kicker, title, summary);
    return hero;
  }

  function renderWelcome() {
    const container = el('ai-chat-messages');
    if (!container) return;
    container.innerHTML = '';
    const welcome = document.createElement('div');
    welcome.className = 'ai-chat-welcome';
    const card = selectedAutomationCard();
    const browserCount = state.currentBrowserIds.length;
    const browserText = browserCount
      ? `已连接 ${browserCount} 个浏览器${card ? `，当前卡片为“${card.name}”` : ''}，AI 将在所选浏览器中执行操作${browserCount > 1 ? '，可按浏览器名称分开控制' : ''}。`
      : (card
        ? `当前卡片为“${card.name}”，但未连接浏览器，将进行普通对话。`
        : '当前未连接浏览器，将进行普通对话。');
    const logoUrl = window.aiFreeLogoAssets?.url || '../../assets/logo.ico';
    welcome.append(
      createWelcomeHero(browserText, browserCount, logoUrl),
      createWelcomePrompts(browserCount > 0),
    );
    container.appendChild(welcome);
    renderRecentHistory();
    updateSessionTitleUi();
  }

  function renderConversation() {
    const container = el('ai-chat-messages');
    if (!container) return;
    container.innerHTML = '';
    const messages = currentMessages();
    const visible = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => {
        if (message.role === 'user') return true;
        if (message.role !== 'assistant') return false;
        return !!(String(message.content || '').trim()
          || String(message.reasoning || '').trim()
          || message.tool_events?.length
          || message.trace_events?.length);
      });
    if (!visible.length) {
      renderWelcome();
      return;
    }
    visible.forEach(({ message, index }) => {
      appendMessage(message.role, message.content, {
        messageIndex: index,
        reasoning: message.reasoning,
        toolEvents: message.tool_events,
        traceEvents: message.trace_events,
      });
    });
    updateSessionTitleUi();
  }

  function syncSendState() {
    const send = el('ai-chat-send');
    const input = el('ai-chat-input');
    const model = el('ai-chat-model');
    const modelUnavailable = !model?.value;
    const quotaExhausted = !selectedModelIsCustom() && state.accountAuthenticated && isQuotaExhausted();
    if (send) {
      send.disabled = state.loading
        ? state.stopping
        : modelUnavailable || quotaExhausted || !input?.value.trim();
      const iconMode = state.loading ? 'stop' : 'send';
      if (send.dataset.iconMode !== iconMode) {
        send.innerHTML = SEND_BUTTON_ICONS[iconMode];
        send.dataset.iconMode = iconMode;
      }
      send.title = state.loading ? (state.stopping ? '正在停止' : '停止 AI 输出') : '发送消息';
      send.setAttribute('aria-label', state.loading ? '停止 AI 输出' : '发送消息');
      send.classList.toggle('is-stop', state.loading);
    }
  }
