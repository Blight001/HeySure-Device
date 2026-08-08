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

  function formatDuration(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
    if (milliseconds < 1000) return `${Math.max(0.1, milliseconds / 1000).toFixed(1)}s`;
    if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)}s`;
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = Math.floor((milliseconds % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }

  function createToolCopyButton(value, label = '复制') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-chat-copy-action';
    button.textContent = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const copied = await copyTextToClipboard(value);
      button.textContent = copied ? '已复制' : '复制失败';
      window.setTimeout(() => { button.textContent = label; }, 1400);
    });
    return button;
  }

  function appendToolSection(container, labelText, value, error = false) {
    if (value === undefined || value === null || value === '') return;
    const label = document.createElement('div');
    label.className = `ai-chat-tool-detail-label${error ? ' error' : ''}`;
    label.textContent = labelText;
    const pre = document.createElement('pre');
    pre.className = `ai-chat-tool-detail-body${error ? ' error' : ''}`;
    pre.textContent = formatActivityDetail(value);
    container.append(label, pre);
  }

  function commandResultDetails(result) {
    const parsed = parseToolArguments(result);
    return {
      directory: String(parsed.directory || parsed.cwd || ''),
      exitCode: parsed.exit_code ?? parsed.exitCode ?? null,
      stderr: String(parsed.stderr || ''),
      stdout: String(parsed.stdout || ''),
      success: parsed.success !== false,
      timedOut: parsed.timed_out === true || parsed.timedOut === true,
    };
  }

  function appendCommandCard(container, args) {
    const card = document.createElement('section');
    card.className = 'ai-chat-command-card';
    const meta = document.createElement('div');
    meta.className = 'ai-chat-command-meta';
    const cwd = document.createElement('span');
    cwd.textContent = String(args.cwd || args.directory || '.');
    const timeout = document.createElement('span');
    timeout.textContent = args.timeout_seconds ? `超时 ${args.timeout_seconds}s` : '';
    const command = document.createElement('div');
    command.className = 'ai-chat-command-code';
    const prompt = document.createElement('span');
    prompt.textContent = '$';
    const pre = document.createElement('pre');
    pre.textContent = String(args.command || '');
    command.append(prompt, pre, createToolCopyButton(pre.textContent, '复制命令'));
    meta.append(cwd, timeout);
    card.append(meta, command);
    container.appendChild(card);
  }

  function appendCommandResult(container, result) {
    const parsed = commandResultDetails(result);
    const card = document.createElement('section');
    card.className = `ai-chat-command-result${parsed.success ? '' : ' error'}`;
    const heading = document.createElement('div');
    heading.className = 'ai-chat-command-result-heading';
    const status = document.createElement('strong');
    status.textContent = parsed.success ? '执行完成' : '执行失败';
    const code = document.createElement('span');
    code.textContent = parsed.exitCode === null ? '' : `退出码 ${parsed.exitCode}`;
    const timeout = document.createElement('span');
    timeout.textContent = parsed.timedOut ? '已超时' : '';
    heading.append(status, code, timeout);
    card.appendChild(heading);
    appendToolSection(card, '标准输出', parsed.stdout || '命令未返回文本输出');
    appendToolSection(card, '错误输出', parsed.stderr, true);
    container.appendChild(card);
  }

  function appendToolDetails(detail, tool) {
    const args = parseToolArguments(tool.arguments);
    const rawCopy = [
      `工具: ${String(tool.name || '')}`,
      `参数:\n${formatActivityDetail(tool.arguments)}`,
      `结果:\n${formatActivityDetail(tool.result)}`,
    ].join('\n\n');
    const copy = createToolCopyButton(rawCopy, '复制全部');
    copy.classList.add('ai-chat-tool-copy-all');
    detail.appendChild(copy);
    const doc = document.createElement('div');
    doc.className = 'ai-chat-tool-detail-doc';
    if (tool.name === 'run_command' && args.command) {
      appendCommandCard(doc, args);
      if (tool.result !== undefined && tool.result !== '') appendCommandResult(doc, tool.result);
      const raw = document.createElement('details');
      raw.className = 'ai-chat-tool-raw';
      const summary = document.createElement('summary');
      summary.textContent = '查看原始调用数据';
      raw.appendChild(summary);
      appendToolSection(raw, '参数', tool.arguments);
      appendToolSection(raw, '结果', tool.result);
      doc.appendChild(raw);
    } else {
      appendToolSection(doc, '参数', tool.arguments);
      appendToolSection(doc, tool.status === 'error' ? '错误' : '结果', tool.result, tool.status === 'error');
    }
    detail.appendChild(doc);
  }

  function updateToolSummary(summary, tool) {
    const status = String(tool.status || 'running');
    const duration = formatDuration(tool.duration_ms);
    summary.querySelector('.ai-chat-tool-state').textContent =
      status === 'running' ? '调用中' : status === 'error' ? '调用失败' : '调用';
    const name = summary.querySelector('.ai-chat-tool-name');
    name.textContent = String(tool.name || 'MCP 工具');
    name.title = toolDisplayName(tool);
    summary.querySelector('.ai-chat-tool-duration').textContent = duration;
    summary.setAttribute('aria-label', `${toolDisplayName(tool)}，${status === 'error' ? '调用失败' : status === 'running' ? '调用中' : '调用成功'}${duration ? `，耗时 ${duration}` : ''}`);
  }

  function createToolActivity(tool = {}) {
    const card = document.createElement('details');
    card.className = `ai-chat-tool ${tool.status || 'running'}`;
    card.dataset.toolId = String(tool.id || '');
    const summary = document.createElement('summary');
    summary.innerHTML = '<span class="ai-chat-tool-dot" aria-hidden="true"></span><span class="ai-chat-tool-state"></span><span class="ai-chat-tool-provider">AI-FREE</span><code class="ai-chat-tool-name"></code><span class="ai-chat-tool-duration"></span><span class="ai-chat-disclosure" aria-hidden="true">›</span>';
    const detail = document.createElement('div');
    detail.className = 'ai-chat-tool-detail';
    card.append(summary, detail);
    const disclosure = enableDetailsAnimation(card, detail);
    const update = (next = {}) => {
      Object.assign(tool, next);
      card.className = `ai-chat-tool ${tool.status || 'running'}`;
      updateToolSummary(summary, tool);
      detail.innerHTML = '';
      appendToolDetails(detail, tool);
    };
    update(tool);
    return { card, tool, update, setOpen: disclosure.setOpen };
  }
