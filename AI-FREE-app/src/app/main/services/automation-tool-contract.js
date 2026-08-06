'use strict';

const BROWSER_ROUTE_DESCRIPTION = '可选。切换唯一的当前控制浏览器，填写连接 ID 或唯一名称；省略则继续控制当前浏览器。';

function normalizeToolSchema(tool = {}) {
  const source = tool.input_schema || tool.inputSchema || { type: 'object', properties: {} };
  return {
    ...source,
    type: 'object',
    properties: { ...(source.properties || {}) },
    required: Array.isArray(source.required) ? [...source.required] : [],
  };
}

function addBrowserRouteToSchema(tool = {}, description = BROWSER_ROUTE_DESCRIPTION) {
  const schema = normalizeToolSchema(tool);
  schema.properties.change_browser = schema.properties.change_browser || {
    type: 'string',
    description,
  };
  return schema;
}

function withBrowserRouteParam(tool = {}, description) {
  return {
    ...tool,
    input_schema: addBrowserRouteToSchema(tool, description),
  };
}

function browserReference(args = {}) {
  return String(args.change_browser ?? args.browser_id ?? args.browser_name ?? args.browser ?? '').trim();
}

function findConnectionByReference(connections, reference) {
  const wanted = String(reference || '').trim();
  if (!wanted) return { kind: 'empty' };
  const byId = connections.find((item) => String(item?.id || '') === wanted);
  if (byId) return { kind: 'found', connection: byId };
  const lowered = wanted.toLocaleLowerCase();
  const matches = connections.filter((item) => {
    const names = [item?.browserName, item?.name, item?.pluginName];
    return names.some((name) => String(name || '').trim().toLocaleLowerCase() === lowered);
  });
  if (matches.length === 1) return { kind: 'found', connection: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', reference: wanted };
  return { kind: 'not_found', reference: wanted };
}

function resolveBrowserConnection(connections, args = {}, controlledConnectionId = '') {
  const reference = browserReference(args);
  if (reference) return findConnectionByReference(connections, reference);
  const controlled = connections.find(
    (item) => String(item?.id || '') === String(controlledConnectionId || ''),
  );
  if (controlled) return { kind: 'found', connection: controlled };
  if (connections.length === 1) return { kind: 'found', connection: connections[0] };
  return { kind: connections.length ? 'selection_required' : 'unavailable' };
}

function resolveDispatchTimeout(toolName, args = {}) {
  const requestedSeconds = Number(args.timeout_seconds || 0);
  if (requestedSeconds > 0) return Math.min(1800, Math.max(1, requestedSeconds)) * 1000;
  const isCardRun = toolName === 'manage_card'
    && String(args.action || '').trim().toLowerCase() === 'run';
  return isCardRun ? 900000 : 180000;
}

function sanitizeBrowserRoutingArgs(source = {}) {
  const args = { ...source };
  for (const key of ['change_browser', 'browser_id', 'browser_name', 'browser']) delete args[key];
  return args;
}

function errorValue(error, key) {
  return error && typeof error === 'object' ? error[key] : undefined;
}

function firstText(values, fallback) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return fallback;
}

function normalizeToolError(error, defaults = {}) {
  const normalized = {
    code: firstText(
      [errorValue(error, 'errorCode'), errorValue(error, 'code'), defaults.code],
      'MCP_TOOL_FAILED',
    ),
    message: firstText([errorValue(error, 'message'), error, defaults.message], 'MCP 工具执行失败'),
    phase: firstText([errorValue(error, 'phase'), defaults.phase], 'tool_dispatch'),
    retryable: [
      errorValue(error, 'retryable'),
      errorValue(error, 'recoverable'),
      defaults.retryable,
    ].includes(true),
  };
  const timeoutMs = Number(errorValue(error, 'timeoutMs') || 0);
  if (timeoutMs > 0) normalized.timeoutMs = timeoutMs;
  return normalized;
}

module.exports = {
  BROWSER_ROUTE_DESCRIPTION,
  addBrowserRouteToSchema,
  browserReference,
  findConnectionByReference,
  normalizeToolError,
  normalizeToolSchema,
  resolveBrowserConnection,
  resolveDispatchTimeout,
  sanitizeBrowserRoutingArgs,
  withBrowserRouteParam,
};
