'use strict';

const crypto = require('crypto');

const ACTIONS = new Set(['rules', 'list', 'get', 'write', 'patch_step', 'insert_step', 'delete_step', 'move_step', 'delete', 'run']);
const STEP_TYPES = new Set([
  'navigate', 'click', 'type', 'wait', 'condition', 'save_cookies',
  'clear_current_page_cache', 'get_credits', 'screenshot', 'mcp',
]);
const RULES = `原生自动化卡片格式：cardData 至少包含 name、website 或首个 navigate，以及非空 steps。
步骤 type 允许 navigate/click/type/wait/condition/save_cookies/clear_current_page_cache/get_credits/screenshot/mcp。
click/type/wait 使用 selector；type 可用 variable 与 inputs 覆盖 text；condition 支持 selector_exists/selector_missing/text_exists/text_missing/url_matches，可用 fail_on_false=true 把未满足条件作为卡片失败。
通用 MCP 步骤格式为 {type:"mcp",tool:"已有工具名",arguments:{...}}；arguments 支持 {变量名} 替换，但禁止递归调用 manage_card。
可选 flow={start,nodes,edges}，边 label 使用 next/default/true/false；有 flow 时没有出边的节点即为流程终点。MCP 不允许任意 JavaScript。`;

function text(value) { return String(value == null ? '' : value).trim(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function validateCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('cardData 必须是对象');
  if (!Array.isArray(card.steps) || !card.steps.length) throw new Error('cardData.steps 必须是非空数组');
  card.steps.forEach((step, index) => {
    const type = text(step?.type).toLowerCase();
    if (!STEP_TYPES.has(type)) throw new Error(`steps[${index}] 的 type 不受原生控制支持: ${type || '(空)'}`);
    if (type === 'condition' && text(step.condition_mode || step.condition).toLowerCase() === 'js') {
      throw new Error('原生自动化卡片禁止 JavaScript 条件');
    }
    if (type === 'mcp') {
      if (!text(step.tool)) throw new Error(`steps[${index}] 的 MCP 步骤缺少 tool`);
      const args = step.arguments ?? step.args ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error(`steps[${index}].arguments 必须是对象`);
      }
    }
  });
  if (!text(card.website) && !['navigate', 'mcp'].includes(text(card.steps[0]?.type).toLowerCase())) {
    throw new Error('卡片缺少 website 或入口 navigate 步骤');
  }
}

function resolveCard(state, args) {
  const id = text(args.id || state.selectedId);
  const byId = id ? state.items.find((item) => text(item.id) === id) : null;
  if (byId) return byId;
  const name = text(args.card_name);
  const matches = name ? state.items.filter((item) => text(item.cardName) === name) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`存在多个同名卡片「${name}」，请使用 id`);
  throw new Error(`自动化卡片不存在: ${id || name || '(未选择)'}`);
}

function normalizeInputs(args, card) {
  const source = Array.isArray(args.inputs)
    ? Object.fromEntries(args.inputs.map((value, index) => [`var${index + 1}`, value]))
    : { ...(args.inputs || {}) };
  let typeIndex = 0;
  for (const step of card.steps) {
    if (text(step.type).toLowerCase() !== 'type') continue;
    typeIndex += 1;
    const key = text(step.variable) || `var${typeIndex}`;
    if (source[key] === undefined) source[key] = step.text ?? '';
  }
  return source;
}

function substitute(value, inputs) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{([^{}]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(inputs, key) ? String(inputs[key]) : match
  ));
}

function materializeValue(value, inputs) {
  if (typeof value === 'string') return substitute(value, inputs);
  if (Array.isArray(value)) return value.map((item) => materializeValue(item, inputs));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materializeValue(item, inputs)]));
}

function materializeStep(step, inputs) {
  const result = materializeValue(step || {}, inputs);
  if (text(result.type).toLowerCase() === 'type') {
    const variable = text(result.variable);
    if (variable && inputs[variable] !== undefined) result.text = String(inputs[variable]);
  }
  return result;
}

function conditionPassed(step, result) {
  const mode = text(step.condition_mode || step.condition || 'selector_exists').toLowerCase();
  const found = result?.success === true && (Array.isArray(result.items) ? result.items.length > 0 : true);
  return mode.endsWith('_missing') ? !found : found;
}

