'use strict';

const { assertActiveChromiumLaunch } = require('./runtime-types');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launchExitError(instance) {
  if (instance.launchFailure) return instance.launchFailure;
  const error = /** @type {Error & {code?: string}} */ (new Error('Chromium 在创建窗口前退出'));
  error.code = 'CHROMIUM_PROCESS_EXITED';
  return error;
}

function assertLaunchStillActive(runtime, profileId, instance) {
  if (instance.launchFailure) throw instance.launchFailure;
  assertActiveChromiumLaunch(
    runtime.instances.get(String(profileId)) === instance,
    runtime.store.getState(profileId)?.status,
  );
  if (instance.child.exitCode !== null) throw launchExitError(instance);
}

function handshakeTimeoutError(prototypeMode, processAliveAtTimeout = false) {
  const error = /** @type {Error & {code?: string, processAliveAtTimeout?: boolean}} */ (new Error(
    prototypeMode ? '等待 Chromium 主窗口超时' : '等待 Chromium Fork 命名管道握手超时',
  ));
  error.code = 'CHROMIUM_WINDOW_TIMEOUT';
  error.processAliveAtTimeout = processAliveAtTimeout;
  return error;
}

async function waitForPrototypeWindow(runtime, profileId, instance, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    assertLaunchStillActive(runtime, profileId, instance);
    const found = runtime.windowBridge.findMainWindowByProcessId(instance.child.pid);
    if (found) return found;
    await delay(100);
  }
  throw handshakeTimeoutError(true);
}

function waitForChromiumHello(runtime, profileId, instance, timeoutMs) {
  const currentWindow = String(instance.commandClient.lastHello?.browserHwnd || '');
  if (currentWindow) return Promise.resolve(currentWindow);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(cancelCheck);
      instance.commandClient.off('hello', onHello);
      instance.child.off('error', onProcessEnd);
      instance.child.off('exit', onProcessEnd);
    };
    const finish = (error, browserHwnd) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(browserHwnd);
    };
    const checkActive = () => {
      try { assertLaunchStillActive(runtime, profileId, instance); } catch (error) { finish(error); }
    };
    const onHello = (message) => {
      try {
        assertLaunchStillActive(runtime, profileId, instance);
        const browserHwnd = String(message?.browserHwnd || '');
        if (browserHwnd) finish(null, browserHwnd);
      } catch (error) { finish(error); }
    };
    const onProcessEnd = () => finish(launchExitError(instance));
    const timeout = setTimeout(() => finish(handshakeTimeoutError(false, instance.child.exitCode === null)), timeoutMs);
    const cancelCheck = setInterval(checkActive, 50);
    instance.commandClient.on('hello', onHello);
    instance.child.once('error', onProcessEnd);
    instance.child.once('exit', onProcessEnd);
    onHello(instance.commandClient.lastHello);
    checkActive();
  });
}

function waitForBrowserWindow(runtime, profileId, instance) {
  const prototypeMode = String(process.env.AI_FREE_CHROMIUM_HANDSHAKE || '').toLowerCase() === 'prototype';
  const timeoutMs = Math.max(3000, Number(instance.profile.launchTimeoutMs) || 30000);
  assertLaunchStillActive(runtime, profileId, instance);
  return prototypeMode
    ? waitForPrototypeWindow(runtime, profileId, instance, timeoutMs)
    : waitForChromiumHello(runtime, profileId, instance, timeoutMs);
}

module.exports = { waitForBrowserWindow };
