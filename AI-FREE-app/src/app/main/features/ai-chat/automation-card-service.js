'use strict';

const { callOptional, firstText } = require('../../../shared/safe-values');

async function importConnectionCards(context, connection, imported) {
  const { bridge, timestamp, logger } = context;
  const fullConnection = callOptional(bridge, 'getConnection', connection.id);
  const supportsCards = fullConnection && Array.isArray(fullConnection.tools)
    && fullConnection.tools.some((tool) => firstText(tool && tool.name) === 'manage_card');
  if (!supportsCards) return;
  try {
    const listed = await bridge.dispatch(connection.id, 'manage_card', { action: 'list' }, { timeoutMs: 10000 });
    const summaries = listed && Array.isArray(listed.items) ? listed.items : [];
    for (const summary of summaries) {
      const id = firstText(summary && summary.id).trim();
      if (!id) continue;
      const detail = await bridge.dispatch(connection.id, 'manage_card', { action: 'get', id }, { timeoutMs: 10000 });
      if (!detail || !detail.cardData || typeof detail.cardData !== 'object') continue;
      imported.push({
        id,
        cardData: detail.cardData,
        cardName: firstText(detail.cardName, detail.cardData.name, id),
        savedAt: firstText(detail.savedAt, summary && summary.savedAt, new Date(timestamp).toISOString()),
      });
    }
  } catch (error) {
    callOptional(logger, 'warn', '[AutomationBridge] 从旧浏览器迁移卡片失败', {
      connectionId: connection.id,
      error: firstText(error && error.message, error),
    });
  }
}

function mergeImportedCards(current, imported) {
  const currentItems = Array.isArray(current.items) ? current.items : [];
  const byId = new Map(currentItems.map((item) => [firstText(item && item.id), item]));
  for (const item of imported) {
    const previous = byId.get(item.id);
    if (!previous || Date.parse(item.savedAt || '') >= Date.parse(previous.savedAt || '')) byId.set(item.id, item);
  }
  const items = Array.from(byId.values()).filter((item) => item && item.id);
  const selectedId = firstText(
    current.selectedId,
    imported[0] && imported[0].id,
    items[0] && items[0].id,
  );
  return { items, selectedId };
}

async function importLegacyCards(context) {
  const { bridge, now, state } = context;
  if (!bridge || typeof bridge.dispatch !== 'function' || typeof bridge.setCardCacheState !== 'function') return null;
  const timestamp = now();
  if (timestamp - state.lastAttemptAt < 15000) return null;
  state.lastAttemptAt = timestamp;
  const imported = [];
  for (const connection of callOptional(bridge, 'listConnections') || []) {
    await importConnectionCards({ ...context, timestamp }, connection, imported);
  }
  if (!imported.length) return null;
  const cached = callOptional(bridge, 'getCardCacheState');
  const current = cached && cached.state ? cached.state : { items: [], selectedId: '' };
  return bridge.setCardCacheState(mergeImportedCards(current, imported));
}

async function getAutomationCards(context) {
  const { bridge } = context;
  let cached = callOptional(bridge, 'getCardCacheState') || { exists: false, state: { items: [], selectedId: '' } };
  if (!cached.state || !Array.isArray(cached.state.items) || cached.state.items.length === 0) {
    const migrated = await importLegacyCards(context);
    if (migrated) cached = { exists: true, state: migrated };
  }
  const items = cached.state && Array.isArray(cached.state.items) ? cached.state.items : [];
  return {
    ok: true,
    selectedId: firstText(cached.state && cached.state.selectedId),
    cards: items.map((item) => ({
      id: firstText(item && item.id),
      name: firstText(item && item.cardName, item && item.cardData && item.cardData.name, item && item.id, '未命名卡片'),
      stepCount: item && item.cardData && Array.isArray(item.cardData.steps) ? item.cardData.steps.length : 0,
      savedAt: firstText(item && item.savedAt),
    })).filter((item) => item.id),
  };
}

function selectAutomationCard(bridge, input = {}) {
  const selected = callOptional(bridge, 'selectCard', input && input.id);
  if (!selected || !selected.item) throw new Error('软件卡片库不可用');
  return {
    ok: true,
    selectedId: firstText(selected.state && selected.state.selectedId),
    card: {
      id: firstText(selected.item.id),
      name: firstText(selected.item.cardName, selected.item.cardData && selected.item.cardData.name, selected.item.id, '未命名卡片'),
      stepCount: selected.item.cardData && Array.isArray(selected.item.cardData.steps) ? selected.item.cardData.steps.length : 0,
    },
  };
}

async function manageAutomationCard(bridge, input = {}) {
  if (!bridge || typeof bridge.manageCard !== 'function') throw new Error('软件卡片库不可用');
  const args = { .../** @type {Record<string, any>} */ (input) };
  const connectionId = args.connectionId;
  delete args.connectionId;
  const data = await bridge.manageCard(connectionId, args, { timeoutMs: 30 * 60 * 1000 });
  return { ok: true, data };
}

async function saveAutomationSession(bridge, input = {}) {
  if (!bridge || typeof bridge.saveBrowserSession !== 'function') throw new Error('浏览器会话保存功能不可用');
  const connectionId = firstText(input && input.connectionId);
  if (!connectionId) throw new Error('请先选择已连接的浏览器窗口');
  const data = await bridge.saveBrowserSession(connectionId, {
    format: firstText(input && input.format, 'json'),
  }, { timeoutMs: 120000 });
  return { ok: true, data };
}

function createAutomationCardService({ bridge, now = Date.now, logger = console }) {
  const context = { bridge, now, logger, state: { lastAttemptAt: 0 } };
  return {
    getAutomationCards: () => getAutomationCards(context),
    manageAutomationCard: (input) => manageAutomationCard(bridge, input),
    saveAutomationSession: (input) => saveAutomationSession(bridge, input),
    selectAutomationCard: (input) => selectAutomationCard(bridge, input),
  };
}

module.exports = { createAutomationCardService };