function nextFlowIndex(card, currentIndex, branch) {
  const current = card.steps[currentIndex] || {};
  const currentId = text(current.id) || `step_${currentIndex + 1}`;
  const edges = Array.isArray(card.flow?.edges) ? card.flow.edges : [];
  const labels = branch === undefined ? ['next', 'default', ''] : [String(branch), 'default', 'next'];
  const edge = edges.find((item) => text(item.from || item.source) === currentId
    && labels.includes(text(item.label || item.branch || 'next').toLowerCase()));
  if (!edge) return -1;
  const target = text(edge.to || edge.target);
  return card.steps.findIndex((step, index) => (text(step.id) || `step_${index + 1}`) === target);
}

function initialStepIndex(card, args) {
  const requested = Number(args.start_step || 0);
  if (requested > 0) return Math.max(0, requested - 1);
  const startId = text(card.flow?.start);
  if (!startId) return 0;
  const found = card.steps.findIndex((step, index) => (text(step.id) || `step_${index + 1}`) === startId);
  return found >= 0 ? found : 0;
}

async function openCardWebsite(card, args, dispatch, execution) {
  if (Number(args.start_step || 0) > 1 || text(card.steps[0]?.type).toLowerCase() === 'navigate') return;
  const url = text(card.website);
  if (!url) return;
  const result = await dispatch('browser_tab', { action: 'replace', url });
  execution.push({ stepIndex: 0, name: '打开卡片网站', type: 'navigate', success: true, result });
}

async function executeCondition(step, dispatch) {
  const mode = text(step.condition_mode || step.condition || 'selector_exists').toLowerCase();
  if (mode === 'url_matches') {
    const listed = await dispatch('browser_tab', { action: 'list' });
    const url = text(listed?.activeTab?.url);
    return { success: url.includes(text(step.url || step.text)), matched: url };
  }
  const observe = await dispatch('browser_observe', {
    keyword: mode.startsWith('text_') ? text(step.text || step.wait_for_text) : '',
    limit: 20, mark: false,
  });
  return { ...observe, success: conditionPassed(step, observe) };
}

async function executeStep(step, dispatch) {
  const type = text(step.type).toLowerCase();
  if (type === 'navigate') return dispatch('browser_tab', { action: 'replace', url: step.url });
  if (type === 'click' || type === 'type') return dispatch('browser_action', { ...step, action: type });
  if (type === 'wait') return dispatch('browser_wait', {
    ...step, ms: step.timeout, timeout_ms: step.timeout, selector: step.selector || step.wait_for_element,
  });
  if (type === 'condition') return executeCondition(step, dispatch);
  if (type === 'save_cookies') return dispatch('browser_file', { ...step, action: 'save_session' });
  if (type === 'screenshot') return dispatch('browser_screenshot', step);
  if (type === 'get_credits') return dispatch('browser_observe', { keyword: step.selector || step.text, limit: 10, mark: false });
  if (type === 'mcp') return dispatch(text(step.tool), step.arguments ?? step.args ?? {});
  if (type === 'clear_current_page_cache') {
    throw new Error('当前 Chromium 原生协议尚未开放清理当前站点数据命令');
  }
  throw new Error(`未知卡片步骤类型: ${type}`);
}

function failedStepResult(error, index, inputs, execution) {
  return {
    success: false,
    errorCode: error?.errorCode || error?.code || 'CARD_STEP_FAILED',
    error: error?.message || String(error),
    stepIndex: index + 1,
    context: inputs,
    execution,
  };
}

function conditionMustPass(step) {
  return text(step.type).toLowerCase() === 'condition' && step.fail_on_false === true;
}

function toolResultFailed(step, result) {
  if (text(step.type).toLowerCase() === 'condition') return false;
  return result?.success === false || result?.ok === false;
}

function resultErrorMessage(step, result, failedCondition) {
  const reported = text(result?.error || result?.errorReason || result?.message);
  if (reported) return reported;
  if (failedCondition) return `条件未满足: ${text(step.name) || text(step.condition_mode) || 'condition'}`;
  return `步骤执行失败: ${text(step.name) || text(step.type) || 'unknown'}`;
}

function stepResultError(step, result) {
  const failedCondition = conditionMustPass(step) && result?.success !== true;
  const failedTool = toolResultFailed(step, result);
  if (!failedCondition && !failedTool) return null;
  const error = /** @type {Error & {errorCode?: string}} */ (
    new Error(resultErrorMessage(step, result, failedCondition))
  );
  error.errorCode = text(result?.errorCode || result?.code)
    || (failedCondition ? 'CARD_CONDITION_FAILED' : 'CARD_STEP_FAILED');
  return error;
}

