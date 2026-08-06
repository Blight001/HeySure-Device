'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAutomationCardService } = require('../../../src/app/main/features/ai-chat/automation-card-service');

test('card listing maps durable cache records and selection details', async () => {
  const state = { items: [
    { id: 'one', cardName: 'First', cardData: { name: 'Fallback', steps: [{}, {}] }, savedAt: 'now' },
    { id: '', cardData: {} },
  ], selectedId: 'one' };
  const bridge = {
    getCardCacheState: () => ({ exists: true, state }),
    selectCard: (id) => ({ state: { selectedId: id }, item: state.items[0] }),
  };
  const service = createAutomationCardService({ bridge });
  assert.deepEqual(await service.getAutomationCards(), {
    ok: true, selectedId: 'one', cards: [{ id: 'one', name: 'First', stepCount: 2, savedAt: 'now' }],
  });
  assert.deepEqual(service.selectAutomationCard({ id: 'one' }), {
    ok: true, selectedId: 'one', card: { id: 'one', name: 'First', stepCount: 2 },
  });
  assert.throws(() => createAutomationCardService({ bridge: {} }).selectAutomationCard({}), /卡片库不可用/);
});

test('legacy migration imports supported connection cards and keeps newer cache entries', async () => {
  let saved = null;
  const warnings = [];
  const bridge = {
    getCardCacheState: () => ({ exists: true, state: {
      items: [{ id: 'same', cardName: 'Newer', cardData: { name: 'Newer', steps: [] }, savedAt: '2026-01-02T00:00:00.000Z' }],
      selectedId: '',
    } }),
    setCardCacheState: (state) => { saved = state; return state; },
    listConnections: () => [{ id: 'supported' }, { id: 'unsupported' }, { id: 'broken' }],
    getConnection: (id) => ({ tools: id === 'unsupported' ? [] : [{ name: 'manage_card' }] }),
    dispatch: async (id, tool, input) => {
      assert.equal(tool, 'manage_card');
      if (id === 'broken') throw new Error('connection lost');
      if (input.action === 'list') return { items: [
        { id: 'same', savedAt: '2026-01-01T00:00:00.000Z' }, { id: 'fresh' }, { id: '' },
      ] };
      if (input.id === 'same') return { cardData: { name: 'Older', steps: [{}] } };
      return { cardData: { name: 'Fresh', steps: [{}] }, cardName: '', savedAt: '' };
    },
  };
  let now = 20000;
  const service = createAutomationCardService({ bridge, now: () => now, logger: { warn: (...args) => warnings.push(args) } });
  const result = await service.getAutomationCards();
  assert.deepEqual(result.cards.map((card) => card.id), ['same']);
  assert.equal(saved, null);
  // Empty durable cache triggers legacy migration.
  bridge.getCardCacheState = () => saved
    ? { exists: true, state: saved }
    : { exists: false, state: { items: [], selectedId: '' } };
  now = 40000;
  const migrated = await service.getAutomationCards();
  assert.deepEqual(migrated.cards.map((card) => card.id), ['same', 'fresh']);
  assert.equal(saved.selectedId, 'same');
  assert.equal(warnings.length, 1);
  // A second immediate request observes the persisted cache and does not re-import.
  assert.equal((await service.getAutomationCards()).cards.length, 2);
});

test('missing bridge and empty legacy results return an empty stable response', async () => {
  const service = createAutomationCardService({ bridge: null, now: () => 20000 });
  assert.deepEqual(await service.getAutomationCards(), { ok: true, selectedId: '', cards: [] });
});

test('workbench manages cards and saves sessions through native bridge capabilities', async () => {
  const calls = [];
  const bridge = {
    manageCard: async (...args) => { calls.push(['card', ...args]); return { success: true, item: { id: 'card-1' } }; },
    saveBrowserSession: async (...args) => { calls.push(['session', ...args]); return { success: true, filePath: 'session.json' }; },
  };
  const service = createAutomationCardService({ bridge });
  assert.deepEqual(await service.manageAutomationCard({ action: 'get', id: 'card-1' }), {
    ok: true, data: { success: true, item: { id: 'card-1' } },
  });
  assert.deepEqual(await service.saveAutomationSession({ connectionId: 'native:p1' }), {
    ok: true, data: { success: true, filePath: 'session.json' },
  });
  assert.equal(calls[0][1], undefined);
  assert.deepEqual(calls[0][2], { action: 'get', id: 'card-1' });
  assert.equal(calls[1][1], 'native:p1');
  await assert.rejects(service.saveAutomationSession({}), /请先选择已连接的浏览器窗口/);
});
