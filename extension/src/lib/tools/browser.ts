// tools/browser.ts — browser_* MCP tool implementations.
// Three kinds of impls live here:
//   1. Pure chrome.* API tools (navigate, screenshot, tab management, history).
//   2. Content-script-relayed tools (click, type, scroll, …) — they forward to
//      the page via chrome.tabs.sendMessage.
//   3. The browser-only router (executeBrowserOnly) that dispatches by name.

// ── Helpers ───────────────────────────────────────────────────────────────
function isBrowserInternalUrl(url?: string): boolean {
  const raw = String(url || '')
  return /^(chrome|edge|brave|vivaldi|opera|about|chrome-extension):/i.test(raw) ||
    /^https:\/\/chromewebstore\.google\.com\//i.test(raw)
}

function isUsablePageTab(tab?: chrome.tabs.Tab): tab is chrome.tabs.Tab {
  return !!tab?.id && !isBrowserInternalUrl(tab.url) && !tab.discarded
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [lastFocused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const lastFocusedUrl = lastFocused?.url || ''
  if (isUsablePageTab(lastFocused)) return lastFocused

  const windows = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true })
  const focusedWindow = windows.find(w => w.focused)
  const focusedTab = focusedWindow?.tabs?.find(t => t.active)
  const focusedTabUrl = focusedTab?.url || ''
  if (isUsablePageTab(focusedTab)) return focusedTab

  for (const win of windows) {
    const tab = win.tabs?.find(t => t.active)
    if (isUsablePageTab(tab)) return tab
  }

  const tabs = await chrome.tabs.query({})
  const fallback = tabs
    .filter(isUsablePageTab)
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0]
  if (fallback) return fallback

  const activeUrl = lastFocusedUrl || focusedTabUrl
  const detail = activeUrl ? ` Current active URL is ${activeUrl}.` : ''
  const err: any = new Error(`No ordinary web page tab found.${detail}`)
  err.code = 'NO_USABLE_PAGE_TAB'
  err.suggestion = 'Open or switch to a normal http/https page, then retry.'
  throw err
}

async function getAnyActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id) throw new Error('No active tab found')
  return tab
}

// A tab is "foreground" only when it's the active tab AND its window is focused.
// chrome.tabs.captureVisibleTab can only grab a foreground tab — on a background
// tab or a minimized/unfocused window it fails or returns a blank/stale frame.
// CDP Page.captureScreenshot (fromSurface) has no such restriction, so callers
// use this to skip the doomed captureVisibleTab path and go straight to CDP when
// the browser isn't in the foreground (the whole point of running headless-ish).
async function isTabForeground(tab: chrome.tabs.Tab): Promise<boolean> {
  if (!tab.active) return false
  try {
    const win = await chrome.windows.get(tab.windowId)
    return win.focused === true && win.state !== 'minimized'
  } catch {
    return false
  }
}

// Since manifest `all_frames` injects the content script into every frame, a
// frame-less sendMessage would be delivered to *all* frames and only one
// (arbitrary) sendResponse would be kept — so every call must target a specific
// frame. Default to the top frame (frameId 0); cross-frame tools pass an
// explicit frameId obtained from chrome.webNavigation.getAllFrames.
function sendToContent(tabId: number, msg: any, frameId = 0): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId }, (response) => {
      const err = chrome.runtime.lastError
      if (err) {
        reject(err)
        return
      }
      resolve(response)
    })
  })
}

// The content script is normally auto-injected via the manifest, but only on
// pages that loaded *after* the extension was installed/reloaded (and never on
// restricted pages). For tabs that were already open — or after the service
// worker restarts — chrome.tabs.sendMessage fails with "Could not establish
// connection". When that happens we inject dist/content.js on demand and retry,
// so browser_dom_snapshot and other content-script tools keep working
// on any ordinary http/https page without a manual reload.
function isNoReceiverError(err: any): boolean {
  const m = err?.message || ''
  return m.includes('Could not establish connection') ||
    m.includes('Receiving end does not exist')
}

function contentScriptFiles(): string[] {
  try {
    const manifest: any = chrome.runtime.getManifest()
    const files: string[] = []
    for (const cs of manifest.content_scripts || []) {
      for (const js of cs.js || []) files.push(js)
    }
    if (files.length) return files
  } catch { /* fall through to default */ }
  return ['dist/content.js']
}

async function injectContentScript(tabId: number, frameId?: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      // Inject into the specific frame when retrying a frame-targeted call,
      // otherwise cover every frame so cross-origin iframes also get the script.
      target: frameId !== undefined ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true },
      files: contentScriptFiles(),
    })
    return true
  } catch {
    // Restricted pages (chrome://, the web store, PDF viewer, …) reject
    // programmatic injection — there's nothing we can do, report unavailable.
    return false
  }
}

function unwrapContentResult(res: any): any {
  if (res?.error) {
    const detail = typeof res.error === 'object'
      ? res.error
      : { message: String(res.error), code: 'CONTENT_ACTION_FAILED' }
    const err: any = new Error(detail.message || 'Content action failed')
    err.code = detail.code || 'CONTENT_ACTION_FAILED'
    err.suggestion = detail.suggestion
    err.trace = res.trace
    throw err
  }
  return res
}

async function contentMsg(tabId: number, msg: any, frameId = 0): Promise<any> {
  try {
    return unwrapContentResult(await sendToContent(tabId, msg, frameId))
  } catch (err: any) {
    if (!isNoReceiverError(err)) throw err

    // No content script on this frame yet — try to inject it once, then retry.
    const injected = await injectContentScript(tabId, frameId || undefined)
    if (injected) {
      try {
        return unwrapContentResult(await sendToContent(tabId, msg, frameId))
      } catch (retryErr: any) {
        if (!isNoReceiverError(retryErr)) throw retryErr
      }
    }

    const e: any = new Error('Content script unavailable on this page (try a normal web page, not chrome://).')
    e.code = 'CONTENT_SCRIPT_UNAVAILABLE'
    e.suggestion = 'Navigate to a normal http/https page and retry.'
    throw e
  }
}

// ── Cross-frame helpers (cross-origin iframe observe / click) ───────────────
// The content script's doObserve already scans its own document plus every
// *same-origin* descendant frame (reaching them through contentDocument). What
// it cannot reach is a *cross-origin* iframe — the browser blocks contentDocument
// access there. To cover those, the content script is injected into every frame
// (manifest all_frames) and the background fans browser_observe out to each
// cross-origin frame, then merges the per-frame results into one list.

interface FrameNode {
  frameId: number
  parentFrameId: number
  url: string
  origin: string
}

function originOf(url: string): string {
  try {
    if (!url || url === 'about:blank' || url === 'about:srcdoc') return ''
    return new URL(url).origin
  } catch {
    return ''
  }
}

async function listFrames(tabId: number): Promise<FrameNode[]> {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId })
    if (!frames) return []
    return frames.map(f => ({
      frameId: f.frameId,
      parentFrameId: f.parentFrameId,
      url: f.url || '',
      origin: originOf(f.url || ''),
    }))
  } catch {
    return []
  }
}

