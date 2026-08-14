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
    limit: 1000, textLimit: 120, keyword: '登录', tag: '', filter: '', includeText: true, includeMedia: false,
    showHighlights: true, highlightDurationMs: 5000,
  });
  assert.equal(normalizeRuntimeAutomation('observe-page', { text_limit: 5000 }).textLimit, 500);
  const hiddenMarks = normalizeRuntimeAutomation('observe-page', {
    mark: false, highlight_duration_ms: 999999,
  });
  assert.equal(hiddenMarks.showHighlights, false);
  assert.equal(hiddenMarks.highlightDurationMs, 30000);
  assert.equal(normalizeRuntimeAutomation('perform-action', {
    action: 'type', selector: '#email', text: 'a@example.com', timeout: 1,
  }).timeoutMs, 100);
  assert.deepEqual(normalizeRuntimeAutomation('perform-action', {
    action: 'click', ref: 'e1', selector: 'button', x: 160.5, y: 55.25,
  }), {
    action: 'click', selector: 'button', text: '', key: '', ref: 'e1', direction: 'down', amount: 600,
    timeoutMs: 10000, ctrl: false, shift: false, alt: false, meta: false, x: 160.5, y: 55.25,
  });
  assert.deepEqual(normalizeRuntimeAutomation('perform-action', {
    action: 'press_key', key: 'Ctrl+Shift+Enter', alt: true,
  }), {
    action: 'press_key', selector: '', text: '', key: 'Enter', ref: '', direction: 'down', amount: 600,
    timeoutMs: 10000, ctrl: true, shift: true, alt: true, meta: false, repeat: 1,
  });
  assert.deepEqual(normalizeRuntimeAutomation('perform-action', {
    action: 'drag', x: 40, y: 55, to_x: 220, to_y: 55,
  }), {
    action: 'drag', selector: '', text: '', key: '', ref: '', direction: 'down', amount: 600,
    timeoutMs: 10000, ctrl: false, shift: false, alt: false, meta: false,
    x: 40, y: 55, toX: 220, toY: 55,
  });
  assert.deepEqual(normalizeRuntimeAutomation('perform-action', {
    action: 'set_selection', selector: '#editor', start: 8, end: 3,
    selection_direction: 'backward',
  }), {
    action: 'set_selection', selector: '#editor', text: '', key: '', ref: '', direction: 'down', amount: 600,
    timeoutMs: 10000, ctrl: false, shift: false, alt: false, meta: false,
    start: 8, end: 3, selectionDirection: 'backward',
  });
  assert.deepEqual(normalizeRuntimeAutomation('activate-tab', {
    url: ' https://example.test/page ', id: '2',
  }), { url: 'https://example.test/page', index: 2 });
  assert.deepEqual(normalizeRuntimeAutomation('download-element', {
    ref: 'e2', selector: 'img', x: 160.5, y: 55.25,
    target_path: 'C:\\AI-Workspace\\.image.native-download', timeout_ms: 999999,
  }), {
    ref: 'e2', selector: 'img', x: 160.5, y: 55.25,
    targetPath: 'C:\\AI-Workspace\\.image.native-download', timeoutMs: 300000,
  });
});

test('rejects unknown native commands and actions', () => {
  assert.throws(() => normalizeRuntimeAutomation('execute-script', {}), /不支持的 Chromium 自动化命令/);
  assert.throws(() => normalizeRuntimeAutomation('perform-action', { action: 'eval' }), /不支持的原生页面动作/);
  assert.throws(() => normalizeRuntimeAutomation('perform-action', { action: 'click', x: 10 }), /必须同时提供/);
  assert.throws(() => normalizeRuntimeAutomation('perform-action', { action: 'drag', x: 10, y: 10 }), /终点坐标/);
  assert.throws(() => normalizeRuntimeAutomation('perform-action', { action: 'set_selection' }), /start\/end/);
  assert.throws(() => normalizeRuntimeAutomation('download-element', { selector: 'img' }), /目标路径/);
  assert.throws(() => normalizeRuntimeAutomation('download-element', { target_path: 'C:\\image.png' }), /必须提供 selector/);
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
    'observe-page', 'capture-screenshot', 'perform-action', 'download-element',
    'get-session-data', 'list-tabs', 'activate-tab',
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

test('fork coordinate actions bypass selector lookup and retain native hit testing', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0028-ai-free-observed-coordinate-actions.patch'), 'utf8',
  );
  assert.match(series, /0027-ai-free-keyboard-modifiers\.patch\s+0028-ai-free-observed-coordinate-actions\.patch/);
  assert.match(patch, /targetMode:'viewport-coordinate'/);
  assert.match(patch, /nativeInput:\{x,y,viewportWidth:innerWidth,viewportHeight:innerHeight\}/);
  assert.match(patch, /TARGET_COORDINATE_INVALID/);
});

test('fork observe filters topmost click owners and bounds text summaries', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0030-ai-free-observe-topmost.patch'), 'utf8',
  );
  assert.match(series, /0028-ai-free-observed-coordinate-actions\.patch\s+0030-ai-free-observe-topmost\.patch/);
  assert.match(patch, /deepElementFromPoint/);
  assert.match(patch, /clickOwner/);
  assert.match(patch, /topmostFiltered:true/);
  assert.match(patch, /textTruncated/);
  assert.match(patch, /item\.clickX/);
});

