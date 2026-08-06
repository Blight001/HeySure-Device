'use strict';

function registerAiHistoryIpc({ ipc, historyRepository, getCredentials }) {
  ipc.handle('ai-control-history-list', async () => {
    try {
      return historyRepository.listSessions(getCredentials());
    } catch (error) {
      return { ok: false, message: error?.message || String(error), sessions: [] };
    }
  });

  ipc.handle('ai-control-history-get', async (_event, input = {}) => {
    try {
      return historyRepository.getSession(getCredentials(), input?.id);
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipc.handle('ai-control-history-save', async (_event, input = {}) => {
    try {
      return historyRepository.saveSession(getCredentials(), input?.session || input || {}, {
        setCurrent: input?.setCurrent !== false,
      });
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipc.handle('ai-control-history-delete', async (_event, input = {}) => {
    try {
      return historyRepository.deleteSession(getCredentials(), input?.id);
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipc.handle('ai-control-history-rename', async (_event, input = {}) => {
    try {
      return historyRepository.renameSession(getCredentials(), input?.id, input?.title);
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });

  ipc.handle('ai-control-history-create', async (_event, input = {}) => {
    try {
      return historyRepository.createSession(getCredentials(), input || {});
    } catch (error) {
      return { ok: false, message: error?.message || String(error) };
    }
  });
}

module.exports = { registerAiHistoryIpc };