// A frame needs its own observe pass only when it is cross-origin relative to its
// immediate parent. Same-origin frames (and about:blank / srcdoc, which inherit
// their parent's origin) are already covered by an ancestor's same-origin
// recursion, so observing them again would double-count their content.
function crossOriginFrameRoots(frames: FrameNode[]): FrameNode[] {
  const byId = new Map<number, FrameNode>()
  for (const f of frames) byId.set(f.frameId, f)
  const roots: FrameNode[] = []
  for (const f of frames) {
    if (f.frameId === 0) continue
    const parent = byId.get(f.parentFrameId)
    const childOrigin = f.origin
    const parentOrigin = parent?.origin ?? ''
    // No usable origin (about:blank/srcdoc/empty) → inherits parent → skip.
    if (!childOrigin) continue
    if (childOrigin !== parentOrigin) roots.push(f)
  }
  return roots
}

const MAX_CROSS_ORIGIN_FRAMES = 12

// A click/type ref for an element living in a cross-origin frame is encoded as
// "<frameId>:<localId>" (see toolObserve). Top-frame refs stay plain numbers, so
// existing callers are unaffected. Parse it back into a routable {frameId, ref}.
function parseRef(ref: any): { frameId: number; ref: any } {
  if (typeof ref === 'string') {
    const m = /^(\d+):(.+)$/.exec(ref)
    if (m) return { frameId: Number(m[1]), ref: m[2] }
  }
  return { frameId: 0, ref }
}

function normalizeToolError(err: any, name: string, args: any) {
  return {
    message: err?.message || String(err),
    code: err?.code || 'TOOL_FAILED',
    suggestion: err?.suggestion || suggestionForTool(name),
    trace: args?.trace ? {
      tool: name,
      args,
      cause: err?.trace || null,
      stack: err?.stack || '',
      timestamp: Date.now(),
    } : undefined,
  }
}

function suggestionForTool(name: string) {
  if (name.includes('click') || name.includes('select') || name.includes('drag')) return 'Use browser_observe or browser_screenshot to verify the target, then retry.'
  if (name.includes('screenshot')) return 'Confirm the tool is enabled by policy and the extension has permission for the current tab.'
  if (name.includes('cookie')) return 'Confirm the cookies permission is enabled and the URL/domain is valid.'
  return 'Check tool parameters and current page state, then retry with trace:true for details.'
}

async function waitForTabLoad(tabId: number, timeoutMs = 15000): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === 'complete') return
  } catch {
    throw new Error(`Tab ${tabId} not found`)
  }

  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      chrome.tabs.get(tabId).then(tab => {
        if (tab.status === 'complete') resolve()
        else reject(new Error('Page load timed out'))
      }).catch(() => reject(new Error('Page load timed out')))
    }, timeoutMs)
    function listener(id: number, info: chrome.tabs.TabChangeInfo) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(t)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

function normalizePageUrl(raw: string): string {
  const trimmed = String(raw || '').trim()
  if (!trimmed) throw new Error('url is required')
  if (trimmed === 'about:blank') return trimmed
  try { return new URL(trimmed).href } catch { return new URL('https://' + trimmed).href }
}

async function focusTab(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.get(tabId)
  await chrome.tabs.update(tabId, { active: true })
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true })
  }
  return chrome.tabs.get(tabId)
}

function tabIdArg(args: any): number {
  return Number(args?.tab_id ?? args?.tabId ?? args?.id)
}

const TAB_ACTIONS = ['list', 'switch', 'replace', 'navigate', 'close', 'back', 'forward'] as const

function normalizeTabAction(args: any): string {
  const action = String(args?.action || '').trim()
  if (action === 'open' || action === 'activate') {
    return action === 'open' ? 'navigate' : 'switch'
  }
  if (action === 'navigate' && (args?.replace_current === true || args?.current_tab === true || args?.same_tab === true)) {
    return 'replace'
  }
  return action
}

function tabSummary(tab: chrome.tabs.Tab) {
  return { id: tab.id, url: tab.url, title: tab.title, active: !!tab.active, windowId: tab.windowId }
}

async function resolveTargetTab(args: any): Promise<chrome.tabs.Tab> {
  const requested = tabIdArg(args)
  if (Number.isFinite(requested) && requested > 0) return chrome.tabs.get(requested)
  return getActiveTab()
}

// ── chrome.* API tools ────────────────────────────────────────────────────
async function toolTabNavigate(args: any): Promise<any> {
  const href = normalizePageUrl(args.url)
  const tab = await chrome.tabs.create({ url: href, active: true })
  await focusTab(tab.id!)
  await waitForTabLoad(tab.id!)
  const refreshed = await chrome.tabs.get(tab.id!)
  return { success: true, action: 'navigate', ...tabSummary(refreshed), url: refreshed.url || href }
}

async function toolTabReplace(args: any): Promise<any> {
  const href = normalizePageUrl(args.url)
  let tab: chrome.tabs.Tab
  try {
    tab = await resolveTargetTab(args)
  } catch {
    const created = await chrome.tabs.create({ url: href, active: true })
    await waitForTabLoad(created.id!)
    const refreshed = await chrome.tabs.get(created.id!)
    return {
      success: true,
      action: 'replace',
      ...tabSummary(refreshed),
      url: refreshed.url || href,
      note: 'No usable target page tab; opened URL in a new tab instead.',
    }
  }

  await chrome.tabs.update(tab.id!, { url: href, active: true })
  await focusTab(tab.id!)
  await waitForTabLoad(tab.id!)
  const refreshed = await chrome.tabs.get(tab.id!)
  return { success: true, action: 'replace', ...tabSummary(refreshed), url: refreshed.url || href }
}

function unsupportedScreenshotReason(url?: string) {
  const raw = String(url || '')
  if (/^(chrome|edge|brave|vivaldi|opera|chrome-extension):\/\//i.test(raw)) {
    return '浏览器内部页面或扩展页面不允许扩展截图。请切换到普通 http/https 页面后重试。'
  }
  if (/^https:\/\/chromewebstore\.google\.com\//i.test(raw)) {
    return 'Chrome 网上应用店页面不允许扩展截图。'
  }
  return ''
}

function isRetryableCaptureError(message: string) {
  return /quota|too many|rate|active|visible|tab|capture|pending|loading/i.test(message)
}

