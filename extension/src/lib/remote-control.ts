// remote-control.ts — desktop-style live control of a browser tab (service-worker side).
//
// The browser extension can't capture a tab without a user gesture via
// tabCapture, and a service worker can't run WebRTC. So this splits the job:
//
//   • Video  — captured here with the DevTools protocol (chrome.debugger
//     `Page.startScreencast`), which needs no gesture and works unattended. JPEG
//     frames are forwarded to the offscreen document, drawn onto a canvas and
//     turned into a real WebRTC video track there — so the web side reuses the
//     exact <video> path the desktop/android agents use.
//   • Input  — pointer / keyboard events arrive from the operator over the P2P
//     control DataChannel (via the offscreen doc) and are injected back into the
//     tab with `Input.*` CDP commands. Chinese / IME text uses `Input.insertText`.
//
// Signaling crosses the server over the existing agent socket; the media and
// input stay peer-to-peer. The offscreen document hosts the RTCPeerConnection
// (offerer); this module bridges socket ⇄ offscreen ⇄ CDP.

type SignalSender = (event: string, payload: any) => void

interface ScreencastMetadata {
  deviceWidth: number
  deviceHeight: number
}

interface RcSession {
  sessionId: string
  tabId: number
  windowId: number
  send: SignalSender
  metadata: ScreencastMetadata | null
  buttons: number // pressed-button bitmask for drag moves
  // Whether the CDP debugger is currently attached + screencasting this tab.
  // false on restricted pages (chrome://, web store, …) where attach is refused —
  // the session stays alive (so the address bar / tab strip keep working) and
  // auto-recovers once the tab navigates back to a controllable http/https page.
  attached: boolean
  attaching: boolean // re-entrancy guard for startCapture
}

// Pages the extension's debugger cannot attach to / screencast. Navigating *to*
// one is allowed (chrome.tabs.update), it just can't be live-controlled — so we
// keep the session and let the operator type a new URL to leave.
function isControllableUrl(url?: string): boolean {
  const raw = String(url || '')
  if (!raw) return false
  if (/^(chrome|edge|brave|vivaldi|opera|about|chrome-extension|devtools|view-source):/i.test(raw)) return false
  if (/^https:\/\/chromewebstore\.google\.com\//i.test(raw)) return false
  return true
}

const sessions = new Map<string, RcSession>()
let listenersBound = false

// Capture near the viewport's native size (large caps avoid downscaling on
// 1080p+/HiDPI screens, which is the main source of blur) at high JPEG quality.
const FRAME_OPTS = { format: 'jpeg', quality: 85, maxWidth: 2560, maxHeight: 1440, everyNthFrame: 1 }

// ── CDP helpers ─────────────────────────────────────────────────────────────
function cdp(tabId: number, method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message)); else resolve(res)
    })
  })
}

function attach(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError
      // "Already attached" is fine — reuse the existing session.
      if (err && !/already attached/i.test(err.message)) reject(new Error(err.message))
      else resolve()
    })
  })
}

// Tabs we are detaching on purpose (tab switch, session end, partial-attach
// cleanup). The onDetach listener consults this so a *self*-initiated detach is
// never mistaken for an external one (devtools takeover / forced restricted-page
// detach), which would otherwise tear the session down.
const selfDetaching = new Set<number>()

function detach(tabId: number): void {
  selfDetaching.add(tabId)
  try {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError
      // If the tab wasn't attached, no onDetach fires — drop the guard next tick
      // so a later genuine external detach isn't wrongly ignored.
      setTimeout(() => selfDetaching.delete(tabId), 0)
    })
  } catch { selfDetaching.delete(tabId) }
}

// Attach the debugger and start the JPEG screencast for the session's current
// tab. On a restricted page (or any attach failure) it leaves attached=false and
// resolves false instead of throwing — the caller keeps the session alive so the
// operator can still drive the tab strip / address bar and navigate away.
async function startCapture(session: RcSession): Promise<boolean> {
  const tabId = session.tabId
  if (session.attaching || session.attached) return session.attached
  let tab: chrome.tabs.Tab
  try { tab = await chrome.tabs.get(tabId) } catch { return false }
  if (!isControllableUrl(tab.url)) {
    session.attached = false
    return false
  }
  session.attaching = true
  try {
    await attach(tabId)
    await cdp(tabId, 'Page.enable')
    await cdp(tabId, 'Page.startScreencast', FRAME_OPTS)
    session.attached = true
    return true
  } catch {
    session.attached = false
    detach(tabId) // clean up a half-open attach without killing the session
    return false
  } finally {
    session.attaching = false
  }
}

