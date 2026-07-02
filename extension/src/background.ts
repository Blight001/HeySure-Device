// background.ts — HeySure Agent service worker
// Manages: Socket.IO server connection, task dispatching, popup port communication
import { io, Socket } from 'socket.io-client'
import { getSettings, saveSettings, pushActivity, getActivity, getAuth } from './lib/storage'
import { getAgentEndpoint } from './lib/client'
import { executeTask, executeBrowserTool, effectiveToolDefs } from './lib/tools'
import { clearToolDescOverrides } from './lib/storage'
import { applyServerDynamicMcp, clearServerDynamicMcp, DYNAMIC_MCP_STORAGE_KEY } from './lib/tools/dynamic'
import { initRemoteControl, handleRcSocketSignal, handleOffscreenRcMessage, stopAllRemoteControl } from './lib/remote-control'
import { callAI } from './lib/ai'
import { screenshotToolContent } from './lib/ai'
import {
  DeviceStatus, DispatchedTask, ActivityEntry,
  PopupMsg, BgMsg, ChatMessage, ChatToolEvent, AIToolDef, OfflineChatToolEvent,
} from './lib/types'

// ── State ─────────────────────────────────────────────────────────────────
let socket:        Socket | null = null
let currentStatus: DeviceStatus   = 'disconnected'
const taskOutcomes = new Map<string, any>()
const popupPorts   = new Set<chrome.runtime.Port>()
const offlineChatControllers = new Map<string, { canceled: boolean }>()
let _machineId:    string | null = null
let currentAgentId: string | null = null
// In-flight connect() promise. A single login fires BOTH the auth-storage
// watcher and the popup's device:connect message; sharing one promise stops
// each from opening its own socket and tearing the other down mid-handshake.
let connectPromise: Promise<void> | null = null
// Set when the server rejected registration for a non-transient reason
// (expired/invalid token or AI-ownership mismatch). Retrying with the same
// token just loops forever, so we stop auto-reconnect and the keepalive
// alarm until the user re-authenticates or explicitly reconnects. Cleared
// at the start of connect() and on logout.
let authRejected = false

async function withTaskTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

function taskTimeoutMs(task: DispatchedTask) {
  const fromArgs = Number(task.args?.task_timeout_ms || task.args?.timeout_seconds && Number(task.args.timeout_seconds) * 1000)
  if (Number.isFinite(fromArgs) && fromArgs > 0) return Math.min(110000, Math.max(5000, Math.round(fromArgs)))
  if (task.tool === 'browser_screenshot') return 35000
  return 90000
}

// ── Task outcome cache ────────────────────────────────────────────────────
// Completed outcomes are kept so a server re-dispatch of the same taskId gets
// the cached answer, and so results produced while the socket was down or
// being replaced can be re-sent on the next connect (see flushUnsentTaskOutcomes).
const MAX_TASK_OUTCOMES = 100

function rememberTaskOutcome(taskId: string, outcome: any) {
  taskOutcomes.delete(taskId)
  taskOutcomes.set(taskId, outcome)
  for (const key of taskOutcomes.keys()) {
    if (taskOutcomes.size <= MAX_TASK_OUTCOMES) break
    if (taskOutcomes.get(key)?.kind === 'running') continue
    taskOutcomes.delete(key)
  }
}

// Send a finished outcome to the server, or mark it unsent when the socket is
// down — emitting into a disconnected socket's buffer would double-send after
// reconnect (buffer flush + our own flush), so we bypass the buffer entirely.
function emitTaskOutcome(taskId: string, outcome: any) {
  if (!socket?.connected) {
    outcome.unsent = true
    return
  }
  if (outcome.kind === 'result') socket.emit('task:result', outcome.payload)
  else if (outcome.kind === 'error') socket.emit('task:error', { taskId, userId: outcome.userId, error: outcome.error })
  outcome.unsent = false
}

// Re-deliver outcomes that never reached the server (socket torn down or
// replaced at completion time). The server keeps the dispatch row and accepts
// a late reply even after its waiter timed out, so this recovers the result
// instead of leaving the operator with a bare timeout.
function flushUnsentTaskOutcomes() {
  if (!socket?.connected) return
  for (const [taskId, outcome] of taskOutcomes) {
    if (outcome?.unsent) emitTaskOutcome(taskId, outcome)
  }
}

// ── Activity logging ──────────────────────────────────────────────────────
function mkEntry(type: string, status: string, message: string, data?: any): ActivityEntry {
  return { id: Math.random().toString(36).slice(2), type, status, message, data, timestamp: Date.now() }
}

function log(type: string, status: string, message: string, data?: any) {
  const entry = mkEntry(type, status, message, data)
  void pushActivity(entry)
  broadcast({ type: 'activity:log', entry })
}