async function delay(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function playScreenshotFx(tab: chrome.tabs.Tab, msg: Record<string, any>) {
  try {
    await contentMsg(tab.id!, { action: 'screenshot_fx', ...msg })
  } catch { /* visual-only; never block capture */ }
}

function wantsScreenshotFx(args: any) {
  return args.screenshot_fx !== false && args.fx !== false
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function boundedTimeout(value: any, fallback: number, min = 1000, max = 30000) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

type ScreenshotFormat = 'png' | 'jpeg' | 'webp'

type ScreenshotClip = {
  x: number
  y: number
  width: number
  height: number
  scale?: number
}

function screenshotFormat(args: any): ScreenshotFormat {
  const format = String(args.format || 'png').toLowerCase()
  return ['png', 'jpeg', 'webp'].includes(format) ? format as ScreenshotFormat : 'png'
}

function screenshotQuality(args: any) {
  const quality = Number(args.quality)
  if (!Number.isFinite(quality)) return undefined
  return Math.min(100, Math.max(0, Math.round(quality)))
}

function maxDataUrlChars(args: any) {
  const n = Number(args.max_data_url_chars)
  if (Number.isFinite(n) && n > 0) return Math.min(20_000_000, Math.max(100_000, Math.round(n)))
  return 8_000_000
}

function wantsServerSave(args: any): boolean {
  return args?.save_to_server === true || args?.upload_to_server === true || wantsSendToUser(args)
}

function wantsSendToUser(args: any): boolean {
  const values = [args?.send_to_user, args?.bot_send_to_user, args?.deliver_to_user]
    .filter((value) => value !== undefined)
  if (values.some((value) => value === true)) return true
  if (values.some((value) => value === false)) return false
  return true
}

async function ensureScreenshotPayloadSize(
  dataUrl: string,
  args: any,
  retryCompressed?: () => Promise<string>,
) {
  const maxChars = maxDataUrlChars(args)
  if (dataUrl.length <= maxChars || args.allow_large_data_url === true) {
    return { dataUrl, warning: '' }
  }

  if (retryCompressed && screenshotFormat(args) !== 'jpeg') {
    const compressed = await retryCompressed()
    if (compressed.length <= maxChars || args.allow_large_data_url === true) {
      return {
        dataUrl: compressed,
        warning: `Original screenshot payload was ${dataUrl.length} chars; returned compressed JPEG payload ${compressed.length} chars.`,
      }
    }
    throw new Error(`Screenshot payload is too large after JPEG compression: ${compressed.length} chars > max_data_url_chars ${maxChars}`)
  }

  throw new Error(`Screenshot payload is too large: ${dataUrl.length} chars > max_data_url_chars ${maxChars}`)
}

function clipArea(clip: ScreenshotClip) {
  return Math.max(0, clip.width) * Math.max(0, clip.height)
}

function assertValidClip(clip: ScreenshotClip, maxArea: number) {
  if (!Number.isFinite(clip.x) || !Number.isFinite(clip.y) || !Number.isFinite(clip.width) || !Number.isFinite(clip.height)) {
    throw new Error('clip/x/y/width/height must be finite numbers')
  }
  if (clip.width <= 0 || clip.height <= 0) throw new Error('clip width and height must be greater than 0')
  if (clipArea(clip) > maxArea) {
    throw new Error(`Screenshot area is too large: ${Math.round(clipArea(clip))} CSS pixels > max_area ${maxArea}`)
  }
}

async function captureVisibleTab(windowId: number, args: any, retries = 1) {
  let lastErr: any
  const timeoutMs = boundedTimeout(args.visible_timeout_ms ?? args.timeout_ms, 8000)
  for (let i = 0; i <= retries; i++) {
    try {
      return await withTimeout(
        chrome.tabs.captureVisibleTab(windowId, {
          format: screenshotFormat(args) === 'jpeg' ? 'jpeg' : 'png',
          quality: screenshotQuality(args),
        }),
        timeoutMs,
        'chrome.tabs.captureVisibleTab',
      )
    } catch (err: any) {
      lastErr = err
      const message = err?.message || String(err)
      if (i >= retries || !isRetryableCaptureError(message)) break
      await delay(300)
    }
  }
  throw lastErr
}

async function pageClipFromArgs(tab: chrome.tabs.Tab, args: any): Promise<ScreenshotClip | null> {
  const maxArea = Math.max(1, Number(args.max_area || 25_000_000))
  const scale = Number(args.scale || 1)
  const contentTimeoutMs = boundedTimeout(args.content_timeout_ms ?? args.timeout_ms, 5000)
  const cdpTimeoutMs = boundedTimeout(args.cdp_timeout_ms ?? args.timeout_ms, 12000)

  if (args.selector || args.text) {
    const target = await withTimeout(
      contentMsg(tab.id!, {
        action: 'screenshot_target_info',
        selector: args.selector,
        text: args.text,
        margin: args.margin ?? args.padding,
        scroll_into_view: args.scroll_into_view,
        block: args.block,
        inline: args.inline,
      }),
      contentTimeoutMs,
      'screenshot target measurement',
    )
    const rect = target?.rect?.page
    const clip = {
      x: Number(rect?.x),
      y: Number(rect?.y),
      width: Number(rect?.width),
      height: Number(rect?.height),
      scale,
    }
    assertValidClip(clip, maxArea)
    return clip
  }

  const rawClip = args.clip && typeof args.clip === 'object' ? args.clip : args
  const hasRegion = rawClip.x !== undefined && rawClip.y !== undefined && rawClip.width !== undefined && rawClip.height !== undefined
  if (!hasRegion) return null

  const coordinateSpace = String(args.coordinate_space || rawClip.coordinate_space || 'viewport')
  let x = Number(rawClip.x)
  let y = Number(rawClip.y)
  if (coordinateSpace !== 'page') {
    const metrics: any = await withTimeout(
      chrome.debugger.sendCommand({ tabId: tab.id! }, 'Page.getLayoutMetrics'),
      cdpTimeoutMs,
      'CDP Page.getLayoutMetrics',
    )
    const viewport = metrics?.cssLayoutViewport || metrics?.layoutViewport
    x += Number(viewport?.pageX || 0)
    y += Number(viewport?.pageY || 0)
  }

  const clip = {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Number(rawClip.width),
    height: Number(rawClip.height),
    scale,
  }
  assertValidClip(clip, maxArea)
  return clip
}

async function captureWithDebugger(tab: chrome.tabs.Tab, args: any = {}) {
  const target = { tabId: tab.id! }
  let attached = false
  const timeoutMs = boundedTimeout(args.cdp_timeout_ms ?? args.timeout_ms, 12000)
  try {
    await withTimeout(chrome.debugger.attach(target, '1.3'), timeoutMs, 'CDP attach')
    attached = true

    await withTimeout(chrome.debugger.sendCommand(target, 'Page.enable'), timeoutMs, 'CDP Page.enable')
    const format = screenshotFormat(args)
    const params: any = { format, fromSurface: args.from_surface !== false }
    const quality = screenshotQuality(args)
    if (format !== 'png' && quality !== undefined) params.quality = quality

    const maxArea = Math.max(1, Number(args.max_area || 25_000_000))
    const clip = await pageClipFromArgs(tab, args)

    if (clip) {
      params.captureBeyondViewport = true
      params.clip = clip
    } else if (args.full_page) {
      const metrics: any = await withTimeout(
        chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics'),
        timeoutMs,
        'CDP Page.getLayoutMetrics',
      )
      const size = metrics?.cssContentSize || metrics?.contentSize
      if (size?.width && size?.height) {
        const fullClip = {
          x: 0,
          y: 0,
          width: Math.ceil(size.width),
          height: Math.ceil(size.height),
          scale: Number(args.scale || 1),
        }
        assertValidClip(fullClip, maxArea)
        params.captureBeyondViewport = true
        params.clip = fullClip
      }
    }

    const result: any = await withTimeout(
      chrome.debugger.sendCommand(target, 'Page.captureScreenshot', params),
      timeoutMs,
      'CDP Page.captureScreenshot',
    )
    if (!result?.data) throw new Error('CDP Page.captureScreenshot returned no image data')
    return `data:image/${format === 'jpeg' ? 'jpeg' : format};base64,${result.data}`
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target) } catch { /* tab may have closed */ }
    }
  }
}

