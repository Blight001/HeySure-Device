'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNativeAutomationCardService } = require('../../../src/app/main/services/native-automation-card-service');

function fixture() {
  let state = { items: [], selectedId: '' };
  const service = createNativeAutomationCardService({
    read: () => ({ exists: true, state: structuredClone(state) }),
    write: (next) => { state = structuredClone(next); return state; },
  });
  return { service, state: () => state };
}

test('native card management persists validated cards and supports local step edits', async () => {
  const { service, state } = fixture();
  const written = await service.execute({
    action: 'write',
    cardData: { name: '登录', website: 'https://example.com', steps: [{ type: 'click', selector: '#login' }] },
  });
  await service.execute({
    action: 'insert_step', id: written.item.id, step_index: 2,
    stepData: { type: 'wait', selector: '#ready' },
  });
  assert.equal(state().items[0].cardData.steps.length, 2);
  assert.equal((await service.execute({ action: 'list' })).items[0].name, '登录');
});

test('native card run opens the website and executes page steps through native tool dispatch', async () => {
  const { service } = fixture();
  const written = await service.execute({
    action: 'write',
    cardData: {
      name: '填写', website: 'https://example.com/form',
      steps: [{ type: 'type', selector: '#email', variable: 'email', text: 'default@example.com' }],
    },
  });
  const calls = [];
  const result = await service.execute({ action: 'run', id: written.item.id, inputs: { email: 'user@example.com' } }, {
    dispatch: async (tool, args) => { calls.push([tool, args]); return { success: true }; },
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    ['browser_tab', { action: 'replace', url: 'https://example.com/form' }],
    ['browser_action', { type: 'type', selector: '#email', variable: 'email', text: 'user@example.com', action: 'type' }],
  ]);
});

test('native card validation rejects script conditions before persistence', async () => {
  const { service } = fixture();
  await assert.rejects(() => service.execute({
    action: 'write',
    cardData: {
      name: 'unsafe', website: 'https://example.com',
      steps: [{ type: 'condition', condition_mode: 'js', script: 'return true' }],
    },
  }), /禁止 JavaScript 条件/);
});