function findSessionByTab(tabId: number): RcSession | undefined {
  for (const s of sessions.values()) if (s.tabId === tabId) return s
  return undefined
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tabs[0] ?? null
}

// ── offscreen messaging ─────────────────────────────────────────────────────
function toOffscreen(event: string, payload: any): void {
  chrome.runtime.sendMessage({ rc: true, dir: 'to-offscreen', event, ...payload }).catch(() => {})
}

// ── lifecycle ───────────────────────────────────────────────────────────────
/** Register the debugger event + detach listeners once. */
export function initRemoteControl(): void {
  if (listenersBound) return
  listenersBound = true

  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    if (method !== 'Page.screencastFrame' || source.tabId == null) return
    const session = findSessionByTab(source.tabId)
    if (!session) return
    // Must ack or Chrome stops sending frames after a few.
    cdp(source.tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
    if (params.metadata) {
      session.metadata = { deviceWidth: params.metadata.deviceWidth, deviceHeight: params.metadata.deviceHeight }
    }
    toOffscreen('frame', { sessionId: session.sessionId, dataUrl: `data:image/jpeg;base64,${params.data}` })
  })

  // Debugger detach handling. A self-initiated detach (tab switch / cleanup) is
  // ignored. An external one is either: the tab closed → end; the tab navigated
  // to a restricted page (Chrome force-detaches) → keep the session alive and let
  // recovery re-attach once it leaves; or a real external takeover (devtools) on
  // a still-controllable tab → end.
  chrome.debugger.onDetach.addListener((source) => {
    const tabId = source.tabId
    if (tabId == null) return
    if (selfDetaching.delete(tabId)) return
    const session = findSessionByTab(tabId)
    if (!session) return
    session.attached = false
    chrome.tabs.get(tabId).then((tab) => {
      if (isControllableUrl(tab.url)) {
        // Still a normal page but our debugger was evicted (devtools / user) — end.
        endSession(session.sessionId, 'debugger_detached', true)
      } else {
        // Forced detach by a restricted navigation: keep the session so the
        // address bar still works; recovery re-attaches when it navigates back.
        void broadcastBrowserState(session)
      }
    }).catch(() => endSession(session.sessionId, 'tab_closed', true))
  })

  // Keep the operator's Edge-style tab strip / address bar live, and auto-recover
  // capture: any tab change re-broadcasts state and, for a session whose tab is
  // not currently captured (e.g. it just navigated off a chrome:// page), retries
  // attaching so the live stream resumes without operator action.
  const onTabsChanged = () => {
    for (const s of sessions.values()) {
      void broadcastBrowserState(s)
      if (!s.attached && !s.attaching) void startCapture(s).then((ok) => { if (ok) void broadcastBrowserState(s) })
    }
  }
  chrome.tabs.onUpdated.addListener(onTabsChanged)
  chrome.tabs.onActivated.addListener(onTabsChanged)
  chrome.tabs.onCreated.addListener(onTabsChanged)
  chrome.tabs.onRemoved.addListener(onTabsChanged)
  chrome.tabs.onMoved.addListener(onTabsChanged)
}

/** Socket → here: one inbound signaling message from the controller. */
export async function handleRcSocketSignal(event: string, data: any, send: SignalSender): Promise<void> {
  const sessionId = String(data?.sessionId || '')
  if (!sessionId) return

  if (event === 'rc:start') {
    const tab = await activeTab()
    if (!tab || tab.id == null) {
      send('rc:error', { sessionId, code: 'no_tab', message: '没有可控制的活动标签页' })
      return
    }
    const tabId = tab.id
    try {
      initRemoteControl()
      const session: RcSession = {
        sessionId, tabId, windowId: tab.windowId, send,
        metadata: null, buttons: 0, attached: false, attaching: false,
      }
      sessions.set(sessionId, session)
      // Start the peer regardless of controllability: even if the active tab is a
      // restricted page, the operator still gets an interactive surface (tab strip
      // + address bar) and can navigate to a normal page, which auto-attaches.
      toOffscreen('peer-start', { sessionId })
      await startCapture(session)
      void broadcastBrowserState(session)
    } catch (err: any) {
      detach(tabId)
      sessions.delete(sessionId)
      send('rc:error', { sessionId, code: 'attach_failed', message: err?.message || '无法附加到标签页（请关闭该标签的开发者工具后重试）' })
    }
    return
  }

  // rc:answer / rc:ice → hand to the offscreen peer.
  if (event === 'rc:answer') toOffscreen('answer', { sessionId, sdp: data.sdp })
  else if (event === 'rc:ice') toOffscreen('ice', { sessionId, candidate: data.candidate })
  else if (event === 'rc:stop') endSession(sessionId, 'operator_stop', false)
}

