'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  dispatchRuntimeAutomationByProcessId,
  normalizeRuntimeAutomation,
} = require('../../../src/app/main/browser-runtime/runtime-automation');
const { ALLOWED_COMMANDS } = require('../../../src/app/main/browser-runtime/chromium-command-client');

test('normalizes bounded native observe and action payloads', () => {
  assert.deepEqual(normalizeRuntimeAutomation('observe-page', {
    max_items: 5000, keyword: '登录', include_media: false,
  }), {
    limit: 1000, keyword: '登录', tag: '', filter: '', includeText: true, includeMedia: false,
    showHighlights: true, highlightDurationMs: 5000,
  });
  const hiddenMarks = normalizeRuntimeAutomation('observe-page', {
    mark: false, highlight_duration_ms: 999999,
  });
  assert.equal(hiddenMarks.showHighlights, false);
  assert.equal(hiddenMarks.highlightDurationMs, 30000);
  assert.equal(normalizeRuntimeAutomation('perform-action', {
    action: 'type', selector: '#email', text: 'a@example.com', timeout: 1,
  }).timeoutMs, 100);
  assert.deepEqual(normalizeRuntimeAutomation('perform-action', {
    action: 'press_key', key: 'Ctrl+Shift+Enter', alt: true,
  }), {
    action: 'press_key', selector: '', text: '', key: 'Enter', ref: '', direction: 'down', amount: 600,
    timeoutMs: 10000, ctrl: true, shift: true, alt: true, meta: false,
  });
  assert.deepEqual(normalizeRuntimeAutomation('activate-tab', {
    url: ' https://example.test/page ', id: '2',
  }), { url: 'https://example.test/page', index: 2 });
});

test('rejects unknown native commands and actions', () => {
  assert.throws(() => normalizeRuntimeAutomation('execute-script', {}), /不支持的 Chromium 自动化命令/);
  assert.throws(() => normalizeRuntimeAutomation('perform-action', { action: 'eval' }), /不支持的原生页面动作/);
});

test('routes native automation only to a live managed Chromium process', async () => {
  const sent = [];
  const runtime = {
    instances: new Map([['profile-a', { child: { pid: 42, exitCode: null } }]]),
    enqueueProfileOperation: (_id, operation) => operation(),
    getReadyInstance: () => ({
      commandClient: { send: async (...args) => { sent.push(args); return { ok: true }; } },
    }),
  };
  await dispatchRuntimeAutomationByProcessId(runtime, 42, 'capture-screenshot', {});
  assert.equal(sent[0][0], 'capture-screenshot');
  await assert.rejects(
    dispatchRuntimeAutomationByProcessId(runtime, 41, 'observe-page', {}),
    /不属于当前受管 Profile/,
  );
});

test('fork automation commands are allowlisted without an automation extension', () => {
  assert.equal(ALLOWED_COMMANDS.has('open-tabs'), true);
  for (const command of [
    'observe-page', 'capture-screenshot', 'perform-action', 'get-session-data', 'list-tabs', 'activate-tab',
  ]) {
    assert.equal(ALLOWED_COMMANDS.has(command), true);
  }
  assert.equal(fs.existsSync(path.join(
    __dirname, '../../../src/assets/extensions/browser_automation',
  )), false);
});

test('fork live tab patch reads the active Chromium tab strip', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0026-ai-free-live-tab-list.patch'), 'utf8',
  );
  assert.match(series, /0025-ai-free-sandbox-launch-diagnostics\.patch\s+0026-ai-free-live-tab-list\.patch/);
  assert.match(patch, /command_name == "list-tabs"/);
  assert.match(patch, /command_name == "activate-tab"/);
  assert.match(patch, /tab_strip->active_index\(\)/);
  assert.match(patch, /ActivateTabAt\(target_index\)/);
  assert.match(patch, /TAB_NOT_FOUND/);
  assert.match(patch, /GetVisibleURL\(\)\.spec\(\)/);
});

test('fork click patch uses an event-transparent visible Chromium pointer', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0021-ai-free-visible-pointer.patch'), 'utf8',
  );

  assert.match(series, /0020-ai-free-page-automation\.patch\s+0021-ai-free-visible-pointer\.patch/);
  assert.match(patch, /SetCanProcessEventsWithinSubtree\(false\)/);
  assert.match(patch, /kViewIgnoredByLayoutKey/);
  assert.match(patch, /ForwardMouseEvent/);
  assert.match(patch, /inputMode", "chromium-visible-pointer/);
  assert.doesNotMatch(patch, /document\.body\.append|createElement\(['"](?:div|img)/);
});

test('fork observe patch returns structured download links', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0022-ai-free-observe-download-links.patch'), 'utf8',
  );
  assert.match(series, /0021-ai-free-visible-pointer\.patch\s+0022-ai-free-observe-download-links\.patch/);
  assert.match(patch, /downloadUrl/);
  assert.match(patch, /downloadLinks/);
  assert.match(patch, /downloadLinkCount/);
});

test('fork keyboard and scroll actions use fixed native input events', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0023-ai-free-native-keyboard-wheel.patch'), 'utf8',
  );
  assert.match(series, /0022-ai-free-observe-download-links\.patch\s+0023-ai-free-native-keyboard-wheel\.patch/);
  assert.match(patch, /NativeWebKeyboardEvent/);
  assert.match(patch, /ForwardKeyboardEvent/);
  assert.match(patch, /ForwardWheelEvent/);
  assert.doesNotMatch(patch, /^\+.*dispatchEvent\(new (?:InputEvent|KeyboardEvent)/m);
});

test('fork keyboard modifier patch forwards trusted Ctrl+Enter modifiers', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0027-ai-free-keyboard-modifiers.patch'), 'utf8',
  );
  assert.match(series, /0026-ai-free-live-tab-list\.patch\s+0027-ai-free-keyboard-modifiers\.patch/);
  assert.match(patch, /kControlKey/);
  assert.match(patch, /kShiftKey/);
  assert.match(patch, /KeyboardModifiers\(command\)/);
  assert.match(patch, /NativeWebKeyboardEvent event\(type, modifiers/);
});

test('fork observe highlights stay in the native event-transparent UI layer', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0024-ai-free-native-observe-highlights.patch'), 'utf8',
  );
  assert.match(series, /0023-ai-free-native-keyboard-wheel\.patch\s+0024-ai-free-native-observe-highlights\.patch/);
  assert.match(patch, /SetCanProcessEventsWithinSubtree\(false\)/);
  assert.match(patch, /kMaximumHighlightCount = 120/);
  assert.match(patch, /chromium-native-overlay/);
  assert.match(patch, /OnVisibilityChanged/);
  assert.doesNotMatch(patch, /^\+.*(?:document\.body\.append|createElement)/m);
});
