(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TYPES = [
    ['navigate', '访问网页'], ['click', '点击元素'], ['type', '输入内容'],
    ['wait', '等待条件'], ['condition', '判断分支'], ['get_credits', '获取积分'],
    ['save_cookies', '保存会话'], ['screenshot', '截图'], ['mcp', '调用 MCP'],
  ];
  const CONDITIONS = [
    ['selector_exists', '元素存在'], ['selector_missing', '元素不存在'],
    ['text_exists', '文本存在'], ['text_missing', '文本不存在'], ['url_matches', 'URL 匹配'],
  ];
  const state = {
    card: { steps: [], flow: { start: '', nodes: [], edges: [] } },
    selectedNode: '', selectedEdge: '', scale: 1, x: 0, y: 0,
    connection: null, onChange: null, bound: false, mcpTools: [],
  };

  function element(id) { return document.getElementById(id); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function stepId(step, index) { return text(step?.id) || `step_${index + 1}`; }
  function nodeFor(id) { return state.card.flow.nodes.find((node) => node.id === id); }
  function stepIndex(id) { return state.card.steps.findIndex((step, index) => stepId(step, index) === id); }

  function defaultPosition(index) {
    return { x: 55 + (index % 4) * 235, y: 55 + Math.floor(index / 4) * 145 };
  }

  function normalizeCard(source = {}) {
    const card = clone(source && typeof source === 'object' ? source : {});
    card.steps = Array.isArray(card.steps) ? card.steps : [];
    card.steps = card.steps.map((step, index) => ({ ...step, id: stepId(step, index) }));
    const ids = new Set(card.steps.map((step) => step.id));
    const flow = card.flow && typeof card.flow === 'object' ? card.flow : {};
    const previous = new Map((Array.isArray(flow.nodes) ? flow.nodes : []).map((node) => [text(node?.id), node]));
    const nodes = card.steps.map((step, index) => {
      const prior = previous.get(step.id) || defaultPosition(index);
      return { id: step.id, x: Math.max(0, Number(prior.x) || 0), y: Math.max(0, Number(prior.y) || 0) };
    });
    const edges = (Array.isArray(flow.edges) ? flow.edges : []).filter((edge) => ids.has(text(edge?.from)) && ids.has(text(edge?.to)))
      .map((edge, index) => ({
        id: text(edge.id) || `edge_${index + 1}`, from: text(edge.from), to: text(edge.to),
        label: text(edge.label) || 'next', fromPort: 'right', toPort: 'left',
      }));
    const start = ids.has(text(flow.start)) ? text(flow.start) : (card.steps[0]?.id || '');
    card.flow = { ...flow, start, nodes, edges };
    return card;
  }

  function notify() {
    state.onChange?.(clone(state.card));
  }

  function applyTransform() {
    const viewport = element('automation-flow-viewport');
    if (viewport) viewport.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    const reset = element('automation-canvas-zoom-reset');
    if (reset) reset.textContent = `${Math.round(state.scale * 100)}%`;
  }

  function portPoint(node, label, input = false) {
    if (input) return { x: node.x, y: node.y + 38 };
    if (label === 'true') return { x: node.x + 170, y: node.y + 28 };
    if (label === 'false') return { x: node.x + 170, y: node.y + 54 };
    return { x: node.x + 170, y: node.y + 38 };
  }

  function edgePath(from, to) {
    const bend = Math.max(70, Math.abs(to.x - from.x) * 0.45);
    return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
  }

  function svgNode(name, attributes = {}) {
    const node = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  function renderEdges() {
    const svg = element('automation-flow-svg');
    if (!svg) return;
    svg.replaceChildren();
    const defs = svgNode('defs');
    const marker = svgNode('marker', { id: 'automation-flow-arrow', markerWidth: 10, markerHeight: 10, refX: 9, refY: 3, orient: 'auto' });
    marker.append(svgNode('path', { d: 'M0,0 L0,6 L9,3 z', fill: '#64748b' }));
    defs.append(marker);
    svg.append(defs);
    for (const edge of state.card.flow.edges) {
      const source = nodeFor(edge.from);
      const target = nodeFor(edge.to);
      if (!source || !target) continue;
      const from = portPoint(source, edge.label);
      const to = portPoint(target, '', true);
      const path = svgNode('path', {
        d: edgePath(from, to), class: `automation-flow-edge${edge.id === state.selectedEdge ? ' is-selected' : ''}`,
        'marker-end': 'url(#automation-flow-arrow)', 'data-edge-id': edge.id,
      });
      path.addEventListener('pointerdown', (event) => {
        event.stopPropagation(); state.selectedEdge = edge.id; state.selectedNode = ''; render();
      });
      svg.append(path);
      if (['true', 'false'].includes(edge.label)) {
        const label = svgNode('text', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 7, class: 'automation-flow-edge-label' });
        label.textContent = edge.label;
        svg.append(label);
      }
    }
  }

  function nodeMeta(step) {
    return [step.tool, step.url, step.selector, step.text, step.variable, step.condition_mode]
      .map(text).find(Boolean) || '未配置参数';
  }

  function createPort(id, label, input = false) {
    const port = document.createElement('button');
    port.type = 'button';
    port.className = `automation-flow-port ${input ? 'is-input' : 'is-output'}${label ? ` is-${label}` : ''}`;
    port.dataset.canvasPort = input ? 'target' : 'source';
    port.dataset.nodeId = id;
    port.dataset.edgeLabel = label || 'next';
    port.setAttribute('aria-label', input ? '输入端点' : `${label || 'next'} 输出端点`);
    if (!input) port.addEventListener('pointerdown', beginConnection);
    return port;
  }

  function createNode(step, index) {
    const id = step.id;
    const position = nodeFor(id) || defaultPosition(index);
    const node = document.createElement('div');
    node.className = `automation-flow-node${id === state.selectedNode ? ' is-selected' : ''}`;
    node.dataset.nodeId = id;
    node.style.left = `${position.x}px`;
    node.style.top = `${position.y}px`;
    const top = document.createElement('div');
    top.className = 'automation-flow-node-top';
    top.append(Object.assign(document.createElement('span'), { textContent: `#${index + 1}` }),
      Object.assign(document.createElement('span'), { textContent: TYPES.find(([type]) => type === step.type)?.[1] || step.type }));
    const title = Object.assign(document.createElement('div'), { className: 'automation-flow-node-title', textContent: text(step.name) || `步骤 ${index + 1}` });
    const meta = Object.assign(document.createElement('div'), { className: 'automation-flow-node-meta', textContent: nodeMeta(step) });
    node.append(top, title, meta, createPort(id, '', true));
    if (step.type === 'condition') node.append(createPort(id, 'true'), createPort(id, 'false'));
    else node.append(createPort(id, 'next'));
    node.addEventListener('pointerdown', beginNodeDrag);
    node.addEventListener('click', () => { state.selectedNode = id; state.selectedEdge = ''; render(); });
    return node;
  }

  function renderInspector() {
    const index = stepIndex(state.selectedNode);
    const step = state.card.steps[index];
    const inspector = element('automation-node-inspector');
    const fields = element('automation-node-fields');
    if (!inspector || !fields) return;
    inspector.hidden = !step;
    fields.hidden = !step;
    if (!step) return;
    element('automation-node-title').textContent = `节点 #${index + 1}`;
    const toolSelect = fields.querySelector('[data-node-field="tool"]');
    const toolOptions = state.mcpTools.map((tool) => [tool.name, tool.description ? `${tool.name} — ${tool.description}` : tool.name]);
    if (step.tool && !toolOptions.some(([name]) => name === step.tool)) toolOptions.unshift([step.tool, `${step.tool}（当前不可用）`]);
    fillSelect(toolSelect, toolOptions.length ? toolOptions : [['', '暂无可用 MCP 工具']]);
    for (const control of fields.querySelectorAll('[data-node-field]')) {
      const key = control.dataset.nodeField;
      if (key === 'raw') control.value = JSON.stringify(step, null, 2);
      else if (key === 'arguments') control.value = JSON.stringify(step.arguments || {}, null, 2);
      else control.value = step[key] ?? '';
    }
    fields.querySelectorAll('[data-node-types]').forEach((label) => {
      label.hidden = !String(label.dataset.nodeTypes || '').split(',').includes(step.type);
    });
  }

  function render() {
    const container = element('automation-flow-nodes');
    if (!container) return;
    renderEdges();
    container.replaceChildren(...state.card.steps.map(createNode));
    element('automation-flow-empty').hidden = state.card.steps.length > 0;
    renderInspector();
    applyTransform();
  }

  function beginNodeDrag(event) {
    if (event.button !== 0 || event.target.closest('[data-canvas-port]')) return;
    const id = event.currentTarget.dataset.nodeId;
    const node = nodeFor(id);
    if (!node) return;
    event.preventDefault();
    state.selectedNode = id; state.selectedEdge = '';
    const start = { clientX: event.clientX, clientY: event.clientY, x: node.x, y: node.y };
    const move = (next) => {
      node.x = Math.max(0, start.x + (next.clientX - start.clientX) / state.scale);
      node.y = Math.max(0, start.y + (next.clientY - start.clientY) / state.scale);
      render();
    };
    const up = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); notify();
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }

  function canvasPoint(event) {
    const rect = element('automation-flow-canvas').getBoundingClientRect();
    return { x: (event.clientX - rect.left - state.x) / state.scale, y: (event.clientY - rect.top - state.y) / state.scale };
  }

  function beginConnection(event) {
    event.preventDefault(); event.stopPropagation();
    const source = event.currentTarget;
    state.connection = { from: source.dataset.nodeId, label: source.dataset.edgeLabel || 'next' };
    const preview = svgNode('path', { class: 'automation-flow-edge-preview' });
    element('automation-flow-svg').append(preview);
    const move = (next) => {
      const origin = portPoint(nodeFor(state.connection.from), state.connection.label);
      preview.setAttribute('d', edgePath(origin, canvasPoint(next)));
    };
    const up = (next) => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      const target = document.elementFromPoint(next.clientX, next.clientY)?.closest('[data-canvas-port="target"]');
      if (target?.dataset.nodeId && target.dataset.nodeId !== state.connection.from) addEdge(state.connection, target.dataset.nodeId);
      state.connection = null; render();
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }

  function addEdge(source, to) {
    state.card.flow.edges = state.card.flow.edges.filter((edge) => !(edge.from === source.from && edge.label === source.label));
    state.card.flow.edges.push({
      id: `edge_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`,
      from: source.from, to, label: source.label, fromPort: 'right', toPort: 'left',
    });
    notify();
  }

  function template(type) {
    const labels = Object.fromEntries(TYPES);
    const step = { id: `step_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`, name: labels[type] || type, type };
    if (type === 'wait') step.timeout = 1000;
    if (type === 'condition') step.condition_mode = 'selector_exists';
    if (type === 'mcp') {
      step.tool = state.mcpTools[0]?.name || '';
      step.arguments = {};
    }
    return step;
  }

  function addStep(type, requestedPosition = null) {
    const step = template(type);
    const previous = state.card.steps.at(-1);
    state.card.steps.push(step);
    const position = requestedPosition || defaultPosition(state.card.steps.length - 1);
    state.card.flow.nodes.push({ id: step.id, ...position });
    if (!state.card.flow.start) state.card.flow.start = step.id;
    if (previous) addEdge({ from: previous.id, label: previous.type === 'condition' ? 'true' : 'next' }, step.id);
    state.selectedNode = step.id; state.selectedEdge = ''; notify(); render();
  }

  function deleteSelection() {
    if (state.selectedEdge) {
      state.card.flow.edges = state.card.flow.edges.filter((edge) => edge.id !== state.selectedEdge);
      state.selectedEdge = ''; notify(); render(); return;
    }
    if (!state.selectedNode) return;
    const id = state.selectedNode;
    state.card.steps = state.card.steps.filter((step) => step.id !== id);
    state.card.flow.nodes = state.card.flow.nodes.filter((node) => node.id !== id);
    state.card.flow.edges = state.card.flow.edges.filter((edge) => edge.from !== id && edge.to !== id);
    if (state.card.flow.start === id) state.card.flow.start = state.card.steps[0]?.id || '';
    state.selectedNode = ''; notify(); render();
  }

  function moveSelected(delta) {
    const index = stepIndex(state.selectedNode);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= state.card.steps.length) return;
    const [step] = state.card.steps.splice(index, 1);
    state.card.steps.splice(target, 0, step); notify(); render();
  }

  function graphLayout() {
    const ids = state.card.steps.map((step) => step.id);
    const outgoing = new Map(ids.map((id) => [id, []]));
    const incoming = new Map(ids.map((id) => [id, 0]));
    for (const edge of state.card.flow.edges) {
      if (!outgoing.has(edge.from) || !incoming.has(edge.to)) continue;
      outgoing.get(edge.from).push(edge.to);
      incoming.set(edge.to, incoming.get(edge.to) + 1);
    }
    const roots = ids.filter((id) => incoming.get(id) === 0);
    const queue = [...new Set([state.card.flow.start, ...roots].filter((id) => outgoing.has(id)))];
    const layer = new Map(queue.map((id) => [id, 0]));
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const id = queue[cursor];
      for (const target of outgoing.get(id)) {
        if (layer.has(target)) continue;
        layer.set(target, layer.get(id) + 1);
        queue.push(target);
      }
    }
    let fallbackLayer = Math.max(0, ...layer.values()) + 1;
    ids.forEach((id) => { if (!layer.has(id)) layer.set(id, fallbackLayer++); });
    const rows = new Map();
    return ids.map((id) => {
      const column = layer.get(id);
      const row = rows.get(column) || 0;
      rows.set(column, row + 1);
      return { id, x: 55 + column * 235, y: 55 + row * 135 };
    });
  }

  function autoLayout() {
    state.card.flow.nodes = graphLayout();
    state.x = 0; state.y = 0; state.scale = 1; notify(); render();
  }

  function setZoom(nextScale, anchor = null) {
    const previousScale = state.scale;
    state.scale = Math.min(2, Math.max(0.4, Math.round(nextScale * 10) / 10));
    if (anchor && state.scale !== previousScale) {
      const rect = element('automation-flow-canvas').getBoundingClientRect();
      const localX = anchor.clientX - rect.left;
      const localY = anchor.clientY - rect.top;
      const contentX = (localX - state.x) / previousScale;
      const contentY = (localY - state.y) / previousScale;
      state.x = localX - contentX * state.scale;
      state.y = localY - contentY * state.scale;
    }
    applyTransform();
  }

  function zoom(delta) { setZoom(state.scale + delta); }

  function zoomFromWheel(event) {
    event.preventDefault();
    if (event.deltaY === 0) return;
    setZoom(state.scale + (event.deltaY < 0 ? 0.1 : -0.1), event);
  }

  function beginPan(event) {
    const canvas = element('automation-flow-canvas');
    const panTargets = [canvas, element('automation-flow-viewport'), element('automation-flow-svg'), element('automation-flow-nodes')];
    if (event.button !== 0 || !panTargets.includes(event.target)) return;
    event.preventDefault();
    state.selectedNode = ''; state.selectedEdge = ''; render();
    canvas.classList.add('is-panning');
    const start = { clientX: event.clientX, clientY: event.clientY, x: state.x, y: state.y };
    const move = (next) => { state.x = start.x + next.clientX - start.clientX; state.y = start.y + next.clientY - start.clientY; applyTransform(); };
    const up = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); canvas.classList.remove('is-panning');
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }

  function updateField(control) {
    const index = stepIndex(state.selectedNode);
    if (index < 0) return;
    const key = control.dataset.nodeField;
    if (key === 'raw') {
      try {
        const parsed = JSON.parse(control.value);
        state.card.steps[index] = { ...parsed, id: state.selectedNode };
      } catch (_) { return; }
    } else if (key === 'arguments') {
      try {
        const parsed = JSON.parse(control.value || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        state.card.steps[index].arguments = parsed;
      } catch (_) { return; }
    } else if (key === 'timeout') {
      state.card.steps[index][key] = control.value === '' ? '' : Number(control.value);
    } else state.card.steps[index][key] = control.value;
    notify(); render();
  }

  function fillSelect(control, options) {
    control.replaceChildren(...options.map(([value, label]) => Object.assign(document.createElement('option'), { value, textContent: label })));
  }

  function bind() {
    if (state.bound || !element('automation-flow-canvas')) return;
    state.bound = true;
    fillSelect(document.querySelector('[data-node-field="type"]'), TYPES);
    fillSelect(document.querySelector('[data-node-field="condition_mode"]'), CONDITIONS);
    document.querySelectorAll('[data-canvas-add]').forEach((button) => {
      button.draggable = true;
      button.addEventListener('click', () => addStep(button.dataset.canvasAdd));
      button.addEventListener('dragstart', (event) => event.dataTransfer?.setData('application/x-ai-free-step', button.dataset.canvasAdd));
    });
    document.querySelectorAll('[data-node-field]').forEach((control) => control.addEventListener('change', () => updateField(control)));
    document.querySelectorAll('[data-node-command]').forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.nodeCommand === 'delete') deleteSelection();
      else moveSelected(button.dataset.nodeCommand === 'up' ? -1 : 1);
    }));
    element('automation-flow-canvas').addEventListener('pointerdown', beginPan);
    element('automation-flow-canvas').addEventListener('wheel', zoomFromWheel, { passive: false });
    element('automation-flow-canvas').addEventListener('dragover', (event) => event.preventDefault());
    element('automation-flow-canvas').addEventListener('drop', (event) => {
      event.preventDefault();
      const type = event.dataTransfer?.getData('application/x-ai-free-step');
      if (TYPES.some(([value]) => value === type)) addStep(type, canvasPoint(event));
    });
    element('automation-flow-canvas').addEventListener('keydown', (event) => {
      if (['Delete', 'Backspace'].includes(event.key) && !event.target.matches('input,textarea,select')) deleteSelection();
    });
    element('automation-canvas-layout').addEventListener('click', autoLayout);
    element('automation-canvas-zoom-out').addEventListener('click', () => zoom(-0.1));
    element('automation-canvas-zoom-in').addEventListener('click', () => zoom(0.1));
    element('automation-canvas-zoom-reset').addEventListener('click', () => { state.scale = 1; state.x = 0; state.y = 0; applyTransform(); });
  }

  function configure(options = {}) { state.onChange = options.onChange; bind(); }
  function setMcpTools(tools = []) {
    state.mcpTools = (Array.isArray(tools) ? tools : [])
      .map((tool) => ({ name: text(tool?.name), description: text(tool?.description) }))
      .filter((tool) => tool.name);
    render();
  }
  function show(card) {
    state.card = normalizeCard(card); state.selectedNode = ''; state.selectedEdge = ''; notify(); render();
  }
  function markExecution(execution = []) {
    document.querySelectorAll('.automation-flow-node').forEach((node) => node.classList.remove('is-running', 'is-success', 'is-error'));
    for (const item of Array.isArray(execution) ? execution : []) {
      const step = state.card.steps[Number(item.stepIndex || 0) - 1];
      const node = step && document.querySelector(`[data-node-id="${step.id}"]`);
      node?.classList.add(item.success === false ? 'is-error' : 'is-success');
    }
  }

  window.AppShellAutomationCanvas = Object.freeze({ configure, markExecution, setMcpTools, show });
})();
