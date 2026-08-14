'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { launchChromiumProfile } = require('../../../src/app/main/browser-runtime/chromium-runtime-launch');

test('runtime launch timing exposes profile, host, pipe, process, handshake and attach phases', async () => {
  const messages = [];
  const state = { status: 'ready' };
  const runtime = {
    logger: { info: (message) => messages.push(message) },
    store: { getState: () => state },
    isProfileVisible: () => false,
    prepareProfileLaunch: (_id, _profile, _bounds, span) => {
      span.mark('boundsNormalize');
      span.mark('profileStorage');
      span.mark('profileLock');
      span.mark('stateCreate');
      return { hostHwnd: null, commandClient: null, bounds: {}, performanceSpan: span };
    },
    async createProfileInstance(context) {
      context.performanceSpan.mark('hostWindow');
      context.performanceSpan.mark('pipeListen');
      context.performanceSpan.mark('processLaunch');
      return { performanceSpan: context.performanceSpan };
    },
    async completeProfileLaunch(_id, instance) {
      instance.performanceSpan.mark('pipeHandshake');
      instance.performanceSpan.mark('windowAttach');
      instance.performanceSpan.mark('runtimeFinalize');
    },
    getState: () => state,
  };

  assert.equal(await launchChromiumProfile(runtime, { profileId: 'private-id' }), state);
  assert.match(messages[0], /operation=runtime-launch outcome=ok/);
  for (const phase of [
    'boundsNormalize', 'profileStorage', 'profileLock', 'stateCreate',
    'hostWindow', 'pipeListen', 'processLaunch',
    'pipeHandshake', 'windowAttach', 'runtimeFinalize',
  ]) {
    assert.match(messages[0], new RegExp(`${phase}Ms=`));
  }
  assert.doesNotMatch(messages[0], /private-id/);
});
