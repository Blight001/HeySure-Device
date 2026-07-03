// agent — port of device/windows/src/device.ts (HeySureAgent). socket.io-client
// runs in the WebView, so the register / dispatch / tool-config protocol is
// byte-for-byte the Electron one. Remote-control (rc:*) signaling is wired the
// same way as the Electron shell — the WebView natively owns WebRTC, so the peer
// lives in remote-control.ts (no hidden renderer) — and the agent advertises the
// remote_control capability so the server allows live screen control.

import { io, Socket } from 'socket.io-client'
import { executeTask, getAvailableTools, getToolDefs, type DispatchedTask } from './executor'
import { applyServerDynamicMcp, clearServerDynamicMcp } from './executor/dynamic'
import { resetPermissionPolicy, setPermissionPolicy } from './runtime/permission-guard'
import { probeRuntimes, cachedRuntimes } from './runtime/runtime-probe'
import { handleRemoteControlSignal, handleRemoteControlDisconnect } from './remote-control'
import { normalizeServerUrl } from './server-url'
import type { AgentSettings } from './settings'
import type { HostInfo } from './native'

export type DeviceStatus = 'disconnected' | 'connecting' | 'connected' | 'registered' | 'error'

export interface AgentEvents {
  onStatusChange?: (status: DeviceStatus, reason?: string, aiConfigId?: number | null) => void
  onTaskStart?: (taskId: string, tool: string, args: any) => void
  onTaskResult?: (taskId: string, tool: string, result: any, success: boolean) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string, data?: any) => void
  // Fired when the server rejects registration because our user token is
  // invalid/expired; the host silently re-logs-in with saved credentials.
  onAuthFailure?: (reason: string) => void
  onReconnecting?: (active: boolean, reason?: string) => void
}

type CachedOutcome =
  | { kind: 'running' }
  | { kind: 'result'; payload: any }
  | { kind: 'error'; error: string }

export class HeySureAgent {
  private socket: Socket | null = null
  private registrationRetryTimer: ReturnType<typeof setInterval> | null = null
  private taskOutcomes = new Map<string, CachedOutcome>()
  private settings: AgentSettings
  private host: HostInfo
  private events: AgentEvents
  private _status: DeviceStatus = 'disconnected'
  private _boundAiConfigId: number | null = null
  private reauthRequested = false
  workspaceRoot: string

  constructor(settings: AgentSettings, host: HostInfo, events: AgentEvents = {}) {
    this.settings = settings
    this.host = host
    this.events = events
    this.workspaceRoot = settings.workspaceRoot || `${host.homeDir}\\HeySureWorkspace`
  }

  get status(): DeviceStatus { return this._status }
  get boundAiConfigId(): number | null { return this._boundAiConfigId }

  private setStatus(s: DeviceStatus, reason?: string) {
    this._status = s
    if (s !== 'registered' && s !== 'connected') this._boundAiConfigId = null
    this.events.onStatusChange?.(s, reason, this._boundAiConfigId)
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, data?: any) {
    this.events.onLog?.(level, msg, data)
  }