/** Offscreen → here: signaling to relay to the controller, or an input event. */
export function handleOffscreenRcMessage(msg: any, send: SignalSender): void {
  const sessionId = String(msg?.sessionId || '')
  const session = sessions.get(sessionId)
  switch (msg?.event) {
    case 'offer': send('rc:offer', { sessionId, sdp: msg.sdp }); break
    case 'ice': send('rc:ice', { sessionId, candidate: msg.candidate }); break
    case 'ready': send('rc:ready', { sessionId, width: msg.width, height: msg.height, rotation: 0 }); break
    case 'error': send('rc:error', { sessionId, code: msg.code || 'peer_error', message: msg.message || '' }); endSession(sessionId, 'peer_error', false); break
    case 'stopped': endSession(sessionId, 'peer_stopped', false); send('rc:stopped', { sessionId }); break
    case 'control-msg':
      if (!session) break
      // One P2P channel carries both pointer/keyboard input and Edge-style
      // browser commands; the `kind` field disambiguates.
      if (msg.msg?.kind === 'browser') void handleBrowserCommand(session, msg.msg)
      else void dispatchInput(session, msg.msg)
      break
  }
}

export function stopAllRemoteControl(): void {
  for (const sessionId of [...sessions.keys()]) endSession(sessionId, 'agent_disconnected', true)
}

function endSession(sessionId: string, reason: string, notifyPeer: boolean): void {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  if (session.attached) cdp(session.tabId, 'Page.stopScreencast').catch(() => {})
  detach(session.tabId)
  toOffscreen('peer-stop', { sessionId })
  if (notifyPeer) session.send('rc:stopped', { sessionId, reason })
}

// ── CDP input injection ───────────────────────────────────────────────────────
const BUTTON_BIT: Record<string, number> = { left: 1, right: 2, middle: 4 }

async function dispatchInput(session: RcSession, input: any): Promise<void> {
  const md = session.metadata
  if (!md) return
  const tabId = session.tabId
  const x = Math.round((Number(input?.x) || 0) * md.deviceWidth)
  const y = Math.round((Number(input?.y) || 0) * md.deviceHeight)
  const button = (input?.button === 'right' || input?.button === 'middle') ? input.button : 'left'
  try {
    switch (input?.type) {
      case 'move':
        await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: session.buttons })
        break
      case 'down':
        session.buttons |= BUTTON_BIT[button] || 1
        await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: session.buttons, clickCount: 1 })
        break
      case 'up':
        await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: session.buttons, clickCount: 1 })
        session.buttons &= ~(BUTTON_BIT[button] || 1)
        break
      case 'scroll':
        await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: Number(input?.dx) || 0, deltaY: Number(input?.dy) || 0 })
        break
      case 'text':
        if (input?.text) await cdp(tabId, 'Input.insertText', { text: String(input.text) })
        break
      case 'key':
        await dispatchKey(tabId, input)
        break
    }
  } catch { /* a transient CDP failure must not kill the session */ }
}

// Browser-key → CDP key event. Printable single chars type via `text`; named keys
// carry the virtual-key code CDP needs. Modifiers ride the bitmask, so standalone
// modifier presses are skipped (the operator's combo state is already on the key).
const NAMED_KEYS: Record<string, { code: string; vk: number }> = {
  Enter: { code: 'Enter', vk: 13 }, Tab: { code: 'Tab', vk: 9 }, Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 }, Escape: { code: 'Escape', vk: 27 },
  ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 }, End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 }, PageDown: { code: 'PageDown', vk: 34 },
}
const MODIFIER_ONLY = new Set(['Control', 'Alt', 'Shift', 'Meta'])

