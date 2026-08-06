'use strict';

const { createAiChatService } = require('./ai-chat-service');

function registerAiChatIpc({ ipc, ...deps }) {
  const service = createAiChatService(deps);
  ipc.handle('ai-control-chat-insert', (event, input = {}) => service.insert(event, input));
  ipc.handle('ai-control-chat-stop', (event, input = {}) => service.stop(event, input));
  ipc.handle('ai-control-get-prompt-diagnostics', (event, input = {}) => service.getPromptDiagnostics(event, input));
  ipc.handle('ai-control-chat', (event, input = {}) => service.chat(event, input));
  return service;
}

module.exports = { registerAiChatIpc };
