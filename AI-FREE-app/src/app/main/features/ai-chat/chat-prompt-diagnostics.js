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
    lastRequest: lastRequest ? clonePromptValue(lastRequest) : null,
  };
}

module.exports = { buildPromptPreview, clonePromptValue, createPromptDiagnostics };