async function toolScreenshot(args: any = {}): Promise<any> {
  const tab = await getActiveTab()
  const unsupported = unsupportedScreenshotReason(tab.url)
  if (unsupported) {
    return {
      success: false,
      disabled: true,
      unsupported: true,
      error: unsupported,
      tabId: tab.id,
      url: tab.url,
      hint: unsupported,
    }
  }

  const showFx = wantsScreenshotFx(args)
  const wantsDebuggerCapture = !!(args.full_page || args.selector || args.text || args.clip || (
    args.x !== undefined && args.y !== undefined && args.width !== undefined && args.height !== undefined
  ))
  const attempts: string[] = []

  const finishScreenshot = async (result: any) => {
    if (showFx && result?.success) {
      await playScreenshotFx(tab, { phase: 'after' })
      await playScreenshotFx(tab, { phase: 'clear' })
    }
    return result
  }

  if (showFx) {
    await playScreenshotFx(tab, {
      phase: 'before',
      selector: args.selector,
      text: args.text,
      margin: args.margin ?? args.padding ?? 8,
      full_page: !!args.full_page,
    })
  }

  if (wantsDebuggerCapture) {
    try {
      const dataUrl = await captureWithDebugger(tab, args)
      const optimized = await ensureScreenshotPayloadSize(dataUrl, args, () => captureWithDebugger(tab, {
        ...args,
        format: 'jpeg',
        quality: args.quality ?? 70,
      }))
      return finishScreenshot({
        success: true,
        dataUrl: optimized.dataUrl,
        save_to_server: wantsServerSave(args),
        send_to_user: wantsSendToUser(args),
        tabId: tab.id,
        url: tab.url,
        method: args.full_page
          ? 'debugger.Page.captureScreenshot.fullPage'
          : args.selector || args.text
            ? 'debugger.Page.captureScreenshot.element'
            : 'debugger.Page.captureScreenshot.clip',
        warning: optimized.warning || undefined,
      })
    } catch (err: any) {
      attempts.push(`debugger.Page.captureScreenshot: ${err?.message || String(err)}`)
    }
    if (args.fallback_visible !== true) {
      const message = attempts.join('; ')
      return {
        success: false,
        disabled: /disabled|permission|not allowed|cannot|restricted|debugger/i.test(message),
        error: message,
        tabId: tab.id,
        url: tab.url,
        hint: '精确截图失败。请检查 selector/text/clip 参数；若要失败时退回可视区域截图，请传 fallback_visible:true。',
      }
    }
  }

  // captureVisibleTab only works on a foreground tab. When the browser is in the
  // background (unfocused/minimized window, or the target isn't the active tab),
  // it's guaranteed to fail or return a blank frame — so go straight to the CDP
  // path instead of burning a failed attempt and emitting a confusing warning.
  const foreground = await isTabForeground(tab)

  if (foreground) {
    try {
      const dataUrl = await captureVisibleTab(tab.windowId!, args, Number(args.retries ?? 1))
      const optimized = await ensureScreenshotPayloadSize(dataUrl, args, () => captureVisibleTab(tab.windowId!, {
        ...args,
        format: 'jpeg',
        quality: args.quality ?? 70,
        retries: 0,
      }, 0))
      return finishScreenshot({
        success: true,
        dataUrl: optimized.dataUrl,
        save_to_server: wantsServerSave(args),
        send_to_user: wantsSendToUser(args),
        tabId: tab.id,
        url: tab.url,
        method: 'captureVisibleTab',
        warning: [attempts.length ? attempts.join('; ') : '', optimized.warning].filter(Boolean).join('; ') || undefined,
      })
    } catch (err: any) {
      attempts.push(`captureVisibleTab: ${err?.message || String(err)}`)
    }
  } else {
    attempts.push('captureVisibleTab: skipped (tab not in foreground — using CDP capture)')
  }

  if (!wantsDebuggerCapture) {
    try {
      const dataUrl = await captureWithDebugger(tab, args)
      const optimized = await ensureScreenshotPayloadSize(dataUrl, args, () => captureWithDebugger(tab, {
        ...args,
        format: 'jpeg',
        quality: args.quality ?? 70,
      }))
      return finishScreenshot({
        success: true,
        dataUrl: optimized.dataUrl,
        save_to_server: wantsServerSave(args),
        send_to_user: wantsSendToUser(args),
        tabId: tab.id,
        url: tab.url,
        method: 'debugger.Page.captureScreenshot',
        warning: [attempts.join('; '), optimized.warning].filter(Boolean).join('; '),
      })
    } catch (err: any) {
      attempts.push(`debugger.Page.captureScreenshot: ${err?.message || String(err)}`)
    }
  }

  if (showFx) await playScreenshotFx(tab, { phase: 'clear' })
  const message = attempts.join('; ')
  return {
    success: false,
    disabled: /disabled|permission|not allowed|cannot|restricted|debugger/i.test(message),
    error: message,
    tabId: tab.id,
    url: tab.url,
    hint: '截图不可用。请确认扩展拥有当前页面权限；若页面是浏览器内部页、扩展页、Chrome 网上应用店或受 DRM 保护内容，Chrome 会阻止截图。',
  }
}

async function toolTabList(): Promise<any> {
  const tabs = await chrome.tabs.query({})
  const activeTab = tabs.find(t => t.active) || null
  return {
    success: true,
    action: 'list',
    count: tabs.length,
    activeTabId: activeTab?.id ?? null,
    activeTab: activeTab ? tabSummary(activeTab) : null,
    tabs: tabs.map(tabSummary),
  }
}

async function toolTabSwitch(args: any): Promise<any> {
  const tabId = tabIdArg(args)
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error('tab_id is required for switch action')
  }
  await focusTab(tabId)
  if ((await chrome.tabs.get(tabId)).status !== 'complete') {
    await waitForTabLoad(tabId).catch(() => {})
  }
  const refreshed = await chrome.tabs.get(tabId)
  const [active] = await chrome.tabs.query({ active: true, windowId: refreshed.windowId })
  return {
    success: true,
    action: 'switch',
    ...tabSummary(refreshed),
    focused: active?.id === tabId,
  }
}

async function toolTabClose(args: any): Promise<any> {
  const requested = tabIdArg(args)
  const tabId = Number.isFinite(requested) && requested > 0 ? requested : (await getAnyActiveTab()).id!
  const closing = await chrome.tabs.get(tabId)
  await chrome.tabs.remove(tabId)
  return { success: true, action: 'close', ...tabSummary(closing) }
}

async function toolHistoryBack(args: any = {}): Promise<any> {
  const tab = await resolveTargetTab(args)
  await focusTab(tab.id!)
  await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: () => history.back() })
  await delay(250)
  await waitForTabLoad(tab.id!).catch(() => {})
  const refreshed = await chrome.tabs.get(tab.id!)
  return { success: true, action: 'back', ...tabSummary(refreshed) }
}

async function toolHistoryForward(args: any = {}): Promise<any> {
  const tab = await resolveTargetTab(args)
  await focusTab(tab.id!)
  await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: () => history.forward() })
  await delay(250)
  await waitForTabLoad(tab.id!).catch(() => {})
  const refreshed = await chrome.tabs.get(tab.id!)
  return { success: true, action: 'forward', ...tabSummary(refreshed) }
}

async function toolClipboardWrite(args: any): Promise<any> {
  const text = String(args.text ?? '')
  const tab  = await getActiveTab()
  await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    func: (t: string) => navigator.clipboard.writeText(t),
    args: [text],
  })
  return { success: true, length: text.length }
}