function refreshPopupStatus() {
  broadcast({ type: 'device:status', status: currentStatus, aiConfigId: boundAiConfigId })
}

// Server-side bound AI for this device, learned from device:registered. null =
// none assigned yet → the popup status indicator shows yellow instead of green.
let boundAiConfigId: number | null = null

// ── Status management ─────────────────────────────────────────────────────
function setStatus(status: DeviceStatus, reason?: string) {
  currentStatus = status
  if (status !== 'registered' && status !== 'connected') boundAiConfigId = null
  broadcast({ type: 'device:status', status, reason, aiConfigId: boundAiConfigId })
  const colors: Record<DeviceStatus, string> = {
    disconnected: '#787878', connecting: '#f59e0b',
    connected: '#6366f1',    registered: '#22c55e',  error: '#ef4444',
  }
  chrome.action.setBadgeBackgroundColor({ color: colors[status] })
  chrome.action.setBadgeText({ text: status === 'registered' ? '●' : status === 'error' ? '!' : '' })
  chrome.action.setTitle({ title: `HeySure Agent — ${status}` })
}

// ── Popup broadcast ───────────────────────────────────────────────────────
function postToPopup(port: chrome.runtime.Port, msg: BgMsg): boolean {
  try {
    port.postMessage(msg)
    return true
  } catch {
    popupPorts.delete(port)
    return false
  }
}

function broadcast(msg: BgMsg) {
  popupPorts.forEach(port => {
    postToPopup(port, msg)
  })
}

// Emit a remote-control signaling message on the live agent socket. Reads the
// module socket at call time so it survives reconnects.
function rcSend(event: string, payload: any) {
  socket?.emit(event, payload)
}

// ── Machine ID ────────────────────────────────────────────────────────────
async function getMachineId(): Promise<string> {
  if (_machineId) return _machineId
  const r = await chrome.storage.local.get('_mid')
  if (r._mid) { _machineId = r._mid; return _machineId! }
  const id = 'br-' + Math.random().toString(36).slice(2, 10)
  await chrome.storage.local.set({ _mid: id })
  _machineId = id
  return id
}

function parseAiConfigId(raw: any): number | null {
  const n = typeof raw === 'number' ? raw : (raw != null && String(raw).trim() !== '' ? Number(raw) : null)
  return Number.isFinite(n as number) ? (n as number) : null
}

async function emitRegisterOn(s: Socket): Promise<void> {
  const settings = await getSettings()
  const auth = await getAuth()
  if (settings.offlineMode) return
  const id = settings.deviceId || await getMachineId()
  currentAgentId = id
  // The extension no longer picks its own AI — it logs in and connects, then an
  // operator assigns a server-side AI to this device from the web Workshop
  // ("作坊") panel. The server re-applies that binding on every register, so we
  // always send aiConfigId: null.
  // Only the tools the user has enabled in the popup are reported. Capabilities
  // are derived from the same enabled toolDefs so the two never drift — disabled
  // (e.g. unchecked 特殊类) tools are withheld from the server entirely.
  const toolDefs = await effectiveToolDefs()
  s.emit('device:register', {
    id,
    aiConfigId: null,
    name:            settings.agentName || 'Browser Agent',
    group:           settings.agentGroup || '',
    platform:        `browser-extension (${navigator?.userAgent?.split(' ').pop() || 'chrome'})`,
    os:              { platform: 'browser', arch: 'unknown', release: '1.0', hostname: id },
    // Advertise remote_control alongside the tool names so the server gates live
    // screen control on it (mirrors remote_control.RC_CAPABILITY server-side).
    capabilities:    [...toolDefs.map(t => t.name), 'remote_control'],
    // Full self-described tool schemas (with the user's local description edits
    // merged in). The server stores these and surfaces them in mcp.list_tools /
    // describe_tool instead of hardcoding browser tool schemas, so a tool added
    // here — or a description edited in the popup — needs no server change.
    toolDefs,
    version:         '1.0.0',
    token:           auth.token || settings.agentToken || '',
    userId:          auth.userId ?? null,
    workspaceRoot:   '',
    lifecycle:       'registered',
    isWindowsDesktop: false,
    isBrowserExtension: true,
  })
}

// ── Connect ───────────────────────────────────────────────────────────────
async function connect(): Promise<void> {
  // Serialize concurrent callers. A single login fires both the auth-storage
  // watcher and the popup's device:connect message; returning the in-flight
  // promise ensures only one socket is ever opened per connect cycle.
  if (socket?.connected) return
  if (connectPromise) return connectPromise
  connectPromise = doConnect().finally(() => { connectPromise = null })
  return connectPromise
}

