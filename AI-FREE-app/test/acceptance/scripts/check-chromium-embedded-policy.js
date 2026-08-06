'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..');
const patchPath = path.join(
  root,
  'native',
  'chromium-fork',
  'patches',
  '0007-ai-free-embedded-window-lockdown.patch',
);
const patch = fs.readFileSync(patchPath, 'utf8');
const popupPatch = fs.readFileSync(path.join(
  root,
  'native',
  'chromium-fork',
  'patches',
  '0008-ai-free-extension-popup-auto-dismiss.patch',
), 'utf8');
const pinnedActionsPatch = fs.readFileSync(path.join(
  root,
  'native',
  'chromium-fork',
  'patches',
  '0011-ai-free-embedded-extension-actions-pinned.patch',
), 'utf8');
const toolbarPatch = fs.readFileSync(path.join(
  root,
  'native',
  'chromium-fork',
  'patches',
  '0010-ai-free-embedded-toolbar-simplification.patch',
), 'utf8');
const timezonePatch = fs.readFileSync(path.join(
  root,
  'native',
  'chromium-fork',
  'patches',
  '0012-ai-free-profile-timezone.patch',
), 'utf8');
const series = fs.readFileSync(
  path.join(root, 'native', 'chromium-fork', 'patches', 'series'),
  'utf8',
);
const nativeHost = fs.readFileSync(
  path.join(root, 'native', 'browser-host', 'src', 'child_window_manager.cc'),
  'utf8',
);
const nativeFocus = fs.readFileSync(
  path.join(root, 'native', 'browser-host', 'src', 'focus_manager.cc'),
  'utf8',
);
const tabManagerRuntime = fs.readFileSync(
  path.join(root, 'src', 'app', 'main', 'services', 'tab-manager-runtime.js'),
  'utf8',
);

assert(series.includes('0007-ai-free-embedded-window-lockdown.patch'));
assert(series.includes('0008-ai-free-extension-popup-auto-dismiss.patch'));
assert(series.includes('0010-ai-free-embedded-toolbar-simplification.patch'));
assert(series.includes('0011-ai-free-embedded-extension-actions-pinned.patch'));
assert(series.includes('0012-ai-free-profile-timezone.patch'));
assert(!series.includes('0009-ai-free-embedded-omnibox-read-only.patch'));
for (const marker of [
  'switches::kHsEmbedMode) == "child-window"',
  'return HTCLIENT;',
  'SetHasWindowSizeControls(false);',
  'close_button_->SetVisible(false);',
  'case IDC_CLOSE_WINDOW:',
  'case IDC_MINIMIZE_WINDOW:',
  'case IDC_MAXIMIZE_WINDOW:',
]) {
  assert(patch.includes(marker), `embedded policy patch is missing: ${marker}`);
}

for (const restoredMarker of [
  'case IDC_NEW_WINDOW:',
  'case IDC_NEW_INCOGNITO_WINDOW:',
  'case IDC_NEW_TAB:',
  'case IDC_NEW_TAB_TO_RIGHT:',
  'case IDC_CLOSE_TAB:',
  'bool ShouldShowNewTabButton',
  'bool IsAiFreeBlockedTabContextCommand',
  'void BrowserTabStripController::OnCloseTab',
  'void TabStrip::MaybeStartDrag',
]) {
  assert(!patch.includes(restoredMarker),
    `embedded policy still disables restored browser UI: ${restoredMarker}`);
}

const patchedFiles = [...patch.matchAll(/^diff --git a\/(\S+) /gm)]
  .map((match) => match[1]);
assert.deepEqual(patchedFiles, [
  'chrome/browser/ui/browser_command_controller.cc',
  'chrome/browser/ui/views/frame/browser_caption_button_container_win.cc',
  'chrome/browser/ui/views/frame/browser_view.cc',
]);
assert(!patchedFiles.some((file) =>
  file.startsWith('chrome/browser/extensions/api/tabs/') ||
  file.startsWith('extensions/browser/api/tabs/')),
'the embedded policy must not patch the chrome.tabs extension API');

