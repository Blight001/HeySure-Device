import { io, Socket } from 'socket.io-client'
import os from 'os'
import path from 'path'
import { executeTask, getAvailableTools, getToolDefs, DispatchedTask } from './executor'
import { applyServerDynamicMcp, clearServerDynamicMcp } from './executor/dynamic'
import { resetPermissionPolicy, setPermissionPolicy } from './runtime/permission-guard'
import { probeRuntimes, cachedRuntimes } from './runtime/runtime-probe'
import { getPlatformInfo } from './platform'
import { AgentSettings } from './store'
import { normalizeServerUrl } from './server-url'

export type DeviceStatus = 'disconnected' | 'connecting' | 'connected' | 'registered' | 'error'

export interface AgentEvents {
  // aiConfigId is the server-side bound AI (null = none assigned yet), used by
  // the UI status indicator: green = connected + assigned, yellow = connected
  // but unassigned, red = disconnected.
  onStatusChange?: (status: DeviceStatus, reason?: string, aiConfigId?: number | null) => void
  onTaskStart?: (taskId: string, tool: string, args: any) => void
  onTaskResult?: (taskId: string, tool: string, result: any, success: boolean) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string, data?: any) => void
  // Fired when the server rejects registration because our user token is
  // invalid/expired. The runtime uses this to silently re-login with the saved
  // credentials and reconnect, so a server update doesn't strand the agent.
  onAuthFailure?: (reason: string) => void
  // Fired while a previously-established connection is being re-established
  // (socket.io retry loop). Drives the orange "reconnecting" indicator. active
  // is false once we're back (registered) or the socket was closed on purpose.
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
  private events: AgentEvents
  private _status: DeviceStatus = 'disconnected'
  private _boundAiConfigId: number | null = null
  // Guards against re-login loops: we only kick off one auto re-auth per
  // connection attempt. Reset whenever we (re)connect or register successfully.
  private reauthRequested = false
  workspaceRoot: string

  constructor(settings: AgentSettings, events: AgentEvents = {}) {
    this.settings = settings
    this.events = events
    this.workspaceRoot = settings.workspaceRoot || path.join(os.homedir(), 'HeySureWorkspace')
  }

  get status(): DeviceStatus { return this._status }
  get boundAiConfigId(): number | null { return this._boundAiConfigId }

  private setStatus(s: DeviceStatus, reason?: string) {
    this._status = s
    // Losing the connection clears the binding so we don't show green offline;
    // it is re-applied from the next device:registered.
    if (s !== 'registered' && s !== 'connected') this._boundAiConfigId = null
    this.events.onStatusChange?.(s, reason, this._boundAiConfigId)
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, data?: any) {
    this.events.onLog?.(level, msg, data)
  }

  connect(): void {
    // A non-null socket means we're already connected or mid-(re)connect
    // (socket.io drives its own retry loop). Bailing here prevents spawning a
    // second, orphaned socket when connect() is called twice in quick
    // succession — e.g. login now reconnects via updateSettings AND the
    // renderer calls connect() right after. disconnect() nulls the socket, so
    // a genuine reconnect still works.
    if (this.socket) return
    // Hard gate: an agent that hasn't logged in cannot talk to the server.
    // Without this guard the socket would open transport-level, the UI would
    // flash "已连接", then the server would reject device:register a moment
    // later. Refusing here keeps the status honest.
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

    // Manager-level retry loop: only fires when an established connection was
    // lost and is being re-established, so it's the right trigger for the
    // orange "reconnecting" prompt (the very first connect does not emit it).
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
      // Only an auth-type rejection (invalid/expired user token) is recoverable
      // by re-logging in. Other reasons — e.g. AI ownership mismatch — must not
      // trigger a re-login, or a valid token would loop forever.
      const isAuthFailure = /token|logged in|登录|未登录|授权|unauthor/i.test(reason)
      if (isAuthFailure && !this.reauthRequested) {
        this.reauthRequested = true
        this.events.onAuthFailure?.(reason)
      }
    })

    this.socket.on('task:dispatch', (task: DispatchedTask) => {
      void this.handleTask(task)
    })

    // Web-authored dynamic MCP tools for this device type, pushed by the server
    // on register and whenever an operator edits them. Held in memory only;
    // cleared on disconnect so tools never outlive the server session.
    this.socket.on('device:tool-config', (payload: any) => {
      try {
        // Apply the permission policy every push (it sits outside the tool
        // revision guard, so a policy-only change still takes effect).
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
    this.socket?.disconnect()
    this.socket = null
    this.clearServerSyncedTools()
    // A deliberate close is not a reconnect — clear the orange prompt so we
    // don't show "reconnecting" for an intentional disconnect/logout.
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
    // Probe runtimes once (async); the result rides the next register in the
    // retry loop below, so the server learns what this device can execute.
    void probeRuntimes().catch(() => {})
    if (!this.register()) return
    // A transport connection is not enough for the server to expose this
    // device. Keep registering until the server confirms device:registered;
    // this also heals a connection whose first custom event was lost while
    // Socket.IO was finishing its reconnect handshake.
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
      `agent-${os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '-')}`
    const hasAuth = !!this.settings.authToken
    // The desktop client no longer picks its own AI. It just logs in and
    // connects; an operator assigns a server-side AI to this device from the
    // web Workshop ("作坊") panel. The server re-applies that binding on every
    // register, so we send aiConfigId: null and let the server decide.
    try {
      this.log('info', '注册 agent（AI 由服务器作坊分配）')
      this.socket?.emit('device:register', {
        id: deviceId,
        name: this.settings.agentName || os.hostname(),
        group: this.settings.agentGroup || '',
        platform: `win32-desktop (${os.hostname()})`,
        os: getPlatformInfo(),
        capabilities: getAvailableTools(),
        // Which device runtimes can actually execute (python/powershell/shell),
        // so the server knows if a runtime tool has a device that can run it.
        runtimes: cachedRuntimes() || undefined,
        // Full self-described tool schemas (with the user's local description edits
        // merged in). The server stores these and surfaces them in mcp.list_tools /
        // describe_tool instead of hardcoding desktop tool schemas, so a tool added
        // to the catalog — or a description edited in the app — needs no server change.
        toolDefs: this.effectiveToolDefs(),
        version: '2.0.0',
        // The server requires a valid user JWT. ``authToken`` is the source
        // of truth; agentToken is kept as a legacy shared-secret fallback.
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
    const overrides = (this.settings as any).toolDescOverrides || {}
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
    this.workspaceRoot = newSettings.workspaceRoot || path.join(os.homedir(), 'HeySureWorkspace')
    // Put the agent into the connection state the new settings imply, instead
    // of only reconnecting when it happened to be connected already. connect()
    // self-gates with no authToken (logged out), so it just stays disconnected.
    // This fixes "logged in but the server never sees the agent",
    // where a fresh login from a disconnected state updated the token but never
    // opened a socket.
    this.connect()
  }
}
