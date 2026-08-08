  function createActivityGroup() {
    const element = document.createElement('details');
    element.className = 'ai-chat-activity';
    element.open = true;
    element.hidden = true;
    const summary = document.createElement('summary');
    summary.innerHTML = '<span class="ai-chat-activity-arrow" aria-hidden="true">➣</span><span class="ai-chat-activity-label">运行过程</span><span class="ai-chat-activity-status" aria-live="polite"></span><span class="ai-chat-disclosure" aria-hidden="true">›</span>';
    const body = document.createElement('div');
    body.className = 'ai-chat-trace';
    element.append(summary, body);
    const disclosure = enableDetailsAnimation(element, body);
    return {
      body,
      element,
      label: summary.querySelector('.ai-chat-activity-label'),
      status: summary.querySelector('.ai-chat-activity-status'),
      setOpen: disclosure.setOpen,
    };
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

  class AssistantView {
    constructor(container, options) {
      this.container = container;
      container.querySelector('.ai-chat-welcome')?.remove();
      this.row = document.createElement('article');
      this.row.className = `ai-chat-message assistant${options.pending ? ' pending' : ''}`;
      this.row.dataset.messageKind = 'assistant-turn';
      this.stack = document.createElement('div');
      this.stack.className = 'ai-chat-assistant-stack';
      this.activities = [];
      this.row.appendChild(this.stack);
      container.appendChild(this.row);
      this.content = '';
      this.answer = null;
      this.answerRound = -1;
      this.answerCopy = null;
      this.answerWrap = null;
      this.thinkingViews = new Map();
      this.toolViews = new Map();
      this.startActivityGroup();
      this.hydrate({ traceEvents: options.traceEvents || [], reasoning: options.reasoning, toolEvents: options.toolEvents || [] });
      if (options.content) this.addContent(options.content, Number.MAX_SAFE_INTEGER);
      if (!options.pending) this.finalize();
      this.scroll();
    }

    scroll() {
      this.container.scrollTop = this.container.scrollHeight;
    }

    startActivityGroup() {
      this.activity = createActivityGroup();
      this.trace = this.activity.body;
      this.activities.push(this.activity);
      this.stack.appendChild(this.activity.element);
    }

    ensureAnswer() {
      if (this.answer) return this.answer;
      this.answerWrap = document.createElement('section');
      this.answerWrap.className = 'ai-chat-answer-wrap';
      const toolbar = document.createElement('div');
      toolbar.className = 'ai-chat-answer-toolbar';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'ai-chat-copy-action ai-chat-answer-copy';
      copy.textContent = '复制';
      copy.setAttribute('aria-label', '复制 AI 回复');
      copy.addEventListener('click', async () => {
        const copied = await copyTextToClipboard(copy.dataset.copyText || '');
        copy.textContent = copied ? '已复制' : '复制失败';
        window.setTimeout(() => { copy.textContent = '复制'; }, 1400);
      });
      toolbar.appendChild(copy);
      this.answer = document.createElement('div');
      this.answer.className = 'ai-chat-answer is-streaming';
      this.answerCopy = copy;
      this.answerWrap.append(toolbar, this.answer);
      this.stack.appendChild(this.answerWrap);
      return this.answer;
    }

    updateAnswer(value) {
      renderMarkdownInto(this.ensureAnswer(), value);
      this.answerCopy.dataset.copyText = String(value || '');
    }

    syncActivityGroup(activity = this.activity) {
      const thinkingViews = [...this.thinkingViews.values()]
        .filter((view) => view.activity === activity);
      const thinkingCount = thinkingViews.filter((view) => view.content).length;
      const activeThinking = thinkingViews.find((view) => !view.finished);
      const toolViews = [...this.toolViews.values()].filter((view) => view.activity === activity);
      const toolCount = toolViews.length;
      const parts = [];
      if (thinkingCount) parts.push(`${thinkingCount}次思考`);
      if (toolCount) parts.push(`${toolCount}次工具调用`);
      if (!parts.length && activeThinking) parts.push('正在生成');
      activity.element.hidden = !parts.length;
      activity.label.textContent = parts.join(' · ') || '运行过程';
      const runningTool = toolViews.find((view) => view.tool.status === 'running');
      activity.status.textContent = runningTool
        ? `正在执行 ${toolDisplayName(runningTool.tool)}`
        : activeThinking?.content ? '深度思考中' : '';
      activity.element.classList.toggle('is-running', Boolean(runningTool || activeThinking));
    }

    finishThinking(round) {
      const view = this.thinkingViews.get(Number(round));
      if (!view || view.finished) return;
      view.element.classList.remove('is-streaming');
      view.label.textContent = '深度思考';
      view.setOpen(false);
      view.finished = true;
      this.syncActivityGroup(view.activity);
    }

    discardEmptyThinking(round) {
      const roundId = Number(round) || 0;
      const view = this.thinkingViews.get(roundId);
      if (!view || view.content) return;
      view.element.remove();
      this.thinkingViews.delete(roundId);
      this.syncActivityGroup(view.activity);
    }

    appendStep(value) {
      if (!String(value || '').trim()) return;
      this.content = String(value);
      this.updateAnswer(this.content);
      this.answer.classList.remove('is-streaming');
      this.answerWrap.classList.add('ai-chat-step-answer');
      this.content = '';
      this.answer = null;
      this.answerCopy = null;
      this.answerWrap = null;
      this.answerRound = -1;
      this.startActivityGroup();
    }

    demoteAnswerToStep() {
      if (!this.content.trim() || !this.answer) return;
      this.answer.classList.remove('is-streaming');
      this.answerWrap.classList.add('ai-chat-step-answer');
      this.answer = null;
      this.answerCopy = null;
      this.answerWrap = null;
      this.content = '';
      this.answerRound = -1;
      this.startActivityGroup();
    }

    createThinkingView(roundId) {
      this.thinkingViews.forEach((_, round) => this.finishThinking(round));
      const element = document.createElement('details');
      element.className = 'ai-chat-thinking is-streaming';
      element.open = true;
      const summary = document.createElement('summary');
      summary.innerHTML = '<span class="ai-chat-thinking-mark" aria-hidden="true">➣</span><span class="ai-chat-thinking-label">深度思考</span><span class="ai-chat-disclosure" aria-hidden="true">›</span>';
      const textNode = document.createElement('div');
      textNode.className = 'ai-chat-thinking-text';
      element.append(summary, textNode);
      this.trace.appendChild(element);
      const disclosure = enableDetailsAnimation(element, textNode);
      const view = {
        element, text: textNode, label: summary.querySelector('.ai-chat-thinking-label'),
        activity: this.activity, content: '', finished: false, setOpen: disclosure.setOpen,
      };
      this.thinkingViews.set(roundId, view);
      this.syncActivityGroup();
      return view;
    }

    addReasoning(delta, round = 0) {
      const roundId = Number(round) || 0;
      if (this.answer && this.answerRound !== roundId) this.demoteAnswerToStep();
      const view = this.thinkingViews.get(roundId) || this.createThinkingView(roundId);
      view.content += String(delta || '');
      view.text.textContent = view.content;
      this.syncActivityGroup(view.activity);
      this.scroll();
    }

    addContent(delta, round = 0) {
      this.answerRound = Number(round) || 0;
      this.discardEmptyThinking(this.answerRound);
      this.finishThinking(this.answerRound);
      this.content += String(delta || '');
      this.updateAnswer(this.content);
      this.scroll();
    }

    setContent(value) {
      this.content = String(value || '');
      this.updateAnswer(this.content);
    }

    replaceContent(value, round = 0) {
      const roundId = Number(round) || 0;
      if (this.answer && this.answerRound !== roundId) return;
      this.content = String(value || '');
      if (!this.content) {
        this.answerWrap?.remove();
        this.answer = null;
        this.answerCopy = null;
        this.answerWrap = null;
        this.answerRound = -1;
      } else {
        this.answerRound = roundId;
        this.updateAnswer(this.content);
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
        view.activity = this.activity;
        this.toolViews.set(id, view);
        this.trace.appendChild(view.card);
      } else {
        view.update(tool);
      }
      this.syncActivityGroup(view.activity);
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
      this.activities.forEach((activity) => this.syncActivityGroup(activity));
      this.scroll();
    }
  }

  function createAssistantView(options = {}) {
    const container = el('ai-chat-messages');
    return container ? new AssistantView(container, options) : null;
  }