// ── Content-script-relayed tools ──────────────────────────────────────────
// Resolve which frame an interaction targets. A ref like "3:5" routes to frame 3
// (a cross-origin iframe) with local id 5; in that case page-level x/y coords are
// meaningless inside the sub-frame and are dropped so the ref/selector wins.
function routeTarget(args: any): { frameId: number; ref: any; selector?: string; text?: string; x?: number; y?: number } {
  const { frameId, ref } = parseRef(args.ref ?? args.mark ?? args.id)
  if (frameId !== 0) return { frameId, ref, selector: args.selector, text: args.text }
  return { frameId, ref, selector: args.selector, text: args.text, x: args.x, y: args.y }
}

async function toolClick(args: any): Promise<any> {
  const tab = await getActiveTab()
  const t = routeTarget(args)
  return contentMsg(tab.id!, {
    action: 'click',
    ref: t.ref,
    selector: t.selector, text: t.text, x: t.x, y: t.y,
    force: !!args.force,
  }, t.frameId)
}

function observeMsg(args: any) {
  return {
    action: 'observe',
    limit: args.limit,
    mark: args.mark,
    include_text: args.include_text,
    text_limit: args.text_limit,
    group_similar: args.group_similar,
    group_min: args.group_min,
    group_key: args.group_key,
    expand_group: args.expand_group,
  }
}

// Re-key a cross-origin frame's observe result so it merges cleanly into the
// top-frame result: element/interactive ids become "<frameId>:<localId>" (so a
// later click routes back to this frame, where the local id is still valid) and
// every item is tagged with frameId / frameUrl. Coordinates stay in the frame's
// own viewport space (clicks route by ref, and each frame paints its own overlay
// for screenshots), flagged via coordsLocalToFrame so they're not misread as
// top-level page coordinates.
function tagFrameObserveResult(res: any, frame: FrameNode): { items: any[]; elements: any[]; frames: any[]; texts: any[] } {
  const fid = frame.frameId
  const reId = (id: any) => `${fid}:${id}`
  const tag = (item: any) => ({
    ...item,
    ...(item.kind === 'interactive' && item.id !== undefined ? { id: reId(item.id) } : {}),
    inFrame: true,
    crossOrigin: true,
    frameId: fid,
    frameUrl: frame.url,
    coordsLocalToFrame: true,
  })
  return {
    items: Array.isArray(res?.items) ? res.items.map(tag) : [],
    elements: Array.isArray(res?.elements) ? res.elements.map(tag) : [],
    frames: Array.isArray(res?.frames) ? res.frames.map(tag) : [],
    texts: Array.isArray(res?.texts) ? res.texts.map(tag) : [],
  }
}

async function toolObserve(args: any): Promise<any> {
  const tab = await getActiveTab()
  const base = await contentMsg(tab.id!, observeMsg(args), 0)

  // Cross-origin iframes can't be read from the top frame; observe each one in
  // its own frame and merge. Same-origin frames are already covered by the top
  // frame's recursion, so they are intentionally not re-observed here.
  const roots = crossOriginFrameRoots(await listFrames(tab.id!))
  const observed = roots.slice(0, MAX_CROSS_ORIGIN_FRAMES)
  const frameResults = await Promise.all(observed.map(async (frame) => {
    try {
      const res = await contentMsg(tab.id!, observeMsg(args), frame.frameId)
      return { frame, ...tagFrameObserveResult(res, frame) }
    } catch {
      return null  // frame gone, restricted, or no script — skip it
    }
  }))

  let extraInteractive = 0
  let extraText = 0
  const crossFrames: any[] = []
  for (const fr of frameResults) {
    if (!fr) continue
    base.items.push(...fr.items)
    base.elements.push(...fr.elements)
    base.frames.push(...fr.frames)
    base.texts.push(...fr.texts)
    extraInteractive += fr.elements.length
    extraText += fr.texts.length
    crossFrames.push({ frameId: fr.frame.frameId, url: fr.frame.url, interactive: fr.elements.length, text: fr.texts.length })
  }

  if (crossFrames.length) {
    base.count = (base.count || 0) + extraInteractive
    base.textCount = (base.textCount || 0) + extraText
    base.itemCount = Array.isArray(base.items) ? base.items.length : base.itemCount
    base.crossOriginFrames = crossFrames
    base.crossOriginFramesTruncated = roots.length > observed.length
    base.hint = `${base.hint || ''} 跨域 iframe 内容已合并：带 crossOrigin=true / frameId 的 items 来自跨域子框架，其 center/rect 为该框架内部坐标（coordsLocalToFrame=true，勿与主页面坐标混用）；点击用 browser_action {action:"click", ref:"<frameId>:<id>"}（observe 返回的 id 已是该格式）。`
  }

  return base
}

async function toolType(args: any): Promise<any> {
  const tab = await getActiveTab()
  const { frameId, ref } = parseRef(args.ref ?? args.mark ?? args.id)
  const result = await contentMsg(tab.id!, {
    action: 'type',
    ref,
    selector: args.selector,
    text: args.text,
    clearFirst: args.clear_first !== false,
    submit: false,
  }, frameId)
  if (!args.submit) return result

  try {
    const pressed = await debuggerPressKey(tab.id!, { key: 'Enter' })
    return { ...result, submitted: true, submit_method: pressed.method }
  } catch (debuggerErr: any) {
    await contentMsg(tab.id!, { action: 'press_key', key: 'Enter' })
    return {
      ...result,
      submitted: true,
      submit_method: 'content.KeyboardEvent',
      warning: `Native submit key dispatch failed, fell back to synthetic KeyboardEvent: ${debuggerErr?.message || String(debuggerErr)}`,
    }
  }
}

async function toolScroll(args: any): Promise<any> {
  const tab = await getActiveTab()
  return contentMsg(tab.id!, { action: 'scroll', direction: args.direction, amount: args.amount || 400, selector: args.selector })
}

async function toolWait(args: any): Promise<any> {
  const tab = await getActiveTab()
  return contentMsg(tab.id!, { action: 'wait', selector: args.selector, ms: args.ms })
}

function remoteObjectValue(obj: any): any {
  if (!obj) return undefined
  if ('value' in obj) return obj.value
  if ('unserializableValue' in obj) return obj.unserializableValue
  return obj.description ?? `[${obj.type || 'unknown'}]`
}

function exceptionMessage(details: any): string {
  const exception = details?.exception
  return exception?.description || exception?.value || details?.text || 'JavaScript evaluation failed'
}

async function debuggerEvaluate(tabId: number, code: string): Promise<any> {
  const target = { tabId }
  let attached = false

  async function evaluateExpression(expression: string) {
    const result: any = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      replMode: true,
    })
    if (result?.exceptionDetails) throw new Error(exceptionMessage(result.exceptionDetails))
    return result?.result
  }

  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true

    let result: any
    try {
      result = await evaluateExpression(code)
    } catch (err: any) {
      if (!/Illegal return statement|Unexpected token|await is only valid/i.test(err.message || '')) throw err
      result = await evaluateExpression(`(async () => {\n${code}\n})()`)
    }

    return {
      success: true,
      result: remoteObjectValue(result),
      type: result?.type,
      subtype: result?.subtype,
      executionContext: 'debugger',
    }
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target) } catch { /* tab may have closed */ }
    }
  }
}