test('fork pointer stays centered and visible while the Runtime Bridge is connected', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0031-ai-free-idle-pointer.patch'), 'utf8',
  );
  assert.match(series, /0030-ai-free-observe-topmost\.patch\s+0031-ai-free-idle-pointer\.patch/);
  assert.match(patch, /SetAiFreePointerConnected\(browser, true\)/);
  assert.match(patch, /bounds\.width\(\) \/ 2\.0f/);
  assert.match(patch, /bounds\.height\(\) \/ 2\.0f/);
  assert.match(patch, /attach_retry_timer_\.Start/);
  assert.match(patch, /if \(persistent_\)/);
  assert.match(patch, /SetAiFreePointerConnected\(browser, false\)/);
});

test('fork observe supplements closed Shadow DOM controls from Chromium accessibility', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0032-ai-free-closed-shadow-observe.patch'), 'utf8',
  );
  assert.match(series, /0031-ai-free-idle-pointer\.patch\s+0032-ai-free-closed-shadow-observe\.patch/);
  assert.match(patch, /RequestAXTreeSnapshot/);
  assert.match(patch, /data\.IsClickable\(\)/);
  assert.match(patch, /accessibilityFallback/);
  assert.match(patch, /closedShadowSupported/);
  assert.match(patch, /IsDuplicate/);
});

test('fork rich text editing uses native drag, complete key maps and real selections', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0033-ai-free-rich-text-editing.patch'), 'utf8',
  );
  assert.match(series, /0032-ai-free-closed-shadow-observe\.patch\s+0033-ai-free-rich-text-editing\.patch/);
  assert.match(patch, /DispatchAiFreeAnimatedDrag/);
  assert.match(patch, /action==='set_selection'/);
  assert.match(patch, /action==='insert_text'/);
  assert.match(patch, /value >= 'A' && value <= 'Z'/);
  assert.match(patch, /0x2E/);
  assert.match(patch, /repeat/);
});

test('fork element download uses the current profile DownloadManager and a workspace-only path', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0034-ai-free-download-element.patch'), 'utf8',
  );
  assert.match(series, /0033-ai-free-rich-text-editing\.patch\s+0034-ai-free-download-element\.patch/);
  assert.match(patch, /image\.currentSrc\|\|image\.src/);
  assert.match(patch, /CreateDownloadForWebContentsMainFrame/);
  assert.match(patch, /GetSwitchValuePath/);
  assert.match(patch, /download-default-directory/);
  assert.match(patch, /set_file_path/);
  assert.doesNotMatch(patch, /capture-screenshot/);
});

test('fork locks every browser download to the AI workspace and activates newly opened tabs', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0035-ai-free-workspace-downloads-and-active-tabs.patch'), 'utf8',
  );
  assert.match(series, /0034-ai-free-download-element\.patch\s+0035-ai-free-workspace-downloads-and-active-tabs\.patch/);
  assert.match(patch, /GetAiFreeLockedDownloadDirectory/);
  assert.match(patch, /kDownloadDefaultDirectorySwitch/);
  assert.match(patch, /PromptForDownload\(\) const/);
  assert.match(patch, /return false;/);
  assert.match(patch, /IsDownloadPathManaged\(\) const/);
  assert.match(patch, /chrome::AddTabAt\(browser, url, -1, true\)/);
});

test('fork observe classifies obfuscated media and returns direct image links', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0036-ai-free-observe-media-links.patch'), 'utf8',
  );
  assert.match(series, /0035-ai-free-workspace-downloads-and-active-tabs\.patch\s+0036-ai-free-observe-media-links\.patch/);
  assert.match(patch, /el\.currentSrc/);
  assert.match(patch, /srcsetUrls/);
  assert.match(patch, /backgroundUrls/);
  assert.match(patch, /data-image-url/);
  assert.match(patch, /item\.mediaUrls/);
  assert.match(patch, /item\.downloadUrl=downloadable/);
  assert.match(patch, /kind:i\.kind/);
  assert.match(patch, /mediaType:i\.mediaType/);
  assert.match(patch, /requiresFileUpload:true/);
});

test('fork takeover makes mutations explicit and globally suppresses blocking dialogs', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0037-ai-free-mcp-modal-guard.patch'), 'utf8',
  );
  assert.match(series, /0036-ai-free-observe-media-links\.patch\s+0037-ai-free-mcp-modal-guard\.patch/);
  assert.match(patch, /SetAiFreeTakeover/);
  assert.match(patch, /BROWSER_TAKEOVER_REQUIRED/);
  assert.match(patch, /TakeoverBorder/);
  assert.match(patch, /purple-glow/);
  assert.match(patch, /SetCanProcessEventsWithinSubtree\(false\)/);
  assert.match(patch, /HandleJavaScriptDialog\(web_contents\(\), false, nullptr\)/);
  assert.match(patch, /selection->takeover_active\(\)/);
  assert.doesNotMatch(patch, /^\+.*RunJavaScriptDialog/m);
});

test('fork observe exposes semantic control types and form state', () => {
  const patchDirectory = path.join(__dirname, '../../../native/chromium-fork/patches');
  const series = fs.readFileSync(path.join(patchDirectory, 'series'), 'utf8');
  const patch = fs.readFileSync(
    path.join(patchDirectory, '0038-ai-free-observe-control-semantics.patch'), 'utf8',
  );
  assert.match(series, /0037-ai-free-mcp-modal-guard\.patch\s+0038-ai-free-observe-control-semantics\.patch/);
  assert.match(patch, /controlInfo/);
  assert.match(patch, /controlType/);
  assert.match(patch, /role:semantic\.role/);
  assert.match(patch, /editable:semantic\.editable/);
  assert.match(patch, /label:clip\(label\)/);
  assert.match(patch, /ariaChecked/);
  assert.match(patch, /item\.options/);
  assert.match(patch, /filter==='input'/);
  assert.match(patch, /inputType==='password'\?'':rawText/);
  assert.match(patch, /kEditable/);
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