async function doConnect(): Promise<void> {
  const settings = await getSettings()
  if (socket?.connected) return
  if (settings.offlineMode) {
    log('system', 'info', '离线模式已开启，跳过服务器连接')
    return
  }

  // Hard gate: an unauthenticated agent is rejected at device:register
  // anyway. Refusing to even open the socket prevents the UI from
  // flashing "已连接" before the server rejects.
  const auth = await getAuth()
  if (!auth.token) {
    setStatus('disconnected')
    log('system', 'warn', '未登录，已阻止连接服务器（请先登录账号）')
    return
  }

  let agentSocketUrl = String(settings.agentSocketUrl || '').trim()
  if (!agentSocketUrl) {
    try {
      agentSocketUrl = await getAgentEndpoint(settings.serverUrl, auth.token)
      await saveSettings({ agentSocketUrl })
    } catch (err: any) {
      setStatus('error', '无法获取 Agent 连接地址')
      log('system', 'error', `无法获取 Agent 连接地址: ${err?.message || err}`)
      return
    }
  }

  try { agentSocketUrl = new URL(agentSocketUrl).href.replace(/\/$/, '') } catch {
    log('system', 'error', 'Agent 连接地址格式无效')
    return
  }

  if (socket) {
    socket.removeAllListeners()
    socket.disconnect()
    socket = null
  }

  authRejected = false
  setStatus('connecting')

  log('system', 'info', `正在连接 Agent 服务器: ${agentSocketUrl}`)
  socket = io(agentSocketUrl, {
    transports: ['websocket', 'polling'],
    reconnectionDelay: 2000,
    reconnectionAttempts: Infinity,
  })
  attachOperationalListeners(socket, settings.agentName || 'Browser Agent')
}

