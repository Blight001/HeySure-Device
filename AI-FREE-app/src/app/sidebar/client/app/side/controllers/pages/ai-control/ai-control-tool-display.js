  function parseToolArguments(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function toolDisplayName(tool = {}) {
    const rawName = String(tool.name || '').trim();
    const args = parseToolArguments(tool.arguments);
    const action = String(args.action || '').trim().toLowerCase();
    const actionName = TOOL_ACTION_DISPLAY_NAMES[rawName]?.[action];
    if (actionName) return actionName;
    if (TOOL_DISPLAY_NAMES[rawName]) return TOOL_DISPLAY_NAMES[rawName];
    if (/\p{Script=Han}/u.test(rawName)) return rawName;

    const separatorIndex = rawName.indexOf('.');
    if (separatorIndex > 0) {
      const namespace = TOOL_NAMESPACE_NAMES[rawName.slice(0, separatorIndex)];
      const operation = TOOL_OPERATION_NAMES[rawName.slice(separatorIndex + 1)];
      if (namespace && operation) return `${namespace}${operation}`;
      if (namespace) return `${namespace}工具`;
    }
    return '浏览器原生工具';
  }

  function getDetailsContentAnimationStart(wasOpen, contentStyle) {
    if (!wasOpen) return { opacity: '0', transform: 'translateY(-4px)' };
    return {
      opacity: contentStyle.opacity,
      transform: contentStyle.transform !== 'none' ? contentStyle.transform : 'translateY(0)',
    };
  }

  function enableDetailsAnimation(details, content) {
    const summary = details.querySelector(':scope > summary');
    let heightAnimation = null;
    let contentAnimation = null;
    let targetOpen = details.open;
    let sequence = 0;

    const prefersReducedMotion = () =>
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const settle = (open) => {
      details.open = open;
      targetOpen = open;
      summary.setAttribute('aria-expanded', String(open));
      details.classList.remove('is-animating');
      details.style.removeProperty('height');
      details.style.removeProperty('overflow');
    };
    const setOpen = (open, { animate = true } = {}) => {
      const nextOpen = Boolean(open);
      if (!heightAnimation && details.open === nextOpen) {
        targetOpen = nextOpen;
        summary.setAttribute('aria-expanded', String(nextOpen));
        return;
      }

      const currentHeight = details.getBoundingClientRect().height;
      const wasOpen = details.open;
      const contentStyle = window.getComputedStyle(content);
      const animationStart = getDetailsContentAnimationStart(wasOpen, contentStyle);
      const animationId = ++sequence;

      heightAnimation?.cancel();
      contentAnimation?.cancel();
      heightAnimation = null;
      contentAnimation = null;
      targetOpen = nextOpen;
      summary.setAttribute('aria-expanded', String(nextOpen));

      if (!animate || prefersReducedMotion() || !details.isConnected) {
        settle(nextOpen);
        return;
      }

      details.style.removeProperty('height');
      details.open = nextOpen;
      const targetHeight = details.getBoundingClientRect().height;
      details.open = true;
      details.style.height = `${currentHeight}px`;
      details.style.overflow = 'hidden';
      details.classList.add('is-animating');

      heightAnimation = details.animate(
        [{ height: `${currentHeight}px` }, { height: `${targetHeight}px` }],
        { duration: 220, easing: 'cubic-bezier(.2, .7, .2, 1)' },
      );
      contentAnimation = content.animate(
        [
          animationStart,
          { opacity: nextOpen ? 1 : 0, transform: nextOpen ? 'translateY(0)' : 'translateY(-4px)' },
        ],
        { duration: nextOpen ? 180 : 140, easing: 'ease', fill: 'forwards' },
      );
      heightAnimation.onfinish = () => {
        if (animationId !== sequence) return;
        heightAnimation = null;
        contentAnimation?.cancel();
        contentAnimation = null;
        settle(nextOpen);
      };
    };

    summary.setAttribute('aria-expanded', String(targetOpen));
    summary.addEventListener('click', (event) => {
      event.preventDefault();
      setOpen(!targetOpen);
    });
    return { setOpen };
  }

  function createToolActivity(tool = {}) {
    const card = document.createElement('details');
    card.className = `ai-chat-tool ${tool.status || 'running'}`;
    card.dataset.toolId = String(tool.id || '');
    const summary = document.createElement('summary');
    summary.innerHTML = '<span class="ai-chat-tool-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.75"></circle></svg></span><span class="ai-chat-tool-kind">工具</span><span class="ai-chat-tool-name"></span><span class="ai-chat-tool-status"></span><span class="ai-chat-disclosure" aria-hidden="true">›</span>';
    const detail = document.createElement('div');
    detail.className = 'ai-chat-tool-detail';
    card.append(summary, detail);
    const disclosure = enableDetailsAnimation(card, detail);

    const update = (next = {}) => {
      Object.assign(tool, next);
      const status = String(tool.status || 'running');
      card.className = `ai-chat-tool ${status}`;
      summary.querySelector('.ai-chat-tool-name').textContent = toolDisplayName(tool);
      summary.querySelector('.ai-chat-tool-status').textContent =
        status === 'running' ? '调用中' : status === 'error' ? '调用失败' : '已完成';
      detail.innerHTML = '';
      if (tool.arguments !== undefined && tool.arguments !== '') {
        const label = document.createElement('span');
        label.className = 'ai-chat-tool-detail-label';
        label.textContent = '输入';
        const pre = document.createElement('pre');
        pre.textContent = formatActivityDetail(tool.arguments);
        detail.append(label, pre);
      }
      if (tool.result !== undefined && tool.result !== '') {
        const label = document.createElement('span');
        label.className = 'ai-chat-tool-detail-label';
        label.textContent = status === 'error' ? '错误' : '输出';
        const pre = document.createElement('pre');
        pre.textContent = formatActivityDetail(tool.result);
        detail.append(label, pre);
      }
    };
    update(tool);
    return { card, update, setOpen: disclosure.setOpen };
  }

  class AssistantView {
    constructor(container, options) {
      this.container = container;
      container.querySelector('.ai-chat-welcome')?.remove();
      this.row = document.createElement('div');
      this.row.className = `ai-chat-message assistant${options.pending ? ' pending' : ''}`;
      this.stack = document.createElement('div');
      this.stack.className = 'ai-chat-assistant-stack';
      this.trace = document.createElement('div');
      this.trace.className = 'ai-chat-trace';
      this.stack.appendChild(this.trace);
      this.row.appendChild(this.stack);
      container.appendChild(this.row);
      this.content = '';
      this.answer = null;
      this.answerRound = -1;
      this.thinkingViews = new Map();
      this.toolViews = new Map();
      this.hydrate({ traceEvents: options.traceEvents || [], reasoning: options.reasoning, toolEvents: options.toolEvents || [] });
      if (options.content) this.addContent(options.content, Number.MAX_SAFE_INTEGER);
      if (!options.pending) this.finalize();
      this.scroll();
    }

    scroll() {
      this.container.scrollTop = this.container.scrollHeight;
    }

    ensureAnswer() {
      if (this.answer) return this.answer;
      this.answer = document.createElement('div');
      this.answer.className = 'ai-chat-answer is-streaming';
      this.stack.appendChild(this.answer);
      return this.answer;
    }

    finishThinking(round) {
      const view = this.thinkingViews.get(Number(round));
      if (!view || view.finished) return;
      view.element.classList.remove('is-streaming');
      view.label.textContent = '思考过程';
      view.setOpen(false);
      view.finished = true;
    }

    discardEmptyThinking(round) {
      const roundId = Number(round) || 0;
      const view = this.thinkingViews.get(roundId);
      if (!view || view.content) return;
      view.element.remove();
      this.thinkingViews.delete(roundId);
    }

    appendStep(value) {
      if (!String(value || '').trim()) return;
      const step = document.createElement('div');
      step.className = 'ai-chat-step-output';
      renderMarkdownInto(step, value);
      this.trace.appendChild(step);
    }

    demoteAnswerToStep() {
      if (!this.content.trim() || !this.answer) return;
      this.appendStep(this.content);
      this.answer.remove();
      this.answer = null;
      this.content = '';
      this.answerRound = -1;
    }

    createThinkingView(roundId) {
      this.thinkingViews.forEach((_, round) => this.finishThinking(round));
      const element = document.createElement('details');
      element.className = 'ai-chat-thinking is-streaming';
      element.open = true;
      const summary = document.createElement('summary');
      summary.innerHTML = '<span class="ai-chat-thinking-mark" aria-hidden="true">✦</span><span class="ai-chat-thinking-label">思考中</span><span class="ai-chat-disclosure" aria-hidden="true">›</span>';
      const textNode = document.createElement('div');
      textNode.className = 'ai-chat-thinking-text';
      element.append(summary, textNode);
      this.trace.appendChild(element);
      const disclosure = enableDetailsAnimation(element, textNode);
      const view = {
        element, text: textNode, label: summary.querySelector('.ai-chat-thinking-label'),
        content: '', finished: false, setOpen: disclosure.setOpen,
      };
      this.thinkingViews.set(roundId, view);
      return view;
    }

    addReasoning(delta, round = 0) {
      const roundId = Number(round) || 0;
      if (this.answer && this.answerRound !== roundId) this.demoteAnswerToStep();
      const view = this.thinkingViews.get(roundId) || this.createThinkingView(roundId);
      view.content += String(delta || '');
      view.text.textContent = view.content;
      this.scroll();
    }

    addContent(delta, round = 0) {
      this.answerRound = Number(round) || 0;
      this.discardEmptyThinking(this.answerRound);
      this.finishThinking(this.answerRound);
      this.content += String(delta || '');
      renderMarkdownInto(this.ensureAnswer(), this.content);
      this.scroll();
    }

    setContent(value) {
      this.content = String(value || '');
      renderMarkdownInto(this.ensureAnswer(), this.content);
    }

    replaceContent(value, round = 0) {
      const roundId = Number(round) || 0;
      if (this.answer && this.answerRound !== roundId) return;
      this.content = String(value || '');
      if (!this.content) {
        this.answer?.remove();
        this.answer = null;
        this.answerRound = -1;
      } else {
        this.answerRound = roundId;
        renderMarkdownInto(this.ensureAnswer(), this.content);
      }
      this.scroll();
    }

    upsertTool(tool, round = 0) {
      const roundId = Number(round) || 0;
      const id = String(tool?.id || tool?.name || this.toolViews.size);
      let view = this.toolViews.get(id);
      if (!view) {
        this.discardEmptyThinking(roundId);
        this.finishThinking(roundId);
        this.demoteAnswerToStep();
        view = createToolActivity(tool);
        this.toolViews.set(id, view);
        this.trace.appendChild(view.card);
      } else {
        view.update(tool);
      }
      this.scroll();
    }

    hydrateTraceEvents(traceEvents) {
      traceEvents.forEach((event, index) => {
        const parsedRound = Number(event?.round);
        const round = Number.isFinite(parsedRound) ? parsedRound : index;
        if (event?.type === 'reasoning') {
          this.addReasoning(event.content, round);
          this.finishThinking(round);
        } else if (event?.type === 'tool') this.upsertTool(event.tool || {}, round);
        else if (event?.type === 'step') this.appendStep(event.content);
      });
    }

    hydrate({ traceEvents = [], reasoning = '', toolEvents = [] } = {}) {
      if (traceEvents.length) {
        this.hydrateTraceEvents(traceEvents);
        return;
      }
      if (reasoning) {
        this.addReasoning(reasoning, 0);
        this.finishThinking(0);
      }
      toolEvents.forEach((tool, index) => this.upsertTool(tool, index + 1));
    }

    finalize() {
      this.row.classList.remove('pending');
      this.thinkingViews.forEach((view, round) => {
        if (view.content) this.finishThinking(round);
        else this.discardEmptyThinking(round);
      });
      this.answer?.classList.remove('is-streaming');
      this.scroll();
    }
  }

  function createAssistantView(options = {}) {
    const container = el('ai-chat-messages');
    return container ? new AssistantView(container, options) : null;
  }