const SPECIAL_KEY_INFO: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter:      { key: 'Enter',      code: 'Enter',      windowsVirtualKeyCode: 13 },
  Return:     { key: 'Enter',      code: 'Enter',      windowsVirtualKeyCode: 13 },
  Escape:     { key: 'Escape',     code: 'Escape',     windowsVirtualKeyCode: 27 },
  Esc:        { key: 'Escape',     code: 'Escape',     windowsVirtualKeyCode: 27 },
  Tab:        { key: 'Tab',        code: 'Tab',        windowsVirtualKeyCode: 9 },
  Backspace:  { key: 'Backspace',  code: 'Backspace',  windowsVirtualKeyCode: 8 },
  Delete:     { key: 'Delete',     code: 'Delete',     windowsVirtualKeyCode: 46 },
  Insert:     { key: 'Insert',     code: 'Insert',     windowsVirtualKeyCode: 45 },
  Home:       { key: 'Home',       code: 'Home',       windowsVirtualKeyCode: 36 },
  End:        { key: 'End',        code: 'End',        windowsVirtualKeyCode: 35 },
  PageUp:     { key: 'PageUp',     code: 'PageUp',     windowsVirtualKeyCode: 33 },
  PageDown:   { key: 'PageDown',   code: 'PageDown',   windowsVirtualKeyCode: 34 },
  ArrowLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  windowsVirtualKeyCode: 37 },
  ArrowUp:    { key: 'ArrowUp',    code: 'ArrowUp',    windowsVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown:  { key: 'ArrowDown',  code: 'ArrowDown',  windowsVirtualKeyCode: 40 },
  Space:      { key: ' ',          code: 'Space',      windowsVirtualKeyCode: 32 },
  ' ':        { key: ' ',          code: 'Space',      windowsVirtualKeyCode: 32 },
}

for (let i = 1; i <= 12; i++) {
  SPECIAL_KEY_INFO[`F${i}`] = { key: `F${i}`, code: `F${i}`, windowsVirtualKeyCode: 111 + i }
}

function modifierBits(args: any) {
  return (args.alt ? 1 : 0) |
    (args.ctrl ? 2 : 0) |
    (args.meta ? 4 : 0) |
    (args.shift ? 8 : 0)
}

function keyInfo(rawKey: any) {
  const raw = String(rawKey || '')
  const special = SPECIAL_KEY_INFO[raw]
  if (special) return special

  if (/^[a-z]$/i.test(raw)) {
    const upper = raw.toUpperCase()
    return { key: raw.length === 1 ? raw : upper, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) }
  }

  if (/^[0-9]$/.test(raw)) {
    return { key: raw, code: `Digit${raw}`, windowsVirtualKeyCode: raw.charCodeAt(0) }
  }

  if (raw.length === 1) {
    return { key: raw, code: '', windowsVirtualKeyCode: raw.toUpperCase().charCodeAt(0) }
  }

  return { key: raw, code: raw, windowsVirtualKeyCode: 0 }
}

async function debuggerPressKey(tabId: number, args: any): Promise<any> {
  const info = keyInfo(args.key)
  const modifiers = modifierBits(args)
  const target = { tabId }
  let attached = false

  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true

    const printable = info.key.length === 1 && modifiers === 0 && info.key !== '\r'
    const base: any = {
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.windowsVirtualKeyCode,
      nativeVirtualKeyCode: info.windowsVirtualKeyCode,
      modifiers,
    }
    if (printable) base.text = info.key

    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      ...base,
      type: printable ? 'keyDown' : 'rawKeyDown',
    })
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      ...base,
      type: 'keyUp',
      text: undefined,
    })
    return { success: true, key: info.key, code: info.code, method: 'debugger.Input.dispatchKeyEvent' }
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target) } catch { /* tab may have closed */ }
    }
  }
}

async function toolEvaluate(args: any): Promise<any> {
  const tab = await getActiveTab()
  const rawCode = args.code ?? args.function ?? args.fn ?? args.expression
  const code = typeof rawCode === 'function' ? String(rawCode) : String(rawCode || '')
  if (!code) throw new Error('code is required')

  try {
    return await debuggerEvaluate(tab.id!, code)
  } catch (debuggerErr: any) {
    try {
      const fallback = await contentMsg(tab.id!, { action: 'evaluate', code })
      return {
        ...fallback,
        executionContext: 'content_script',
        warning: `CDP Runtime.evaluate failed: ${debuggerErr.message || String(debuggerErr)}`,
      }
    } catch (contentErr: any) {
      throw new Error(`browser_evaluate failed. CDP Runtime.evaluate: ${debuggerErr.message || String(debuggerErr)}; content script fallback: ${contentErr.message || String(contentErr)}`)
    }
  }
}

async function toolExtract(args: any): Promise<any> {
  const tab = await getActiveTab()
  return contentMsg(tab.id!, { action: 'extract', selector: args.selector, attributes: args.attributes, limit: args.limit || 50 })
}

async function toolIframeList(): Promise<any> {
  const tab = await getActiveTab()
  return contentMsg(tab.id!, { action: 'iframe_list' })
}

async function toolPerformance(): Promise<any> {
  const tab = await getActiveTab()
  return contentMsg(tab.id!, { action: 'performance' })
}

async function toolNetworkLog(args: any): Promise<any> {
  const tab = await getActiveTab()
  const result = await contentMsg(tab.id!, { action: 'performance' })
  return {
    ...result,
    source: 'performance_resource_timing',
    warning: 'This is a passive resource-timing view, not active network interception. Full request/response interception requires a debugger/webRequest pipeline.',
    limit: args.limit || 20,
    requests: (result.resources?.slowest || []).slice(0, args.limit || 20),
  }
}

async function toolFindText(args: any): Promise<any> {
  const tab = await getActiveTab()
  return contentMsg(tab.id!, { action: 'find_text', text: args.text, exact: !!args.exact })
}

async function toolStorageGet(args: any): Promise<any> {
  const tab = await getActiveTab()
  return contentMsg(tab.id!, { action: 'storage_get', key: args.key, storageType: args.type || 'local' })
}

async function toolStorageSet(args: any): Promise<any> {
  const tab = await getActiveTab()
  return contentMsg(tab.id!, { action: 'storage_set', key: args.key, value: args.value, storageType: args.type || 'local' })
}

async function toolStorageRemove(args: any): Promise<any> {
  const tab = await getActiveTab()
  return contentMsg(tab.id!, { action: 'storage_remove', key: args.key, storageType: args.type || 'local' })
}

async function toolStorageList(args: any): Promise<any> {
  const tab = await getActiveTab()
  return contentMsg(tab.id!, { action: 'storage_list', prefix: args.prefix, include_values: !!args.include_values, limit: args.limit, storageType: args.type || 'local' })
}

async function toolFileUpload(args: any): Promise<any> {
  const tab = await getActiveTab()
  return contentMsg(tab.id!, { action: 'file_upload', selector: args.selector, files: args.files })
}

async function toolDownload(args: any): Promise<any> {
  if (!args.url) throw new Error('url is required')
  const id = await chrome.downloads.download({
    url: String(args.url),
    filename: args.filename ? String(args.filename) : undefined,
    saveAs: !!args.save_as,
  })
  return { success: true, downloadId: id, url: args.url, filename: args.filename || '' }
}