function attachOperationalListeners(s: Socket, agentName: string) {
  s.on('connect', async () => {
    setStatus('connected')
    log('system', 'info', '已连接到服务器')
    // Re-register after auto-reconnect with the freshest aiConfigId.
    await register()
    // Re-deliver any task results that finished while the socket was down —
    // otherwise the server-side dispatch only ever sees a timeout.
    flushUnsentTaskOutcomes()
  })

  s.on('disconnect', (reason: string) => {
    void clearServerSyncedTools()
    setStatus('disconnected', reason)
    log('system', 'warn', `连接断开: ${reason}`)
    // Socket.IO auto-reconnects for transport-level drops, but NOT when the
    // server explicitly closes us (reason 'io server disconnect') — which a
    // server restart can produce. Nudge a reconnect ourselves unless the
    // disconnect was intentional ('io client disconnect' from logout/disconnect)
    // or registration was rejected. The keepalive alarm is the slower backstop
    // if the worker is asleep when this fires.
    if (reason === 'io server disconnect' && !authRejected) {
      setTimeout(() => { if (socket && !socket.connected && !socket.active) socket.connect() }, 2000)
    }
  })

  s.on('connect_error', (err: Error) => {
    setStatus('error', err.message)
    log('system', 'error', `连接失败: ${err.message}`)
  })

  s.on('device:registered', (data: any) => {
    const raw = data?.aiConfigId
    const parsed = typeof raw === 'number' ? raw : (raw != null && String(raw).trim() !== '' ? Number(raw) : null)
    boundAiConfigId = Number.isFinite(parsed as number) ? (parsed as number) : null
    setStatus('registered')
    log('system', 'success', `已注册: ${data?.name || agentName}${boundAiConfigId == null ? '（未分配 AI）' : ''}`)
  })

  s.on('device:list', (rows: any[]) => {
    if (!currentAgentId || !Array.isArray(rows)) return
    const mine = rows.find(row => String(row?.id || '') === currentAgentId)
    if (!mine) return
    const raw = mine?.aiConfigId ?? mine?.ai_config_id
    const parsed = typeof raw === 'number' ? raw : (raw != null && String(raw).trim() !== '' ? Number(raw) : null)
    const nextAiConfigId = Number.isFinite(parsed as number) ? (parsed as number) : null
    if (nextAiConfigId !== boundAiConfigId) {
      boundAiConfigId = nextAiConfigId
      refreshPopupStatus()
      log('system', 'info', `AI 绑定已更新: ${boundAiConfigId == null ? '未分配' : `#${boundAiConfigId}`}`)
    }
  })

  s.on('device:register_rejected', (data: any) => {
    const reason = data?.reason || '注册被服务器拒绝'
    // Non-transient: the token is invalid/expired or the AI no longer
    // belongs to this user. Reconnecting and re-registering with the same
    // token would loop forever (reconnectionAttempts is Infinity), so we
    // latch authRejected, disable reconnection and tear the socket down.
    // The user must re-login (or pick a valid AI) and connect again.
    authRejected = true
    try { s.io.reconnection(false) } catch { /* noop */ }
    disconnect()
    setStatus('error', reason)
    log('system', 'error', `注册被拒绝，已停止自动重连（请重新登录后再连接）: ${reason}`)
  })

  s.on('task:dispatch', (task: DispatchedTask) => { void handleTask(task) })

  // Remote control (WebRTC signaling). Video is CDP-screencast + input is CDP
  // injection (lib/remote-control.ts); the media/input ride a P2P link hosted in
  // the offscreen doc, so only these SDP/ICE messages cross the socket.
  initRemoteControl()
  for (const ev of ['rc:start', 'rc:answer', 'rc:ice', 'rc:stop']) {
    s.on(ev, (data: any) => { void handleRcSocketSignal(ev, data, rcSend) })
  }

  // Web-authored dynamic MCP tools for this (browser) device type, pushed by the
  // server on register and on every operator edit. Held in memory only; cleared
  // on disconnect so tools never outlive the server session.
  s.on('device:tool-config', (payload: any) => {
    void (async () => {
      try {
        const status = await applyServerDynamicMcp(payload)
        if (status.applied) {
          const names = Array.isArray(payload?.tools)
            ? payload.tools.map((t: any) => String(t?.name || '').trim()).filter(Boolean)
            : []
          if (names.length) await clearToolDescOverrides(names)
          log('system', 'info', `已应用服务器下发的 MCP 工具：${status.tools} 个`)
          if (socket?.connected) await register()
        }
      } catch (err: any) {
        log('system', 'error', `应用服务器 MCP 工具失败: ${err?.message || err}`)
      }
    })()
  })
}

async function register() {
  const settings = await getSettings()
  if (settings.offlineMode) {
    log('system', 'info', '离线模式已开启，跳过注册')
    return
  }
  if (!socket) return
  log('system', 'info', '注册 agent（AI 由服务器作坊分配）')
  await emitRegisterOn(socket)
}

function disconnect() {
  stopAllRemoteControl()
  socket?.disconnect()
  socket = null
  void clearServerSyncedTools()
  setStatus('disconnected')
}

async function clearServerSyncedTools(): Promise<void> {
  const status = await clearServerDynamicMcp()
  if (!status.cleared) return
  log('system', 'info', '已清空服务器下发的 MCP 工具（等待重新同步）')
  if (socket?.connected) await register()
}

async function restoreAndConnectOnStartup() {
  const s = await getSettings()
  const auth = await getAuth()
  // Logged-in + online → link to the server automatically so the device shows
  // up in the Workshop panel ready to be assigned an AI.
  if (!s.offlineMode && auth.token) await connect()
}

// ── Offscreen keepalive ─────────────────────────────────────────────────────
// An offscreen document isn't reclaimed for inactivity (the service worker is),
// so it acts as an external pacemaker: it pings us every ~20s, and each ping is
// an event that resets the worker's idle timer / wakes it. That keeps the socket
// alive while the browser is minimized. See src/offscreen.ts. The socket stays
// in the worker because offscreen docs can't touch chrome.tabs/debugger.
let ensureOffscreenPromise: Promise<void> | null = null
async function ensureOffscreen(): Promise<void> {
  if (ensureOffscreenPromise) return ensureOffscreenPromise
  ensureOffscreenPromise = (async () => {
    try {
      if (await chrome.offscreen.hasDocument()) return
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        // WORKERS: keepalive heartbeat. WEB_RTC: host the remote-control peer
        // connection (a service worker can't run RTCPeerConnection).
        reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.WEB_RTC],
        justification: '保持后台连接，并承载远程控制的 WebRTC 连接（Service Worker 无法运行 RTCPeerConnection）。',
      })
    } catch {
      // createDocument throws if one already exists (lost a race) — that's the
      // desired end state, so ignore.
    }
  })().finally(() => { ensureOffscreenPromise = null })
  return ensureOffscreenPromise
}

