// content/index.ts — injected into every web page.
// Wires chrome.runtime messages from the background worker to the page-action
// handlers. All DOM manipulation lives in the sibling modules:
//   actions.ts   — click, type, scroll, extract, … (the bread-and-butter ops)
//   popups.ts    — popup detection + close
//   viewport.ts  — page position reporting (browser_page_info, ctx in click/scroll)
//   dom.ts       — pure DOM helpers (selectors, visibility, text matching)
//   fx.ts        — virtual cursor / visual effects

import {
  doClick, doDoubleClick, doRightClick, doDrag, doPressKey,
  doType, getContent, doScroll, doWait, doAwaitSettle, doEvaluate, doExtract,
  findText, fillForm, doSelect, doHover, storageGet, storageSet, storageRemove,
  storageList, domSnapshot, iframeList, performanceInfo, fileUpload,
  screenshotTargetInfo, focusTarget, doScreenshotFx, resolveNativeTarget,
  nativeFrameGeometry, nativeViewportMetrics,
} from './actions'
import { doFindPopups, doClosePopup } from './popups'
import { doPageInfo } from './viewport'
import { doObserve, clearMarksOverlay } from './observe'

// The content script is injected into every frame (manifest all_frames) and may
// also be re-injected on demand by the background worker for already-open tabs.
// Guard against registering the message listener twice in the same frame, which
// would otherwise make a single action run (and sendResponse) multiple times.
declare global { interface Window { __hsContentLoaded?: boolean } }
if (!window.__hsContentLoaded) {
  window.__hsContentLoaded = true

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleAction(msg).then(sendResponse).catch(err => sendResponse({
    success: false,
    error: {
      message: err.message || String(err),
      code: err.code || 'CONTENT_ACTION_FAILED',
      suggestion: err.suggestion || 'Check the selector, page state, and whether the target element is visible/interactable.',
    },
    trace: msg?.trace ? { action: msg.action, args: msg } : undefined,
  }))
  return true  // keep message channel open for async response
  })
}

async function handleAction(msg: any): Promise<any> {
  switch (msg.action) {
    case 'click':        return doClick(msg)
    case 'double_click': return doDoubleClick(msg)
    case 'right_click':  return doRightClick(msg)
    case 'drag':         return doDrag(msg)
    case 'press_key':    return doPressKey(msg)
    case 'focus_target':  return focusTarget(msg)
    case 'native_resolve_target': return resolveNativeTarget(msg)
    case 'native_frame_geometry': return nativeFrameGeometry(msg)
    case 'native_viewport_metrics': return nativeViewportMetrics()
    case 'find_popups':  return doFindPopups(msg)
    case 'close_popup':  return doClosePopup(msg)
    case 'page_info':    return doPageInfo()
    case 'observe':      return doObserve(msg)
    case 'clear_marks':  clearMarksOverlay(); return { success: true }
    case 'type':         return doType(msg)
    case 'get_content':  return getContent(msg)
    case 'scroll':       return doScroll(msg)
    case 'wait':         return doWait(msg)
    case 'await_settle': return doAwaitSettle(msg)
    case 'evaluate':     return doEvaluate(msg)
    case 'extract':      return doExtract(msg)
    case 'find_text':    return findText(msg)
    case 'fill_form':    return fillForm(msg)
    case 'dom_snapshot': return domSnapshot(msg)
    case 'iframe_list':  return iframeList()
    case 'performance':  return performanceInfo()
    case 'screenshot_target_info': return screenshotTargetInfo(msg)
    case 'screenshot_fx':          return doScreenshotFx(msg)
    case 'file_upload':  return fileUpload(msg)
    case 'select':       return doSelect(msg)
    case 'hover':        return doHover(msg)
    case 'storage_get':  return storageGet(msg)
    case 'storage_set':  return storageSet(msg)
    case 'storage_remove': return storageRemove(msg)
    case 'storage_list': return storageList(msg)
    default:
      throw new Error(`Unknown content action: ${msg.action}`)
  }
}
