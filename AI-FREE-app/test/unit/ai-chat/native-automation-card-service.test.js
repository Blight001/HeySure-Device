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

test('native card stops when a native tool returns a structured failure', async () => {
  const { service } = fixture();
  const written = await service.execute({
    action: 'write',
    cardData: {
      name: '点击失败即停止', website: 'https://example.com',
      steps: [
        { name: '点击发布', type: 'click', selector: '#publish' },
        { name: '不应继续', type: 'wait', timeout: 1000 },
      ],
    },
  });
  const calls = [];
  const result = await service.execute({ action: 'run', id: written.item.id }, {
    dispatch: async (tool, args) => {
      calls.push([tool, args]);
      if (tool === 'browser_action') {
        return { success: false, error: '未找到发布按钮', errorCode: 'ELEMENT_NOT_FOUND' };
      }
      return { success: true };
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'ELEMENT_NOT_FOUND');
  assert.equal(result.stepIndex, 1);
  assert.equal(result.execution.length, 2);
  assert.equal(calls.some(([tool]) => tool === 'browser_wait'), false);
});

test('required condition fails the card and does not execute later steps', async () => {
  const { service } = fixture();
  const written = await service.execute({
    action: 'write',
    cardData: {
      name: '发布确认', website: 'https://example.com/publish',
      steps: [
        {
          id: 'check_published', name: '确认发布成功', type: 'condition',
          condition_mode: 'url_matches', text: 'published=true', fail_on_false: true,
        },
        { id: 'after_success', name: '成功后步骤', type: 'screenshot' },
      ],
      flow: {
        start: 'check_published',
        nodes: [{ id: 'check_published' }, { id: 'after_success' }],
        edges: [{ from: 'check_published', to: 'after_success', label: 'true' }],
      },
    },
  });
  const calls = [];
  const result = await service.execute({ action: 'run', id: written.item.id }, {
    dispatch: async (tool) => {
      calls.push(tool);
      if (tool === 'browser_tab') {
        return { success: true, activeTab: { url: 'https://example.com/publish' } };
      }
      return { success: true };
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'CARD_CONDITION_FAILED');
  assert.equal(result.stepIndex, 1);
  assert.deepEqual(calls, ['browser_tab', 'browser_tab']);
});

test('flow node without an outgoing edge is terminal instead of falling through step order', async () => {
  const { service } = fixture();
  const written = await service.execute({
    action: 'write',
    cardData: {
      name: '失败分支终止', website: 'https://example.com/publish',
      steps: [
        { id: 'check', type: 'condition', condition_mode: 'url_matches', text: 'published=true' },
        { id: 'success', type: 'screenshot' },
        { id: 'failure', type: 'screenshot' },
        { id: 'must_not_run', type: 'save_cookies' },
      ],
      flow: {
        start: 'check',
        nodes: [{ id: 'check' }, { id: 'success' }, { id: 'failure' }, { id: 'must_not_run' }],
        edges: [
          { from: 'check', to: 'success', label: 'true' },
          { from: 'check', to: 'failure', label: 'false' },
        ],
      },
    },
  });
  const calls = [];
  const result = await service.execute({ action: 'run', id: written.item.id }, {
    dispatch: async (tool) => {
      calls.push(tool);
      if (tool === 'browser_tab') {
        return { success: true, activeTab: { url: 'https://example.com/publish' } };
      }
      return { success: true };
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(calls, ['browser_tab', 'browser_tab', 'browser_screenshot']);
});