async function dispatchKey(tabId: number, input: any): Promise<void> {
  const key = String(input?.key || '')
  if (!key || MODIFIER_ONLY.has(key)) return
  let modifiers = 0
  if (input?.alt) modifiers |= 1
  if (input?.ctrl) modifiers |= 2
  if (input?.meta) modifiers |= 4
  if (input?.shift) modifiers |= 8
  const type = input?.action === 'up' ? 'keyUp' : 'keyDown'
  const named = NAMED_KEYS[key]
  const params: any = { type, modifiers, key }
  if (named) {
    params.code = named.code
    params.windowsVirtualKeyCode = named.vk
    params.nativeVirtualKeyCode = named.vk
  } else if (key.length === 1) {
    // Printable: emit the character on keyDown (only when no Ctrl/Alt/Meta combo).
    if (type === 'keyDown' && !input?.ctrl && !input?.alt && !input?.meta) {
      params.text = key
      params.unmodifiedText = key
    }
  }
  await cdp(tabId, 'Input.dispatchKeyEvent', params)
}

// ── Browser chrome (Edge-style tab strip + address bar) ────────────────────────
async function broadcastBrowserState(session: RcSession): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ windowId: session.windowId })
    const captured = tabs.find(t => t.id === session.tabId)
    const state = {
      activeTabId: session.tabId,
      // false on a restricted page (chrome://, web store, …): the live screen is
      // frozen and pointer/keyboard do nothing, but the address bar still works.
      // The web UI uses this to show a hint instead of looking broken.
      controllable: isControllableUrl(captured?.url),
      tabs: tabs.map(t => ({
        id: t.id,
        title: t.title || t.url || '新标签页',
        url: t.url || '',
        favIconUrl: t.favIconUrl || '',
        active: t.id === session.tabId,
      })),
    }
    toOffscreen('browser-state', { sessionId: session.sessionId, state })
  } catch { /* tab query can race a closing window — ignore */ }
}

/** Normalize an address-bar entry: full URL kept as-is, a bare host gets https,
 *  anything else becomes a search (Edge defaults to Bing). */
function normalizeAddress(input: string): string {
  const value = String(input || '').trim()
  if (!value) return 'about:blank'
  if (/^[a-z]+:\/\//i.test(value) || value.startsWith('about:') || value.startsWith('chrome:')) return value
  if (!/\s/.test(value) && /\.[a-z]{2,}$/i.test(value.split('/')[0])) return `https://${value}`
  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`
}

async function switchCaptureTab(session: RcSession, newTabId: number): Promise<void> {
  if (session.tabId === newTabId) {
    await chrome.tabs.update(newTabId, { active: true }).catch(() => {})
    if (!session.attached) await startCapture(session)
    void broadcastBrowserState(session)
    return
  }
  if (session.attached) {
    try { await cdp(session.tabId, 'Page.stopScreencast') } catch { /* noop */ }
    detach(session.tabId)
  }
  session.tabId = newTabId
  session.metadata = null
  session.buttons = 0
  session.attached = false
  await chrome.tabs.update(newTabId, { active: true }).catch(() => {})
  // Restricted target → stays attached:false (no fatal error); the operator can
  // still see the tab strip + address bar and navigate away to resume control.
  await startCapture(session)
  void broadcastBrowserState(session)
}

async function handleBrowserCommand(session: RcSession, cmd: any): Promise<void> {
  const tabId = session.tabId
  try {
    switch (cmd?.action) {
      case 'back': await chrome.tabs.goBack(tabId); break
      case 'forward': await chrome.tabs.goForward(tabId); break
      case 'reload': await chrome.tabs.reload(tabId); break
      case 'navigate':
        await chrome.tabs.update(tabId, { url: normalizeAddress(cmd.url) })
        break
      case 'new-tab': {
        const created = await chrome.tabs.create({
          windowId: session.windowId,
          url: cmd.url ? normalizeAddress(cmd.url) : undefined,
        })
        if (created.id != null) await switchCaptureTab(session, created.id)
        break
      }
      case 'switch-tab':
        if (typeof cmd.tabId === 'number') await switchCaptureTab(session, cmd.tabId)
        break
      case 'close-tab':
        if (typeof cmd.tabId === 'number') {
          const closingCaptured = cmd.tabId === session.tabId
          await chrome.tabs.remove(cmd.tabId)
          if (closingCaptured) {
            const rest = await chrome.tabs.query({ windowId: session.windowId })
            const next = rest.find(t => t.id != null)
            if (next?.id != null) await switchCaptureTab(session, next.id)
          }
        }
        break
    }
  } catch { /* a failed nav command must not kill the session */ }
  void broadcastBrowserState(session)
}