  connect(): void {
    // A non-null socket means we're already connected or mid-(re)connect.
    if (this.socket) return
    if (!this.settings.authToken) {
      this.setStatus('disconnected')
      this.log('warn', '未登录，已阻止连接服务器（请先登录账号）')
      return
    }
    this.setStatus('connecting')
    this.reauthRequested = false
    let serverUrl: string
    try {
      serverUrl = normalizeServerUrl(this.settings.agentSocketUrl)
    } catch {
      this.setStatus('error', 'Agent 连接地址格式无效')
      this.log('error', '连接错误: Agent 连接地址格式无效')
      return
    }
    if (!serverUrl) {
      this.setStatus('error', '缺少 Agent 连接地址，请重新登录')
      this.log('error', '连接错误: 缺少 Agent 连接地址，请重新登录')
      return
    }
    this.log('info', `正在连接 ${serverUrl}…`)

    this.socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity,
    })

    this.socket.io.on('reconnect_attempt', (attempt: number) => {
      this.events.onReconnecting?.(true, `正在重连服务器（第 ${attempt} 次）…`)
    })

    this.socket.on('connect', () => {
      this.setStatus('connected')
      this.log('info', '已连接到服务器')
      this.startRegistrationHandshake()
    })

    this.socket.on('disconnect', (reason: string) => {
      this.stopRegistrationHandshake()
      this.clearServerSyncedTools()
      handleRemoteControlDisconnect()
      this.setStatus('disconnected', reason)
      this.log('warn', `连接断开: ${reason}`)
    })

    this.socket.on('connect_error', (err: Error) => {
      this.setStatus('error', err.message)
      this.log('error', `连接错误: ${err.message}`)
    })

    this.socket.on('device:registered', (data: any) => {
      this.stopRegistrationHandshake()
      const raw = data?.aiConfigId
      const n = typeof raw === 'number' ? raw : (raw != null && String(raw).trim() !== '' ? Number(raw) : null)
      this._boundAiConfigId = Number.isFinite(n as number) ? (n as number) : null
      this.reauthRequested = false
      this.events.onReconnecting?.(false)
      this.setStatus('registered')
      this.log('info', `注册成功: ${data?.name || this.settings.agentName}${this._boundAiConfigId == null ? '（未分配 AI）' : ''}`)
    })

    this.socket.on('device:register_rejected', (data: any) => {
      this.stopRegistrationHandshake()
      const reason = data?.reason || '注册被拒绝'
      this.setStatus('error', reason)
      this.log('error', `注册失败: ${reason}`)
      const isAuthFailure = /token|logged in|登录|未登录|授权|unauthor/i.test(reason)
      if (isAuthFailure && !this.reauthRequested) {
        this.reauthRequested = true
        this.events.onAuthFailure?.(reason)
      }
    })

    this.socket.on('task:dispatch', (task: DispatchedTask) => {
      void this.handleTask(task)
    })

    // Remote control (WebRTC signaling). The desktop is the offerer; the live
    // screen + input ride a peer-to-peer link, so only these few SDP/ICE
    // messages cross the socket. The WebView owns the WebRTC peer (remote-control.ts).
    const rcSend = (event: string, payload: any) => { this.socket?.emit(event, payload) }
    const rcConn = { serverUrl: this.settings.serverUrl, token: this.settings.authToken }
    for (const ev of ['rc:start', 'rc:answer', 'rc:ice', 'rc:stop']) {
      this.socket.on(ev, (data: any) => { void handleRemoteControlSignal(ev, data, rcSend, this.events.onLog, rcConn) })
    }

    // Web-authored dynamic MCP tools for this device type, pushed by the server
    // on register and whenever an operator edits them.
    this.socket.on('device:tool-config', (payload: any) => {
      try {
        if (payload && payload.permissionPolicy) setPermissionPolicy(payload.permissionPolicy)
        const status = applyServerDynamicMcp(payload)
        if (status.applied) this.log('info', `已应用服务器下发的 MCP 工具：${status.tools} 个`)
      } catch (err: any) {
        this.log('error', `应用服务器 MCP 工具失败: ${err?.message || err}`)
      }
    })
  }

  disconnect(): void {
    this.stopRegistrationHandshake()
    handleRemoteControlDisconnect()
    this.socket?.disconnect()
    this.socket = null
    this.clearServerSyncedTools()
    this.events.onReconnecting?.(false)
    this.setStatus('disconnected')
  }

  private clearServerSyncedTools(): void {
    const status = clearServerDynamicMcp()
    if (!status.cleared) return
    resetPermissionPolicy()
    this.log('info', '已清空服务器下发的 MCP 工具（等待重新同步）')
  }

  private stopRegistrationHandshake(): void {
    if (this.registrationRetryTimer) {
      clearInterval(this.registrationRetryTimer)
      this.registrationRetryTimer = null
    }
  }

  private startRegistrationHandshake(): void {
    this.stopRegistrationHandshake()
    void probeRuntimes().catch(() => {})
    if (!this.register()) return
    // Keep registering until the server confirms device:registered.
    this.registrationRetryTimer = setInterval(() => {
      if (!this.socket?.connected || this._status === 'registered') {
        this.stopRegistrationHandshake()
        return
      }
      this.log('warn', '尚未收到服务器注册确认，正在重试')
      this.register()
    }, 3000)
  }

  private register(): boolean {
    const deviceId = this.settings.deviceId ||
      `agent-${this.host.hostname.toLowerCase().replace(/[^a-z0-9]/g, '-')}`
    const hasAuth = !!this.settings.authToken
    try {
      this.log('info', '注册 agent（AI 由服务器作坊分配）')
      this.socket?.emit('device:register', {
        id: deviceId,
        name: this.settings.agentName || this.host.hostname,
        group: this.settings.agentGroup || '',
        platform: `win32-desktop (${this.host.hostname})`,
        os: {
          platform: this.host.platform,
          arch: this.host.arch,
          release: '',
          hostname: this.host.hostname,
          cpus: this.host.cpus,
          totalMem: '',
        },
        // Advertise remote_control so the server gates live screen control on it
        // (mirrors remote_control.RC_CAPABILITY server-side). The WebView peer
        // (remote-control.ts) handles capture + WebRTC; input rides Rust enigo.
        capabilities: [...getAvailableTools(), 'remote_control'],
        runtimes: cachedRuntimes() || undefined,
        toolDefs: this.effectiveToolDefs(),
        version: '2.0.0-tauri',
        token: this.settings.authToken || this.settings.agentToken || '',
        workspaceRoot: this.workspaceRoot,
        lifecycle: 'registered',
        isWindowsDesktop: true,
        aiConfigId: null,
        userId: hasAuth ? this.settings.userId : null,
      })
      return true
    } catch (err: any) {
      const reason = err?.message || String(err)
      this.stopRegistrationHandshake()
      this.setStatus('error', reason)
      this.log('error', `注册负载构造失败: ${reason}`)
      return false
    }
  }

  refreshRegistration(): void {
    if (this.socket?.connected) this.register()
    else this.connect()
  }

  private async handleTask(task: DispatchedTask): Promise<void> {
    const taskId = task.taskId
    if (!taskId) return

    // Idempotency: replay cached outcome for duplicate dispatches
    const cached = this.taskOutcomes.get(taskId)
    if (cached) {
      if (cached.kind === 'result') this.socket?.emit('task:result', cached.payload)
      else if (cached.kind === 'error') this.socket?.emit('task:error', { taskId, error: cached.error })
      return
    }

    this.taskOutcomes.set(taskId, { kind: 'running' })
    const tool = task.tool || '(infer)'
    this.events.onTaskStart?.(taskId, tool, task.args || {})
    this.log('info', `任务 [${taskId}] 开始: ${tool}`, task.args)

    this.socket?.emit('task:progress', { taskId, progress: 0, message: `开始执行 ${tool}…` })

    try {
      const outcome = await executeTask(this.workspaceRoot, task)
      const payload = {
        taskId,
        userId: task.userId,
        aiConfigId: task.aiConfigId,
        sessionId: task.sessionId,
        tool: outcome.tool,
        success: outcome.success,
        result: outcome.result,
        summary: outcome.summary,
        workspaceRoot: this.workspaceRoot,
      }
      this.taskOutcomes.set(taskId, { kind: 'result', payload })
      this.socket?.emit('task:result', payload)
      this.events.onTaskResult?.(taskId, outcome.tool, outcome.result, outcome.success)
      this.log(outcome.success ? 'info' : 'warn', `任务 [${taskId}] ${outcome.success ? '完成' : '失败'}: ${outcome.summary}`)
    } catch (err: any) {
      const errMsg = err?.message || String(err)
      this.taskOutcomes.set(taskId, { kind: 'error', error: errMsg })
      this.socket?.emit('task:error', { taskId, userId: task.userId, error: errMsg })
      this.events.onTaskResult?.(taskId, tool, null, false)
      this.log('error', `任务 [${taskId}] 异常: ${errMsg}`)
    }
  }

  // Run a single tool locally for the MCP tester page (no server dispatch).
  async runToolLocally(tool: string, args: Record<string, any>): Promise<{ success: boolean; result: any; summary: string }> {
    const task: DispatchedTask = { taskId: `local-${Date.now()}`, tool, args: args || {} }
    return executeTask(this.workspaceRoot, task)
  }

  // getToolDefs() with the user's local description edits merged in.
  effectiveToolDefs() {
    const overrides = this.settings.toolDescOverrides || {}
    return getToolDefs().map(def => {
      const o = overrides[def.name]
      if (!o) return def
      const desc = String(o.description || '').trim()
      const props = (def.input_schema && def.input_schema.properties) || {}
      let nextProps = props
      if (o.parameters && Object.keys(o.parameters).length) {
        nextProps = {}
        for (const [k, v] of Object.entries(props)) {
          const pd = String(o.parameters[k] || '').trim()
          nextProps[k] = pd ? { ...(v as any), description: pd } : v
        }
      }
      return {
        ...def,
        description: desc || def.description,
        input_schema: { ...def.input_schema, properties: nextProps },
      }
    })
  }

  updateSettings(newSettings: AgentSettings): void {
    this.disconnect()
    this.settings = newSettings
    this.workspaceRoot = newSettings.workspaceRoot || `${this.host.homeDir}\\HeySureWorkspace`
    // connect() self-gates with no authToken (logged out).
    this.connect()
  }
}
