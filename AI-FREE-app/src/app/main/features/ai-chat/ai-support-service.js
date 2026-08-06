'use strict';

const { createAiModelService } = require('./ai-model-service');
const { createAutomationCardService } = require('./automation-card-service');
const { enrichBrowserConnectionNames } = require('./connection-names');
const { normalizeAccountSession } = require('../../utils/account-session');

function createAiSupportService(deps = {}) {
  const modelService = createAiModelService(deps);
  const cardService = createAutomationCardService({
    bridge: deps.browserAutomationBridge,
    now: deps.now,
    logger: deps.logger,
  });

  function getBrowserConnections() {
    const connections = deps.browserAutomationBridge?.listConnections?.() || [];
    const tabs = deps.getTabs?.() || [];
    const runtimeStates = deps.browserRuntimeManager?.listStates?.() || [];
    return { ok: true, connections: enrichBrowserConnectionNames(connections, tabs, runtimeStates) };
  }

  async function redeemGiftCode(input = {}) {
    const credentials = normalizeAccountSession(deps.readStoreConfigSafe()?.userCredentials || {});
    const key = String(credentials.key || '').trim();
    const deviceId = String(await deps.computeDeviceId() || '').trim();
    const code = String(input.code || '').trim();
    if (!key || !deviceId) return { ok: false, message: '请先在个人中心登录账号' };
    if (!code) return { ok: false, message: '请输入礼品码' };
    const httpClient = deps.getGlobalHttpClient?.();
    if (!httpClient || typeof httpClient.redeemAIControlGiftCode !== 'function') {
      return { ok: false, message: 'AI 服务尚未就绪' };
    }
    return httpClient.redeemAIControlGiftCode(key, deviceId, code);
  }

  function broadcastBrowserSelection(input = {}) {
    const profileId = String(input?.profileId || '').trim();
    const profileIds = [...new Set((Array.isArray(input?.profileIds) ? input.profileIds : [profileId])
      .map((value) => String(value || '').trim()).filter(Boolean))];
    const mainWindow = deps.getMainWindow?.();
    if (!mainWindow || mainWindow.isDestroyed?.() || mainWindow.webContents?.isDestroyed?.()) return false;
    mainWindow.webContents.send('ai-control-browser-selection-changed', {
      profileId: profileIds[0] || '',
      profileIds,
    });
    return true;
  }

  return {
    broadcastBrowserSelection,
    getAutomationCards: cardService.getAutomationCards,
    getBrowserConnections,
    getModels: modelService.getModels,
    manageAutomationCard: cardService.manageAutomationCard,
    redeemGiftCode,
    saveAutomationSession: cardService.saveAutomationSession,
    selectAutomationCard: cardService.selectAutomationCard,
  };
}

module.exports = { createAiSupportService };