// ── Task handling ─────────────────────────────────────────────────────────
async function handleTask(task: DispatchedTask) {
  const taskId = task.taskId
  if (!taskId) return

  const cached = taskOutcomes.get(taskId)
  if (cached) {
    if (cached.kind === 'result' || cached.kind === 'error') emitTaskOutcome(taskId, cached)
    return
  }

  taskOutcomes.set(taskId, { kind: 'running' })
  const tool = task.tool || '(infer)'
  log('task', 'running', `[工具] ${tool}`, task.args)
  broadcast({ type: 'task:start', data: { taskId, tool, args: task.args, timestamp: Date.now() } })
  socket?.emit('task:progress', { taskId, progress: 0, message: `执行 ${tool}...` })

  try {
    const settings = await getSettings()
    const timeoutMs = taskTimeoutMs(task)
    const outcome  = await withTaskTimeout(executeTask(task, settings), timeoutMs, `Endpoint task ${tool}`)
    const payload  = {
      taskId,
      userId:      task.userId,
      aiConfigId:  task.aiConfigId,
      sessionId:   task.sessionId,
      tool:        outcome.tool,
      success:     outcome.success,
      result:      outcome.result,
      summary:     outcome.summary,
    }
    const entry = { kind: 'result', payload }
    rememberTaskOutcome(taskId, entry)
    emitTaskOutcome(taskId, entry)
    log('task', outcome.success ? 'success' : 'error', `${outcome.success ? '完成' : '失败'}: ${outcome.tool}`, outcome.result)
    broadcast({ type: 'task:result', data: { taskId, tool: outcome.tool, result: outcome.result, success: outcome.success, timestamp: Date.now() } })
  } catch (err: any) {
    const errMsg = err?.message || String(err)
    const entry = { kind: 'error', error: errMsg, userId: task.userId }
    rememberTaskOutcome(taskId, entry)
    emitTaskOutcome(taskId, entry)
    log('task', 'error', `异常: ${tool} — ${errMsg}`)
    broadcast({ type: 'task:result', data: { taskId, tool, result: null, success: false, timestamp: Date.now() } })
  }
}

// ── Connection test ───────────────────────────────────────────────────────
async function testConnection(): Promise<any> {
  const settings = await getSettings()
  if (!settings.serverUrl) return { success: false, error: '未配置服务器 URL' }
  let url: URL
  try { url = new URL(settings.serverUrl) } catch { return { success: false, error: 'URL 格式无效' } }
  const base = url.href.replace(/\/$/, '')
  let httpResult: any = null
  try {
    const start = Date.now()
    const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) })
      .catch(() => fetch(base, { signal: AbortSignal.timeout(5000) }))
    httpResult = { success: true, status: res.status, ms: Date.now() - start }
  } catch (err: any) {
    httpResult = { success: false, error: err.message }
  }

  const auth = await getAuth()
  let agentSocketUrl = settings.agentSocketUrl || ''
  let endpointResult: any = null
  if (auth.token) {
    try {
      agentSocketUrl = await getAgentEndpoint(settings.serverUrl, auth.token)
      await saveSettings({ agentSocketUrl })
      endpointResult = { success: true, agentSocketUrl }
    } catch (err: any) {
      endpointResult = { success: false, error: err?.message || String(err) }
    }
  }

  return {
    success: httpResult.success,
    http: httpResult,
    agentSocketUrl,
    endpoint: endpointResult,
    needsLogin: !auth.token,
  }
}

// ── AI chat with agentic browser-tool loop ────────────────────────────────
const CHAT_SYSTEM = `You are HeySure AI, a browser automation assistant running as a Chrome extension.
You can navigate pages, click, double-click, right-click, type, drag, press keys, scroll, take
screenshots, extract data, and more.

Use browser_observe and browser_screenshot to understand the page; after scrolling, read the
position info returned by browser_action {action:"scroll"} so you know where you landed.

If a popup/modal/dialog blocks the page, re-observe to find its close button and click it, or
press Escape with browser_action {action:"press_key", key:"Escape"}.

When asked to complete tasks, use the available tools systematically and summarize what you did.
Respond in the same language as the user.`

async function runChat(messages: ChatMessage[]): Promise<{ text: string; toolsUsed: string[]; toolEvents: ChatToolEvent[] }> {
  const settings = await getSettings()
  if (!settings.aiKey) throw new Error('未配置 AI Key')

  const toolsUsed: string[] = []
  const toolEvents: ChatToolEvent[] = []
  let iter = 0
  const MAX = 12
  // Offline chat also respects the popup's tool selection: only enabled tools
  // (with local description edits applied) are offered to the model.
  const chatTools = await effectiveToolDefs()

  while (iter < MAX) {
    const resp = await callAI(settings.aiBaseUrl, settings.aiKey, settings.aiModel, messages, chatTools, CHAT_SYSTEM)

    if (!resp.toolUses?.length) {
      return { text: resp.text || '完成', toolsUsed, toolEvents }
    }

    messages.push({ role: 'assistant', content: resp.toolUses as any[] })

    const toolResults: any[] = []
    for (const tu of resp.toolUses) {
      toolsUsed.push(tu.name)
      log('task', 'running', `[AI工具] ${tu.name}`, tu.input)
      try {
        const result = await executeBrowserTool(tu.name, tu.input)
        let content: any = typeof result === 'string' ? result : JSON.stringify(result)
        if (tu.name === 'browser_screenshot' && result?.dataUrl) {
          content = screenshotToolContent(result)
          toolEvents.push({
            key: `${tu.id || tu.name}:${toolEvents.length}`,
            label: '浏览器截图',
            detail: [result.url, result.method].filter(Boolean).join('\n'),
            imageUrl: result.dataUrl,
          })
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content })
        log('task', 'success', `完成: ${tu.name}`)
      } catch (err: any) {
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true })
        log('task', 'error', `失败: ${tu.name} — ${err.message}`)
      }
    }
    messages.push({ role: 'user', content: toolResults })
    iter++
  }
  return { text: '已达到最大迭代次数', toolsUsed, toolEvents }
}