async function toolCookieList(args: any): Promise<any> {
  const tab = await getActiveTab()
  const url = String(args.url || tab.url || '')
  const cookies = await chrome.cookies.getAll(args.domain ? { domain: String(args.domain) } : { url })
  return { success: true, url, domain: args.domain || '', count: cookies.length, cookies }
}

async function toolCookieGet(args: any): Promise<any> {
  const tab = await getActiveTab()
  const url = String(args.url || tab.url || '')
  if (!args.name) throw new Error('name is required')
  const cookie = await chrome.cookies.get({ url, name: String(args.name) })
  return { success: true, url, name: args.name, found: !!cookie, cookie }
}

async function toolCookieSet(args: any): Promise<any> {
  const tab = await getActiveTab()
  const url = String(args.url || tab.url || '')
  if (!args.name) throw new Error('name is required')
  const cookie = await chrome.cookies.set({
    url,
    name: String(args.name),
    value: String(args.value ?? ''),
    domain: args.domain ? String(args.domain) : undefined,
    path: args.path ? String(args.path) : undefined,
    secure: args.secure === undefined ? undefined : !!args.secure,
    httpOnly: args.http_only === undefined ? undefined : !!args.http_only,
    expirationDate: args.expiration_date ? Number(args.expiration_date) : undefined,
  })
  return { success: true, cookie }
}

async function toolCookieDelete(args: any): Promise<any> {
  const tab = await getActiveTab()
  const url = String(args.url || tab.url || '')
  if (!args.name) throw new Error('name is required')
  const details = await chrome.cookies.remove({ url, name: String(args.name) })
  return { success: true, removed: !!details, details }
}

const SESSION_KEY = '_browser_sessions'

async function readSessions(): Promise<any[]> {
  const r = await chrome.storage.local.get(SESSION_KEY)
  return Array.isArray(r[SESSION_KEY]) ? r[SESSION_KEY] : []
}

async function writeSessions(sessions: any[]): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEY]: sessions })
}

async function toolSessionSave(args: any): Promise<any> {
  const tab = await getActiveTab()
  const id = String(args.id || `session_${Date.now()}`)
  const name = String(args.name || id)
  let local: any = null
  let session: any = null
  try { local = await contentMsg(tab.id!, { action: 'storage_list', include_values: true, storageType: 'local', limit: 500 }) } catch { /* ignore */ }
  try { session = await contentMsg(tab.id!, { action: 'storage_list', include_values: true, storageType: 'session', limit: 500 }) } catch { /* ignore */ }
  const snapshot = { id, name, url: tab.url, title: tab.title, createdAt: Date.now(), storage: { local, session } }
  const sessions = (await readSessions()).filter(s => s.id !== id)
  sessions.push(snapshot)
  await writeSessions(sessions)
  return { success: true, session: snapshot }
}

async function toolSessionList(): Promise<any> {
  const sessions = await readSessions()
  return { success: true, count: sessions.length, sessions: sessions.map(s => ({ id: s.id, name: s.name, url: s.url, title: s.title, createdAt: s.createdAt })) }
}

async function toolSessionRestore(args: any): Promise<any> {
  const sessions = await readSessions()
  const target = sessions.find(s => s.id === args.id || s.name === args.name)
  if (!target) throw new Error('session not found')
  if (args.new_tab === false) await toolTabReplace({ url: target.url })
  else await toolTabNavigate({ url: target.url })
  const tab = await getActiveTab()
  for (const item of target.storage?.local?.items || []) {
    await contentMsg(tab.id!, { action: 'storage_set', key: item.key, value: item.value, storageType: 'local' }).catch(() => {})
  }
  for (const item of target.storage?.session?.items || []) {
    await contentMsg(tab.id!, { action: 'storage_set', key: item.key, value: item.value, storageType: 'session' }).catch(() => {})
  }
  return { success: true, restored: { id: target.id, name: target.name, url: target.url } }
}

async function toolSessionDelete(args: any): Promise<any> {
  const sessions = await readSessions()
  const kept = sessions.filter(s => s.id !== args.id && s.name !== args.name)
  await writeSessions(kept)
  return { success: true, deleted: sessions.length - kept.length }
}

async function toolProfileInfo(): Promise<any> {
  const r = await chrome.storage.local.get('_logical_profile')
  return {
    success: true,
    profile: r._logical_profile || 'default',
    scope: 'extension-logical-profile',
    warning: 'Chrome extensions cannot switch the browser user profile. This is a logical profile marker for extension-side state only.',
  }
}

async function toolProfileSet(args: any): Promise<any> {
  const profile = String(args.name || args.profile || 'default')
  await chrome.storage.local.set({ _logical_profile: profile })
  return { success: true, profile, scope: 'extension-logical-profile' }
}

async function toolRightClick(args: any): Promise<any> {
  const tab = await getActiveTab()
  const t = routeTarget(args)
  return contentMsg(tab.id!, { action: 'right_click', ref: t.ref, selector: t.selector, text: t.text, x: t.x, y: t.y }, t.frameId)
}

async function toolDoubleClick(args: any): Promise<any> {
  const tab = await getActiveTab()
  const t = routeTarget(args)
  return contentMsg(tab.id!, { action: 'double_click', ref: t.ref, selector: t.selector, text: t.text, x: t.x, y: t.y }, t.frameId)
}

async function toolDrag(args: any): Promise<any> {
  const tab = await getActiveTab()
  return contentMsg(tab.id!, {
    action: 'drag',
    selector: args.selector, text: args.text, x: args.x, y: args.y,
    toSelector: args.to_selector, toText: args.to_text, toX: args.to_x, toY: args.to_y,
  })
}

async function toolPressKey(args: any): Promise<any> {
  const tab = await getActiveTab()
  const fallback = () => contentMsg(tab.id!, {
    action: 'press_key',
    key: args.key, selector: args.selector,
    ctrl: !!args.ctrl, shift: !!args.shift, alt: !!args.alt, meta: !!args.meta,
  })

  try {
    if (args.selector) {
      await contentMsg(tab.id!, { action: 'focus_target', selector: args.selector })
    }
    return await debuggerPressKey(tab.id!, args)
  } catch (debuggerErr: any) {
    const result = await fallback()
    return {
      ...result,
      method: 'content.KeyboardEvent',
      warning: `Native key dispatch failed, fell back to synthetic KeyboardEvent: ${debuggerErr?.message || String(debuggerErr)}`,
    }
  }
}

// ── Action-dispatching handlers ───────────────────────────────────────────
// Several formerly-separate tools are now single tools that switch on an
// `action` param; each branch delegates to the original impl above, so
// behaviour is unchanged — only the tool surface is smaller:
//   · browser_tab    — list / open / close / activate + navigate / back / forward.
//   · browser_action — click / double_click / right_click / scroll / type / press_key (page interaction).
//   · browser_cookie / browser_storage / browser_session / browser_profile — state ops.
function badAction(tool: string, action: any, allowed: string[]): never {
  const got = action === undefined || action === '' ? '(空)' : String(action)
  throw new Error(`${tool}: 未知 action「${got}」，可选 ${allowed.join(' / ')}`)
}

// browser_tab: list / switch / replace / navigate / close / back / forward
function toolTab(args: any): Promise<any> {
  switch (normalizeTabAction(args)) {
    case 'list':     return toolTabList()
    case 'switch':   return toolTabSwitch(args)
    case 'replace':  return toolTabReplace(args)
    case 'navigate': return toolTabNavigate(args)
    case 'close':    return toolTabClose(args)
    case 'back':     return toolHistoryBack(args)
    case 'forward':  return toolHistoryForward(args)
    default:         return badAction('browser_tab', args?.action, [...TAB_ACTIONS])
  }
}