for (const marker of [
  'bool BrowserView::IsToolbarVisible() const',
  'switches::kHsHideToolbar',
  'GetSwitchValueASCII(switches::kHsEmbedMode)',
  'HasSwitch(switches::kHsHideToolbar)',
  'bool ShouldShowNewTabButton',
  'return false;',
]) {
  assert(toolbarPatch.includes(marker),
    `one-click browser UI patch is missing: ${marker}`);
}
const toolbarPatchedFiles = [
  ...toolbarPatch.matchAll(/^diff --git a\/(\S+) /gm),
].map((match) => match[1]);
assert.deepEqual(toolbarPatchedFiles, [
  'chrome/browser/ui/views/frame/browser_view.cc',
  'chrome/browser/ui/views/frame/horizontal_tab_strip_region_view.cc',
]);
for (const forbiddenMarker of [
  'ToolbarActionsModel::SetActionVisibility',
  'HideAiFreeEmbeddedLocationBarContents',
  'IsWebUILocationBarEnabled',
]) {
  assert(!toolbarPatch.includes(forbiddenMarker),
    `one-click browser UI patch must hide rows without mutating normal toolbar state: ${forbiddenMarker}`);
}

assert(popupPatch.includes('chrome/browser/ui/views/extensions/extension_popup.cc'));
assert(popupPatch.includes('set_close_on_deactivate(false)'));
assert(popupPatch.includes('A system file'));
assert(popupPatch.includes('chooser takes focus away from the popup'));
assert(!popupPatch.includes('set_close_on_deactivate(true)'));
const extensionPopupPatch = popupPatch.slice(
  0,
  popupPatch.indexOf('diff --git a/chrome/browser/ui/views/toolbar/'),
);
assert(!extensionPopupPatch.includes('switches::kHsEmbedMode) == "child-window"'));
assert(popupPatch.includes('toolbar_action_hover_card_controller.cc'));
assert(popupPatch.includes('embedded_hover_exit_watchdog_.Start('));
assert(popupPatch.includes('Screen::Get()->GetCursorScreenPoint()'));
assert(popupPatch.includes('GetBoundsInScreen().Contains(cursor)'));

for (const marker of [
  'ToolbarActionsModel::SetActionVisibility',
  'ToolbarActionsModel::GetFilteredPinnedActionIds() const',
  'return std::vector<ActionId>(action_ids_.begin(), action_ids_.end());',
  'switches::kHsEmbedMode) == "child-window"',
]) {
  assert(pinnedActionsPatch.includes(marker),
    `default-pinned extension patch is missing: ${marker}`);
}
const pinnedActionPatchedFiles = [
  ...pinnedActionsPatch.matchAll(/^diff --git a\/(\S+) /gm),
].map((match) => match[1]);
assert.deepEqual(pinnedActionPatchedFiles, [
  'chrome/browser/ui/toolbar/toolbar_actions_model.cc',
]);
for (const forbiddenMarker of [
  'HideAiFreeEmbeddedLocationBarContents',
  'SetCanProcessEventsWithinSubtree(false)',
  'IsWebUILocationBarEnabled',
]) {
  assert(!pinnedActionsPatch.includes(forbiddenMarker),
    `default-pinned extension patch must not alter the address bar: ${forbiddenMarker}`);
}

for (const marker of [
  'hs-timezone-id',
  'String::FromUtf8(base::as_byte_span(timezone_id))',
  'g_command_line_timezone_override',
]) {
  assert(timezonePatch.includes(marker), `timezone patch is missing: ${marker}`);
}

for (const style of [
  'WS_POPUP',
  'WS_CAPTION',
  'WS_THICKFRAME',
  'WS_SYSMENU',
  'WS_MINIMIZEBOX',
  'WS_MAXIMIZEBOX',
  'WS_CHILD',
]) {
  assert(nativeHost.includes(style), `native host style policy is missing: ${style}`);
}

assert(nativeFocus.includes('if (foreground != root) return false;'),
  'embedded browser focus must be rejected while the Electron owner is in the background');
assert(!nativeFocus.includes('SetForegroundWindow(root)'),
  'embedded browser focus must not force the Electron owner to the foreground');
assert(tabManagerRuntime.includes('options.focusBrowser === true'),
  'showing or switching an embedded browser must require explicit focus opt-in');

assert(!fs.existsSync(path.join(root, 'src', 'assets', 'extensions', 'browser_automation')),
  'legacy browser automation extension directory must stay deleted');
const nativeAutomation = fs.readFileSync(
  path.join(root, 'src', 'app', 'main', 'services', 'native-browser-automation.js'),
  'utf8',
);
assert(nativeAutomation.includes("runtimeCommand(connection, 'observe-page'"));
assert(nativeAutomation.includes("runtimeCommand(connection, 'perform-action'"));

console.log('chromium embedded window policy checks passed');
