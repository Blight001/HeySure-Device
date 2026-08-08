'use strict';

const {
  normalizeChatOptions,
  resolveAutomationCard,
  resolveConnections,
} = require('./chat-request-context');
const { buildChatToolContext } = require('./chat-tool-context');

function clonePromptValue(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function summarizeMcpTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    const schema = tool?.input_schema || tool?.inputSchema || {};
    const actions = schema?.properties?.action?.enum;
    return {
      name: String(tool?.name || '未命名工具'),
      description: String(tool?.description || '暂无功能说明'),
      actions: Array.isArray(actions) ? actions.map((action) => String(action)) : [],
      destructive: tool?.destructive === true,
    };
  });
}

function buildPromptPreview(deps, input, getWindowTools) {
  const options = normalizeChatOptions({ ...input, disableTools: false, stream: false });
  const resolvedConnections = resolveConnections(deps, options);
  if (resolvedConnections.error) return resolvedConnections.error;
  const resolvedCard = resolveAutomationCard(deps, options);
  if (resolvedCard.error) return resolvedCard.error;
  const toolContext = buildChatToolContext({
    connections: resolvedConnections.connections,
    controlledConnectionId: resolvedConnections.controlledConnectionId,
    windowTools: getWindowTools(),
    selectedAutomationCard: resolvedCard.selectedAutomationCard,
    automationCardId: options.automationCardId,
    initialMessages: options.initialMessages,
  });
  return {
    modelId: String(input.modelId || ''),
    messages: clonePromptValue(toolContext.modelMessages),
    tools: clonePromptValue(toolContext.tools),
    runId: '',
    round: null,
  };
}

function createPromptDiagnostics(deps, input, getWindowTools, lastRequest) {
  const preview = buildPromptPreview(deps, input, getWindowTools);
  if (preview?.ok === false) return preview;
  return {
    ok: true,
    preview,
    mcpTools: summarizeMcpTools(preview.tools),
    lastRequest: lastRequest ? clonePromptValue(lastRequest) : null,
  };
}

module.exports = {
  buildPromptPreview,
  clonePromptValue,
  createPromptDiagnostics,
  summarizeMcpTools,
};