function estimateTokensFromMessages(messages: ChatMessage[], text = '') {
  const raw = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n') + text
  const total = Math.max(1, Math.ceil(raw.length / 4))
  return { inputTokens: total, outputTokens: Math.max(1, Math.ceil(String(text || '').length / 4)), totalTokens: total, estimated: true }
}

function summarizeToolResult(result: any, success: boolean): string {
  if (!success) return typeof result === 'string' ? result : '执行失败'
  if (result?.summary) return String(result.summary)
  if (result?.success === false && result?.error) return String(result.error)
  if (typeof result === 'string') return result.slice(0, 160)
  return '执行完成'
}

function resultForModel(tool: string, result: any): any {
  if (tool === 'browser_screenshot' && result?.dataUrl) return screenshotToolContent(result)
  return typeof result === 'string' ? result : JSON.stringify(result)
}

async function runOfflineChat(
  port: chrome.runtime.Port,
  requestId: string,
  messages: ChatMessage[],
  prompt?: string,
  allowedTools?: string[],
): Promise<{ text: string; toolsUsed: string[]; toolEvents: OfflineChatToolEvent[]; usage: ReturnType<typeof estimateTokensFromMessages> }> {
  const settings = await getSettings()
  if (!settings.aiKey) throw new Error('未配置 AI Key')
  if (!settings.aiBaseUrl) throw new Error('未配置 Base URL')
  if (!settings.aiModel) throw new Error('未配置模型')

  const controller = { canceled: false }
  offlineChatControllers.set(requestId, controller)
  const allowed = new Set((allowedTools || []).map(t => String(t || '').trim()).filter(Boolean))
  const allTools = await effectiveToolDefs()
  // `allowedTools` carries the per-conversation MCP scope chosen in the 本地对话
  // window. undefined → no scoping (all enabled tools); an array → exactly those,
  // so deselecting everything genuinely disables MCP instead of silently
  // re-enabling every tool.
  const chatTools = Array.isArray(allowedTools)
    ? allTools.filter(t => allowed.has(t.name))
    : allTools
  const systemPrompt = String(prompt || settings.offlinePrompt || '').trim()
  const toolsUsed: string[] = []
  const toolEvents: OfflineChatToolEvent[] = []
  const workingMessages = messages.map(m => ({ ...m }))
  const MAX = 12

  try {
    for (let iter = 0; iter < MAX; iter++) {
      if (controller.canceled) throw new DOMException('已停止', 'AbortError')
      const resp = await callAI(settings.aiBaseUrl, settings.aiKey, settings.aiModel, workingMessages, chatTools, systemPrompt)
      if (controller.canceled) throw new DOMException('已停止', 'AbortError')
      if (!resp.toolUses?.length) {
        const text = resp.text || '完成'
        return { text, toolsUsed, toolEvents, usage: estimateTokensFromMessages(workingMessages, text) }
      }

      workingMessages.push({ role: 'assistant', content: resp.toolUses as any[] })
      const toolResults: any[] = []
      for (const tu of resp.toolUses) {
        if (controller.canceled) throw new DOMException('已停止', 'AbortError')
        const args = tu.input || {}
        toolsUsed.push(tu.name)
        postToPopup(port, { type: 'offline-chat:progress', requestId, event: { type: 'tool_start', tool: tu.name, arguments: args } })
        log('task', 'running', `[本地对话工具] ${tu.name}`, args)
        try {
          const result = await withTaskTimeout(
            executeBrowserTool(tu.name, args),
            taskTimeoutMs({ taskId: requestId, tool: tu.name, args }),
            `offline-chat ${tu.name}`,
          )
          if (controller.canceled) throw new DOMException('已停止', 'AbortError')
          const event: OfflineChatToolEvent = {
            tool: tu.name,
            arguments: args,
            success: true,
            result,
            summary: summarizeToolResult(result, true),
          }
          toolEvents.push(event)
          postToPopup(port, { type: 'offline-chat:progress', requestId, event: { type: 'tool_result', event } })
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: resultForModel(tu.name, result) })
          log('task', 'success', `本地对话完成: ${tu.name}`)
        } catch (err: any) {
          const message = err?.message || String(err)
          const event: OfflineChatToolEvent = {
            tool: tu.name,
            arguments: args,
            success: false,
            result: null,
            summary: message,
          }
          toolEvents.push(event)
          postToPopup(port, { type: 'offline-chat:progress', requestId, event: { type: 'tool_result', event } })
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${message}`, is_error: true })
          log('task', 'error', `本地对话失败: ${tu.name} — ${message}`)
        }
      }
      workingMessages.push({ role: 'user', content: toolResults })
    }
    return { text: '已达到最大迭代次数', toolsUsed, toolEvents, usage: estimateTokensFromMessages(workingMessages, '已达到最大迭代次数') }
  } finally {
    offlineChatControllers.delete(requestId)
  }
}

// ── Popup port management ─────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup' && port.name !== 'offline-chat') return
  popupPorts.add(port)

  // Send current state immediately
  postToPopup(port, { type: 'device:status', status: currentStatus, aiConfigId: boundAiConfigId })
  getActivity().then(entries => {
    entries.forEach(e => postToPopup(port, { type: 'activity:log', entry: e }))
  })

  port.onDisconnect.addListener(() => popupPorts.delete(port))

  port.onMessage.addListener(async (msg: PopupMsg) => {
    switch (msg.type) {
      case 'device:connect':    {
        if (socket?.connected) await emitRegisterOn(socket)
        else await connect()
        break
      }
      case 'device:disconnect': { disconnect();    break }
      case 'auth:logout': {
        // Drop the socket entirely so the server sees us leaving and we
        // don't keep re-registering with an empty/stale token.
        authRejected = false
        disconnect()
        await saveSettings({ selectedAiConfigId: null, agentSocketUrl: '' })
        break
      }

      case 'settings:get': {
        const settings = await getSettings()
        postToPopup(port, { type: 'settings:data', settings })
        break
      }
      case 'settings:save': {
        const prev = await getSettings()
        const payload = { ...msg.payload }
        const serverUrlChanged = payload.serverUrl !== undefined && payload.serverUrl !== prev.serverUrl
        if (serverUrlChanged && payload.agentSocketUrl === undefined) {
          payload.agentSocketUrl = ''
        }
        await saveSettings(payload)
        if (payload.offlineMode === true && socket?.connected) {
          disconnect()
        }
        if ((serverUrlChanged || payload.agentSocketUrl !== undefined) && socket) {
          const wasConnected = !!socket
          disconnect()
          if (wasConnected && !payload.offlineMode) {
            void connect()
          }
        }
        break
      }
      case 'chat:send': {
        const requestId = msg.requestId
        try {
          const result = await runChat(msg.messages)
          postToPopup(port, { type: 'chat:response', text: result.text, toolsUsed: result.toolsUsed, toolEvents: result.toolEvents, requestId })
        } catch (err: any) {
          postToPopup(port, { type: 'chat:error', error: err.message, requestId })
        }
        break
      }

      case 'connection:test': {
        const result = await testConnection()
        postToPopup(port, { type: 'connection:result', result })
        break
      }

      case 'mcp:test': {
        // Run one browser tool locally and return its raw result to the popup.
        log('task', 'running', `测试: ${msg.tool}`, msg.args)
        try {
          const result = await withTaskTimeout(
            executeBrowserTool(msg.tool, msg.args || {}),
            taskTimeoutMs({ taskId: 'mcp-test', tool: msg.tool, args: msg.args }),
            `mcp.test ${msg.tool}`,
          )
          log('task', 'success', `测试完成: ${msg.tool}`)
          postToPopup(port, { type: 'mcp:test:result', requestId: msg.requestId, ok: true, result })
        } catch (err: any) {
          log('task', 'error', `测试失败: ${msg.tool} — ${err?.message || err}`)
          postToPopup(port, { type: 'mcp:test:result', requestId: msg.requestId, ok: false, error: err?.message || String(err) })
        }
        break
      }

      case 'offline-chat:get-config': {
        const settings = await getSettings()
        postToPopup(port, { type: 'offline-chat:config', requestId: msg.requestId, settings, hasAiKey: !!settings.aiKey?.trim() })
        break
      }

      case 'offline-chat:save-model': {
        try {
          const payload = {
            aiKey: String(msg.payload.aiKey || '').trim(),
            aiBaseUrl: String(msg.payload.aiBaseUrl || '').trim() || 'https://api.anthropic.com',
            aiModel: String(msg.payload.aiModel || '').trim() || 'claude-sonnet-4-5',
          }
          await saveSettings(payload)
          const settings = await getSettings()
          postToPopup(port, { type: 'offline-chat:model-saved', requestId: msg.requestId, ok: true, settings })
        } catch (err: any) {
          postToPopup(port, { type: 'offline-chat:model-saved', requestId: msg.requestId, ok: false, error: err?.message || String(err) })
        }
        break
      }

      case 'offline-chat:save-prompt': {
        await saveSettings({ offlinePrompt: String(msg.prompt || '').trim() })
        postToPopup(port, { type: 'offline-chat:prompt-saved', requestId: msg.requestId, ok: true })
        break
      }

      case 'offline-chat:list-tools': {
        const tools = await effectiveToolDefs()
        postToPopup(port, { type: 'offline-chat:tools', requestId: msg.requestId, tools })
        break
      }

      case 'offline-chat:send': {
        void (async () => {
          try {
            const result = await runOfflineChat(port, msg.requestId, msg.messages, msg.prompt, msg.allowedTools)
            postToPopup(port, { type: 'offline-chat:response', requestId: msg.requestId, ...result })
          } catch (err: any) {
            const canceled = err?.name === 'AbortError' || /已停止|aborted|canceled|cancelled/i.test(String(err?.message || err))
            postToPopup(port, { type: 'offline-chat:error', requestId: msg.requestId, error: canceled ? '已停止' : (err?.message || String(err)) })
          }
        })()
        break
      }

      case 'offline-chat:cancel': {
        const controller = offlineChatControllers.get(msg.requestId)
        if (controller) controller.canceled = true
        postToPopup(port, { type: 'offline-chat:canceled', requestId: msg.requestId, ok: !!controller })
        break
      }

    }
  })
})

// ── Keepalive ───────────────────────────────────────────────────────────────
// The socket's health check, shared by the offscreen heartbeat and the alarm.
function nudgeSocketHealth() {
  if (authRejected) return
  // If the socket object is gone (worker was torn down), re-establish from
  // stored auth. If it exists but is neither connected nor actively reconnecting
  // (e.g. after an 'io server disconnect', which Socket.IO does not auto-retry),
  // kick it. When socket.active is true the manager is already retrying — calling
  // connect() then would spawn a duplicate, flapping attempt.
  if (!socket) { void restoreAndConnectOnStartup(); return }
  if (!socket.connected && !socket.active) socket.connect()
}

// Primary pacemaker: the offscreen document pings every ~20s. Receiving the
// message both resets this worker's idle timer and lets us repair the socket.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'offscreen:keepalive') {
    nudgeSocketHealth()
    return false
  }
  // Remote-control peer (offscreen) → service worker: signaling to relay over the
  // socket, or an input event to inject via CDP.
  if (msg?.rc && msg.dir === 'to-bg') {
    handleOffscreenRcMessage(msg, rcSend)
    return false
  }
})

// Backstop pacemaker: chrome.alarms survives even if the offscreen document is
// ever lost, and re-creates it. (periodInMinutes is clamped to ~30s in released
// extensions, so this alone sits right at the idle-teardown edge — the offscreen
// heartbeat is what keeps the worker reliably alive.)
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepalive') return
  void ensureOffscreen()
  nudgeSocketHealth()
})

// ── Context menus ─────────────────────────────────────────────────────────
// Single onInstalled handler. removeAll() first so re-creating on update
// doesn't throw on the already-registered ids. The keepalive alarm is
// (re)created at module scope above on every service-worker wake, which is
// what actually matters for an MV3 worker that gets torn down frequently.
chrome.runtime.onInstalled.addListener(() => {
  void ensureOffscreen()
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'hs-ask', title: 'HeySure AI: 询问选中内容', contexts: ['selection'] })
    chrome.contextMenus.create({ id: 'hs-screenshot', title: 'HeySure AI: 截图分析此页', contexts: ['page'] })
  })
})

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'hs-ask' && info.selectionText) {
    await chrome.storage.session.set({ _pendingChat: info.selectionText })
  } else if (info.menuItemId === 'hs-screenshot') {
    // Pre-fill the chat so opening the popup kicks off a screenshot+analyze
    // turn (the agent has browser_screenshot available). Without this the
    // menu item was registered but did nothing when clicked.
    await chrome.storage.session.set({ _pendingChat: '请截图并分析当前页面' })
  }
})

// ── Auto-connect on browser startup ──────────────────────────────────────
chrome.runtime.onStartup.addListener(async () => {
  void ensureOffscreen()
  await restoreAndConnectOnStartup()
})

void ensureOffscreen()
void restoreAndConnectOnStartup()

// Login happens in the popup, but the actual socket lives in this service
// worker. Watch auth storage directly so a successful login always attempts
// to register even if the one-off popup port message is missed.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return
  if (changes[DYNAMIC_MCP_STORAGE_KEY]) {
    if (socket?.connected) void emitRegisterOn(socket)
    return
  }
  const authChange = changes._auth_state
  if (!authChange) return

  const oldToken = String(authChange.oldValue?.token || '')
  const newToken = String(authChange.newValue?.token || '')
  if (oldToken === newToken) return

  authRejected = false
  if (newToken) {
    if (socket) disconnect()
    void connect()
  } else {
    disconnect()
  }
})
