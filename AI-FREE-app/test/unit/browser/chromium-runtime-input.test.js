'use strict';

const assert = require('assert');
const test = require('node:test');
const { ChromiumRuntime } = require('../../../src/app/main/browser-runtime/chromium-runtime');

function createRuntime() {
  const sent = [];
  const store = {
    getState: (profileId) => profileId === 'profile-a' ? { status: 'ready' } : null,
  };
  const runtime = new ChromiumRuntime({ store, logger: { warn() {} } });
  runtime.instances.set('profile-a', {
    child: { pid: 4321, exitCode: null },
    commandClient: {
      send: async (type, payload) => {
        sent.push({ type, payload });
        return { ok: true, result: { dispatched: true } };
      },
    },
  });
  return { runtime, sent };
}

test('dispatchInputByProcessId routes a validated mouse click to the managed Chromium pipe', async () => {
  const { runtime, sent } = createRuntime();

  const response = await runtime.dispatchInputByProcessId(4321, {
    inputType: 'mouse', action: 'double_click', x: 125.5, y: 80,
    viewportWidth: 800, viewportHeight: 600,
  });

  assert.equal(response.result.dispatched, true);
  assert.deepEqual(sent, [{
    type: 'dispatch-input',
    payload: {
      inputType: 'mouse', action: 'double_click', x: 125.5, y: 80,
      viewportWidth: 800, viewportHeight: 600,
    },
  }]);
});

test('dispatchInputByProcessId rejects unknown processes and invalid coordinates', async () => {
  const { runtime, sent } = createRuntime();

  await assert.rejects(
    runtime.dispatchInputByProcessId(9999, {
      inputType: 'mouse', action: 'click', x: 1, y: 1, viewportWidth: 800, viewportHeight: 600,
    }),
    (error) => error.code === 'CHROMIUM_PROCESS_NOT_MANAGED',
  );
  await assert.rejects(
    runtime.dispatchInputByProcessId(4321, {
      inputType: 'mouse', action: 'click', x: -1, y: 1, viewportWidth: 800, viewportHeight: 600,
    }),
    (error) => error.code === 'INPUT_PAYLOAD_INVALID',
  );
  assert.deepEqual(sent, []);
});
