(() => {
  const state = { cards: [], connections: [], selectedId: '', cardData: null, busy: false, initialized: false };

  function element(id) { return document.getElementById(id); }

  function setStatus(value) {
    const target = element('automation-status');
    if (target) target.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }

  function parseJson(id, fallback) {
    const source = String(element(id)?.value || '').trim();
    if (!source) return fallback;
    try { return JSON.parse(source); } catch (error) {
      throw new Error(`${id === 'automation-card-steps' ? '步骤' : '运行输入'} JSON 格式错误：${error.message}`);
    }
  }

  function cardDraft() {
    const steps = parseJson('automation-card-steps', []);
    if (!Array.isArray(steps)) throw new Error('步骤 JSON 必须是数组');
    const name = String(element('automation-card-name')?.value || '').trim();
    if (!name) throw new Error('请在基础信息中填写卡片名称');
    const website = String(element('automation-card-website')?.value || '').trim();
    if (website) {
      try { new URL(website); } catch (_) { throw new Error('目标网站 URL 格式错误'); }
    }
    return {
      ...(state.cardData || {}),
      name,
      website,
      description: String(element('automation-card-description')?.value || '').trim(),
      steps,
    };
  }

  async function invoke(input) {
    const api = window.aiFree?.ai?.manageAutomationCard;
    if (!api) throw new Error('原生自动化接口不可用');
    const result = await api(input);
    if (!result?.ok) throw new Error(result?.message || '自动化操作失败');
    return result.data;
  }

  function option(value, label) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  }

  function renderConnections() {
    const select = element('automation-browser-select');
    if (!select) return;
    const previous = select.value;
    const options = state.connections.map((item) => option(item.id, item.name || item.profileId || item.id));
    select.replaceChildren(option('', state.connections.length ? '请选择浏览器窗口' : '暂无原生浏览器连接'), ...options);
    if (state.connections.some((item) => item.id === previous)) select.value = previous;
    else if (state.connections.length === 1) select.value = state.connections[0].id;
  }

  function cardButton(card) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'automation-card-item';
    button.dataset.cardId = card.id;
    button.setAttribute('aria-current', String(card.id === state.selectedId));
    const name = document.createElement('strong');
    name.textContent = card.name || card.id || '未命名卡片';
    const detail = document.createElement('span');
    detail.textContent = card.updatedAt ? new Date(card.updatedAt).toLocaleString('zh-CN') : card.id;
    button.append(name, detail);
    button.addEventListener('click', () => void loadCard(card.id));
    return button;
  }

  function renderCards() {
    const list = element('automation-card-list');
    if (!list) return;
    list.replaceChildren(...state.cards.map(cardButton));
    if (!state.cards.length) {
      const empty = document.createElement('p');
      empty.className = 'shell-home-status';
      empty.textContent = '暂无卡片，点击“新建”开始。';
      list.append(empty);
    }
    element('automation-export').disabled = !state.selectedId;
    element('automation-delete').disabled = !state.selectedId;
  }

  function showCard(entry) {
    state.selectedId = String(entry?.id || '');
    state.cardData = entry?.cardData && typeof entry.cardData === 'object' ? entry.cardData : null;
    const card = state.cardData || {};
    element('automation-card-name').value = card.name || entry?.cardName || '';
    element('automation-card-website').value = card.website || '';
    element('automation-card-description').value = card.description || '';
    element('automation-card-steps').value = JSON.stringify(card.steps || [], null, 2);
    window.AppShellAutomationCanvas?.show?.(card);
    renderCards();
  }

  function acceptCanvasCard(card) {
    state.cardData = card;
    element('automation-card-steps').value = JSON.stringify(card.steps || [], null, 2);
  }

  function syncStepsToCanvas() {
    try {
      const steps = parseJson('automation-card-steps', []);
      if (!Array.isArray(steps)) throw new Error('步骤 JSON 必须是数组');
      state.cardData = { ...(state.cardData || {}), steps };
      window.AppShellAutomationCanvas?.show?.(state.cardData);
      setStatus('步骤 JSON 已同步到流程画布。');
      return true;
    } catch (error) { setStatus(error.message); return false; }
  }

  async function loadCard(id) {
    if (!id || state.busy) return;
    try {
      const result = await invoke({ action: 'get', id });
      showCard(result.item);
      setStatus(`已加载卡片：${result.item?.cardName || id}`);
    } catch (error) { setStatus(error.message); }
  }

  async function refresh() {
    if (state.busy) return;
    state.busy = true;
    setStatus('正在刷新卡片与原生浏览器连接…');
    try {
      const [cards, connections] = await Promise.all([
        invoke({ action: 'list' }),
        window.aiFree?.ai?.getBrowserConnections?.(),
      ]);
      state.cards = Array.isArray(cards?.items) ? cards.items : [];
      state.selectedId = cards?.selectedId || state.selectedId;
      state.connections = connections?.ok && Array.isArray(connections.connections) ? connections.connections : [];
      renderCards();
      renderConnections();
      if (state.selectedId && state.cards.some((item) => item.id === state.selectedId)) await loadCardNow(state.selectedId);
      else newCard(false);
      setStatus(`已加载 ${state.cards.length} 张卡片，${state.connections.length} 个原生浏览器连接。`);
    } catch (error) { setStatus(error.message); }
    finally { state.busy = false; }
  }

  async function loadCardNow(id) {
    const result = await invoke({ action: 'get', id });
    showCard(result.item);
  }

  function newCard(announce = true) {
    const card = {
      name: '', website: '', description: '',
      steps: [{ id: 'step_1', name: '等待页面就绪', type: 'wait', timeout: 1000 }],
    };
    showCard({ id: '', cardData: card });
    if (announce) setStatus('已创建未保存卡片，请填写名称、网站和步骤。');
  }

  async function saveCard(announce = true) {
    const data = await invoke({ action: 'write', id: state.selectedId, cardData: cardDraft() });
    showCard(data.item);
    state.cards = Array.isArray(data.state?.items)
      ? data.state.items.map((item) => ({ id: item.id, name: item.cardName, updatedAt: item.updatedAt }))
      : state.cards;
    renderCards();
    if (announce) setStatus(`卡片已保存：${data.item?.cardName || data.item?.id}`);
    return data.item;
  }

  async function runCard() {
    if (state.busy) return;
    state.busy = true;
    try {
      const connectionId = element('automation-browser-select').value;
      if (!connectionId) throw new Error('请先选择一个已连接的原生浏览器窗口');
      const item = await saveCard(false);
      setStatus('卡片正在通过 Chromium 原生控制运行…');
      const result = await invoke({ action: 'run', id: item.id, connectionId, inputs: parseJson('automation-run-inputs', {}) });
      window.AppShellAutomationCanvas?.markExecution?.(result.execution);
      setStatus(result);
    } catch (error) { setStatus(error.message); }
    finally { state.busy = false; }
  }

  async function deleteCard() {
    if (!state.selectedId || state.busy) return;
    if (!window.confirm('确认删除当前自动化卡片？')) return;
    try {
      await invoke({ action: 'delete', id: state.selectedId });
      state.selectedId = '';
      state.cardData = null;
      await refresh();
    } catch (error) { setStatus(error.message); }
  }

  function exportCard() {
    if (!state.selectedId) return;
    try {
      const card = cardDraft();
      const blob = new Blob([`${JSON.stringify(card, null, 2)}\n`], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${card.name || 'automation-card'}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) { setStatus(error.message); }
  }

  async function importCard(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const card = parsed.cardData && typeof parsed.cardData === 'object' ? parsed.cardData : parsed;
      showCard({ id: '', cardData: card });
      await saveCard();
    } catch (error) { setStatus(`卡片导入失败：${error.message}`); }
    element('automation-import-file').value = '';
  }

  async function saveSession() {
    const connectionId = element('automation-browser-select').value;
    if (!connectionId) return setStatus('请先选择一个已连接的原生浏览器窗口');
    try {
      const result = await window.aiFree?.ai?.saveAutomationSession?.({ connectionId, format: 'json' });
      if (!result?.ok) throw new Error(result?.message || '会话保存失败');
      setStatus(result.data);
    } catch (error) { setStatus(error.message); }
  }

  function bindDialog() {
    const dialog = element('automation-workbench-dialog');
    const opener = element('automation-workbench-open');
    if (!dialog || !opener) return;
    opener.addEventListener('click', () => {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      opener.setAttribute('aria-expanded', 'true');
      if (!state.initialized) {
        state.initialized = true;
        void refresh();
      } else {
        window.AppShellAutomationCanvas?.show?.(state.cardData || {});
      }
    });
    element('automation-workbench-close')?.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
      opener.setAttribute('aria-expanded', 'false');
      opener.focus();
    });
  }

  function setBasicInfoDialogOpen(open) {
    const dialog = element('automation-basic-info-dialog');
    const opener = element('automation-basic-info-open');
    if (!dialog || !opener) return;
    if (open) {
      if (!dialog.open) {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      }
      opener.setAttribute('aria-expanded', 'true');
      return;
    }
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function bindBasicInfoDialog() {
    const dialog = element('automation-basic-info-dialog');
    const opener = element('automation-basic-info-open');
    if (!dialog || !opener) return;
    opener.addEventListener('click', () => setBasicInfoDialogOpen(true));
    element('automation-basic-info-close')?.addEventListener('click', () => setBasicInfoDialogOpen(false));
    element('automation-basic-info-done')?.addEventListener('click', () => {
      if (syncStepsToCanvas()) setBasicInfoDialogOpen(false);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) setBasicInfoDialogOpen(false);
    });
    dialog.addEventListener('close', () => {
      opener.setAttribute('aria-expanded', 'false');
      opener.focus();
    });
  }

  function bind() {
    bindDialog();
    bindBasicInfoDialog();
    window.AppShellAutomationCanvas?.configure?.({ onChange: acceptCanvasCard });
    element('automation-editor')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void saveCard().catch((error) => {
        setStatus(error.message);
        if (/基础信息|JSON|URL/.test(error.message)) setBasicInfoDialogOpen(true);
      });
    });
    element('automation-new')?.addEventListener('click', () => newCard());
    element('automation-refresh')?.addEventListener('click', () => void refresh());
    element('automation-run')?.addEventListener('click', () => void runCard());
    element('automation-delete')?.addEventListener('click', () => void deleteCard());
    element('automation-export')?.addEventListener('click', exportCard);
    element('automation-import')?.addEventListener('click', () => element('automation-import-file')?.click());
    element('automation-import-file')?.addEventListener('change', (event) => void importCard(event.target.files?.[0]));
    element('automation-save-session')?.addEventListener('click', () => void saveSession());
    element('automation-card-steps')?.addEventListener('change', syncStepsToCanvas);
  }

  window.AppShellAutomationWorkbench = Object.freeze({ bind, refresh });
  if (document.documentElement.classList.contains('browser-settings-page')) bind();
})();