// browser_action aggregates the page-interaction verbs (click / double_click /
// right_click / scroll / type / press_key) behind a single action param. Each
// branch delegates to the original impl, so behaviour is unchanged.
function toolAction(args: any): Promise<any> {
  switch (args?.action) {
    case 'click':        return toolClick(args)
    case 'double_click': return toolDoubleClick(args)
    case 'right_click':  return toolRightClick(args)
    case 'scroll':       return toolScroll(args)
    case 'type':         return toolType(args)
    case 'press_key':    return toolPressKey(args)
    default:             return badAction('browser_action', args?.action, ['click', 'double_click', 'right_click', 'scroll', 'type', 'press_key'])
  }
}

function toolHistory(args: any): Promise<any> {
  switch (args?.action) {
    case 'back':    return toolHistoryBack(args)
    case 'forward': return toolHistoryForward(args)
    default:        return badAction('browser_history', args?.action, ['back', 'forward'])
  }
}

function toolCookie(args: any): Promise<any> {
  switch (args?.action) {
    case 'list':   return toolCookieList(args)
    case 'get':    return toolCookieGet(args)
    case 'set':    return toolCookieSet(args)
    case 'delete': return toolCookieDelete(args)
    default:       return badAction('browser_cookie', args?.action, ['list', 'get', 'set', 'delete'])
  }
}

function toolStorage(args: any): Promise<any> {
  switch (args?.action) {
    case 'get':    return toolStorageGet(args)
    case 'set':    return toolStorageSet(args)
    case 'remove': return toolStorageRemove(args)
    case 'list':   return toolStorageList(args)
    default:       return badAction('browser_storage', args?.action, ['get', 'set', 'remove', 'list'])
  }
}

function toolSession(args: any): Promise<any> {
  switch (args?.action) {
    case 'save':    return toolSessionSave(args)
    case 'list':    return toolSessionList()
    case 'restore': return toolSessionRestore(args)
    case 'delete':  return toolSessionDelete(args)
    default:        return badAction('browser_session', args?.action, ['save', 'list', 'restore', 'delete'])
  }
}

function toolProfile(args: any): Promise<any> {
  switch (args?.action) {
    case 'info': return toolProfileInfo()
    case 'set':  return toolProfileSet(args)
    default:     return badAction('browser_profile', args?.action, ['info', 'set'])
  }
}

// ── Browser-only router ───────────────────────────────────────────────────
// Handles browser_* tools only. Each entry returns the tool's promise. Legacy
// per-verb names (browser_cookie_get, …) are kept as aliases that translate to
// the merged "tool + action" form, so older callers keep working.
type ToolHandler = (args: any) => Promise<any>

const HANDLERS: Record<string, ToolHandler> = {
  // Navigation — navigate/back/forward are folded into browser_tab;
  // browser_history stays here (hidden) so legacy back/forward calls keep working.
  browser_history:       toolHistory,
  // Page observation
  browser_observe:       toolObserve,
  browser_screenshot:    toolScreenshot,
  browser_find_text:     toolFindText,
  browser_performance:   () => toolPerformance(),
  browser_network_log:   toolNetworkLog,
  browser_iframe_list:   () => toolIframeList(),
  // Interaction — click/double_click/right_click/scroll/type/press_key merged
  // into browser_action (action param). The rest stay as their own tools.
  browser_action:        toolAction,
  browser_wait:          toolWait,
  browser_drag:          toolDrag,
  // Data & scripting
  browser_evaluate:      toolEvaluate,
  browser_extract:       toolExtract,
  browser_clipboard_write: toolClipboardWrite,
  browser_file_upload:   toolFileUpload,
  browser_download:      toolDownload,
  // Browser state (merged action tools)
  browser_tab:           toolTab,
  browser_cookie:        toolCookie,
  browser_storage:       toolStorage,
  browser_session:       toolSession,
  browser_profile:       toolProfile,
}

// Legacy per-verb names → { tool, action } injected into the merged handler.
const LEGACY_ALIASES: Record<string, { tool: string; action: string }> = {
  // Page-interaction verbs merged into browser_action.
  browser_click:          { tool: 'browser_action', action: 'click' },
  browser_double_click:   { tool: 'browser_action', action: 'double_click' },
  browser_right_click:    { tool: 'browser_action', action: 'right_click' },
  browser_scroll:         { tool: 'browser_action', action: 'scroll' },
  browser_type:           { tool: 'browser_action', action: 'type' },
  browser_press_key:      { tool: 'browser_action', action: 'press_key' },
  // Page-level navigation merged into browser_tab.
  browser_navigate:       { tool: 'browser_tab',     action: 'navigate' },
  browser_tab_list:       { tool: 'browser_tab',     action: 'list' },
  browser_tab_open:       { tool: 'browser_tab',     action: 'navigate' },
  browser_tab_close:      { tool: 'browser_tab',     action: 'close' },
  browser_tab_navigate:   { tool: 'browser_tab',     action: 'navigate' },
  browser_tab_replace:    { tool: 'browser_tab',     action: 'replace' },
  browser_tab_activate:   { tool: 'browser_tab',     action: 'switch' },
  browser_tab_switch:     { tool: 'browser_tab',     action: 'switch' },
  browser_tab_back:       { tool: 'browser_tab',     action: 'back' },
  browser_tab_forward:    { tool: 'browser_tab',     action: 'forward' },
  browser_history_back:   { tool: 'browser_history', action: 'back' },
  browser_history_forward:{ tool: 'browser_history', action: 'forward' },
  browser_cookie_list:    { tool: 'browser_cookie',  action: 'list' },
  browser_cookie_get:     { tool: 'browser_cookie',  action: 'get' },
  browser_cookie_set:     { tool: 'browser_cookie',  action: 'set' },
  browser_cookie_delete:  { tool: 'browser_cookie',  action: 'delete' },
  browser_storage_get:    { tool: 'browser_storage', action: 'get' },
  browser_storage_set:    { tool: 'browser_storage', action: 'set' },
  browser_storage_remove: { tool: 'browser_storage', action: 'remove' },
  browser_storage_list:   { tool: 'browser_storage', action: 'list' },
  browser_session_save:   { tool: 'browser_session', action: 'save' },
  browser_session_list:   { tool: 'browser_session', action: 'list' },
  browser_session_restore:{ tool: 'browser_session', action: 'restore' },
  browser_session_delete: { tool: 'browser_session', action: 'delete' },
  browser_profile_info:   { tool: 'browser_profile', action: 'info' },
  browser_profile_set:    { tool: 'browser_profile', action: 'set' },
}

export async function executeBrowserOnly(name: string, args: any): Promise<any> {
  try {
    const alias = LEGACY_ALIASES[name]
    if (alias) {
      return await HANDLERS[alias.tool]({ ...(args || {}), action: alias.action })
    }
    const handler = HANDLERS[name]
    if (!handler) throw new Error(`Unknown browser tool: ${name}`)
    return await handler(args || {})
  } catch (err: any) {
    if (args?.trace || args?.return_error) {
      return { success: false, error: normalizeToolError(err, name, args) }
    }
    throw err
  }
}
