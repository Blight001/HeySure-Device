  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeMarkdownUrl(value) {
    const url = String(value || '').trim();
    return /^(https?:|mailto:)/i.test(url) ? escapeHtml(url) : '';
  }

  function renderInlineMarkdown(value) {
    const tokens = [];
    const token = (html) => {
      const index = tokens.push(html) - 1;
      return `\uE000${index}\uE001`;
    };
    let text = String(value || '')
      .replace(/`([^`\n]+)`/g, (_, code) => token(`<code>${escapeHtml(code)}</code>`))
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => {
        const safeUrl = safeMarkdownUrl(url);
        return safeUrl
          ? token(`<img src="${safeUrl}" alt="${escapeHtml(alt)}" loading="lazy">`)
          : escapeHtml(alt);
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
        const safeUrl = safeMarkdownUrl(url);
        return safeUrl
          ? token(`<a href="${safeUrl}" target="_blank" rel="noreferrer">${renderInlineMarkdown(label)}</a>`)
          : label;
      });
    text = escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>')
      // 流式传输时闭合标记可能尚未到达，隐藏残留的 Markdown 控制符。
      .replace(/\*\*|__|~~|`/g, '');
    return text.replace(/\uE000(\d+)\uE001/g, (_, index) => tokens[Number(index)] || '');
  }

  function consumeMarkdownCodeBlock(lines, startIndex) {
    const language = lines[startIndex].trim().slice(3).trim().replace(/[^a-zA-Z0-9_+-]/g, '');
    const code = [];
    let index = startIndex + 1;
    while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
    const attribute = language ? ` data-language="${escapeHtml(language)}"` : '';
    return { html: `<pre class="ai-chat-code"><code${attribute}>${escapeHtml(code.join('\n'))}</code></pre>`, index };
  }

  function markdownTableCells(line) {
    return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  }

  function consumeMarkdownTable(lines, startIndex) {
    const headers = markdownTableCells(lines[startIndex]);
    const rows = [];
    let index = startIndex + 2;
    while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
      rows.push(markdownTableCells(lines[index++]));
    }
    const head = headers.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join('');
    const body = rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${renderInlineMarkdown(row[cellIndex] || '')}</td>`).join('')}</tr>`).join('');
    return { html: `<div class="ai-chat-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`, index: index - 1 };
  }

  function consumeMarkdownQuote(lines, startIndex) {
    const quote = [];
    let index = startIndex;
    while (index < lines.length && /^\s*>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
    return { html: `<blockquote>${quote.map(renderInlineMarkdown).join('<br>')}</blockquote>`, index: index - 1 };
  }

  function consumeMarkdownList(lines, startIndex, ordered) {
    const matcher = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-+*]\s+(.+)$/;
    const items = [];
    let index = startIndex;
    while (index < lines.length) {
      const match = lines[index].match(matcher);
      if (!match) break;
      items.push(match[1]);
      index += 1;
    }
    const tag = ordered ? 'ol' : 'ul';
    return { html: `<${tag}>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${tag}>`, index: index - 1 };
  }

  function renderMarkdown(value) {
    const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let paragraph = [];
    const flushParagraph = () => {
      if (!paragraph.length) return;
      output.push(`<p>${paragraph.map(renderInlineMarkdown).join('<br>')}</p>`);
      paragraph = [];
    };
    const isTableDivider = (line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*```/.test(line)) {
        flushParagraph();
        const consumed = consumeMarkdownCodeBlock(lines, index);
        output.push(consumed.html);
        index = consumed.index;
        continue;
      }
      if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
        flushParagraph();
        const consumed = consumeMarkdownTable(lines, index);
        output.push(consumed.html);
        index = consumed.index;
        continue;
      }
      const heading = line.match(/^\s*(#{1,6})(?:\s+|(?=[^#\s]))(.+)$/);
      if (heading) {
        flushParagraph();
        const level = Math.min(6, heading[1].length);
        output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
        continue;
      }
      if (/^\s*#{1,6}\s*$/.test(line)) {
        flushParagraph();
        continue;
      }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushParagraph();
        output.push('<hr>');
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        const consumed = consumeMarkdownQuote(lines, index);
        output.push(consumed.html);
        index = consumed.index;
        continue;
      }
      const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const consumed = consumeMarkdownList(lines, index, Boolean(ordered));
        output.push(consumed.html);
        index = consumed.index;
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        continue;
      }
      paragraph.push(line);
    }
    flushParagraph();
    return output.join('');
  }

  function renderMarkdownInto(target, value) {
    if (target) target.innerHTML = renderMarkdown(value);
  }

  function formatActivityDetail(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value ?? null, null, 2); } catch (_) { return String(value ?? ''); }
  }

  const TOOL_DISPLAY_NAMES = Object.freeze({
    manage_card: '自动化卡片',
    save_cookies: '保存浏览器数据',
    browser_file: '浏览器文件',
    browser_tab: '浏览器标签页',
    browser_observe: '观察页面',
    browser_action: '操作页面',
    browser_wait: '等待页面',
    windows_tab: '外部软件栏目',
    run_command: '沙盒命令行',
  });

  const TOOL_ACTION_DISPLAY_NAMES = Object.freeze({
    windows_tab: {
      list: '查看外部软件栏目',
      open: '显示外部软件栏目',
      create: '新建外部软件栏目',
      edit: '编辑外部软件栏目',
      close: '关闭外部软件栏目',
    },
    browser_file: {
      info: '查看 AI 工作区',
      download: '下载文件',
      upload: '上传文件',
      save_session: '保存浏览器会话',
    },
    manage_card: {
      rules: '查看卡片规范',
      list: '查看卡片列表',
      get: '读取自动化卡片',
      write: '保存自动化卡片',
      patch_step: '修改卡片步骤',
      insert_step: '插入卡片步骤',
      delete_step: '删除卡片步骤',
      move_step: '移动卡片步骤',
      delete: '删除自动化卡片',
      run: '运行自动化卡片',
    },
    browser_tab: {
      list: '查看浏览器标签页',
      switch: '切换浏览器标签页',
      replace: '在当前页打开网址',
      navigate: '打开新网页',
      close: '关闭浏览器标签页',
      back: '浏览器后退',
      forward: '浏览器前进',
    },
    browser_action: {
      click: '点击页面元素',
      double_click: '双击页面元素',
      right_click: '右键点击页面元素',
      scroll: '滚动页面',
      type: '输入文本',
      press_key: '按下键盘按键',
    },
  });

  const TOOL_NAMESPACE_NAMES = Object.freeze({
    platform: '平台',
    config: '平台配置',
    catalog: '选项目录',
    announce: '公告',
    presence: '在线状态',
    stats: '数据统计',
    proxy: '代理',
    account: 'AI 账号',
    member: '会员',
  });

  const TOOL_OPERATION_NAMES = Object.freeze({
    list: '列表',
    create: '新建',
    disable: '停用',
    get: '查看',
    set: '修改',
    options: '选项',
    update: '修改',
    set_status: '设置状态',
    delete: '删除',
    online_users: '在线用户',
    tenant: '概览',
    trend: '使用趋势',
    traffic: '流量',
    rate_limit_get: '查看频率限制',
    rate_limit_set: '修改频率限制',
    subscriptions: '订阅列表',
    nodes: '节点列表',
    settings_get: '查看高级设置',
    settings_set: '修改高级设置',
    switch_subscription: '切换订阅',
    usage_stats: '使用统计',
    score_distribution: '积分分布',
    regions: '地区分布',
    priority_get: '查看调度优先级',
    priority_set: '设置调度优先级',
    group_tags: '分组标签',
    clear_device: '清除设备绑定',
  });