async function runCard(card, args, dispatch) {
  const inputs = normalizeInputs(args, card);
  let index = initialStepIndex(card, args);
  let count = 0;
  const execution = [];
  await openCardWebsite(card, args, dispatch, execution);
  while (index >= 0 && count < Math.max(120, card.steps.length * 20)) {
    const step = materializeStep(card.steps[index], inputs);
    try {
      const result = await executeStep(step, dispatch);
      const resultError = stepResultError(step, result);
      if (resultError) throw resultError;
      execution.push({ stepIndex: index + 1, name: text(step.name), type: step.type, success: true, result });
      index = card.flow ? nextFlowIndex(card, index, text(step.type) === 'condition' ? result.success : undefined) : index + 1;
      if (index >= card.steps.length) index = -1;
    } catch (error) {
      execution.push({ stepIndex: index + 1, name: text(step.name), type: step.type, success: false, error: error?.message || String(error) });
      if (step.optional !== true) return failedStepResult(error, index, inputs, execution);
      index += 1;
    }
    count += 1;
  }
  if (count >= Math.max(120, card.steps.length * 20)) throw new Error('自动化卡片流程超过安全步数限制');
  return { success: true, cardName: text(card.name), context: inputs, execution };
}

class NativeAutomationCardService {
  constructor(options = {}) {
    this.read = options.read;
    this.write = options.write;
  }

  state() { return this.read().state; }

  persist(state) { return this.write(state); }

  writeCard(args) {
    validateCard(args.cardData);
    const state = this.state();
    const requestedId = text(args.id || args.cardData.id);
    const existing = requestedId
      ? state.items.find((item) => text(item.id) === requestedId)
      : state.items.find((item) => text(item.cardName) === text(args.cardData.name));
    const id = text(existing?.id) || requestedId || crypto.randomUUID();
    const entry = { id, cardName: text(args.cardData.name) || `automation_${Date.now()}`, cardData: clone(args.cardData), updatedAt: Date.now() };
    state.items = existing ? state.items.map((item) => item === existing ? entry : item) : [...state.items, entry];
    state.selectedId = id;
    this.persist(state);
    return { success: true, item: entry, state };
  }

  editStep(args, action) {
    const state = this.state();
    const entry = resolveCard(state, args);
    const card = clone(entry.cardData);
    const index = Math.max(0, Number(args.step_index || card.steps.length + 1) - 1);
    if (action === 'insert_step') card.steps.splice(index, 0, clone(args.stepData || {}));
    else if (action === 'delete_step') card.steps.splice(index, 1);
    else if (action === 'move_step') {
      const [step] = card.steps.splice(index, 1);
      card.steps.splice(Math.max(0, Number(args.to_step_index || 1) - 1), 0, step);
    } else {
      const patch = args.stepPatch || args.stepData || {};
      card.steps[index] = args.replace === true ? clone(patch) : { ...card.steps[index], ...clone(patch) };
    }
    return this.writeCard({ id: entry.id, cardData: card });
  }

  deleteCard(args) {
    const state = this.state();
    const entry = resolveCard(state, args);
    state.items = state.items.filter((item) => item !== entry);
    if (state.selectedId === entry.id) state.selectedId = state.items[0]?.id || '';
    this.persist(state);
    return { success: true, deletedId: entry.id, state };
  }

  async execute(args = {}, context = {}) {
    const action = text(args.action).toLowerCase();
    if (!ACTIONS.has(action)) throw new Error(`未知的 manage_card action: ${action || '(空)'}`);
    if (action === 'rules') return { success: true, rules: RULES, stepTypes: Array.from(STEP_TYPES) };
    const state = this.state();
    if (action === 'list') return { success: true, selectedId: state.selectedId, items: state.items.map((item) => ({ id: item.id, name: item.cardName, updatedAt: item.updatedAt })) };
    if (action === 'get') return { success: true, item: clone(resolveCard(state, args)) };
    if (action === 'write') return this.writeCard(args);
    if (action === 'delete') return this.deleteCard(args);
    if (['patch_step', 'insert_step', 'delete_step', 'move_step'].includes(action)) return this.editStep(args, action);
    const entry = resolveCard(state, args);
    validateCard(entry.cardData);
    return runCard(entry.cardData, args, context.dispatch);
  }
}

function createNativeAutomationCardService(options) { return new NativeAutomationCardService(options); }

module.exports = { createNativeAutomationCardService, runCard, validateCard };
