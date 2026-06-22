// Socket.IO agent for the ADB form. Same protocol as the Electron shells and the
// on-device Android app (device.ts): register → receive task:dispatch → reply
// task:result/error. Registers with isAndroid:true so the server classifies it
// as the same "android" device type as 方案 A.

import { io, Socket } from 'socket.io-client'
import os from 'os'
import * as adb from './adb'
import { executeTask, toolDefs, toolNames } from './executor'

export interface AgentConfig {
  agentSocketUrl: string
  authToken: string
  userId: number | null
  deviceId: string
  agentName: string
  serial: string
  model: string
}

export class AdbAgent {
  private socket: Socket | null = null
  private readonly finished = new Set<string>()

  constructor(
    private readonly cfg: AgentConfig,
    private readonly log: (msg: string) => void,
  ) {}

  private get target(): adb.AdbTarget { return { serial: this.cfg.serial } }

  connect(): void {
    if (this.socket) return
    this.log(`连接 ${this.cfg.agentSocketUrl} …`)
    const socket = io(this.cfg.agentSocketUrl, {
      transports: ['websocket', 'polling'],
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity,
    })
    this.socket = socket

    socket.on('connect', () => { this.log('已连接，注册中…'); this.register() })
    socket.on('disconnect', (reason) => this.log(`连接断开: ${reason}`))
    socket.on('connect_error', (err) => this.log(`连接错误: ${err.message}`))
    socket.on('device:registered', (data: any) =>
      this.log(`注册成功${data?.aiConfigId == null ? '（未分配 AI）' : ''}`))
    socket.on('device:register_rejected', (data: any) =>
      this.log(`注册被拒绝: ${data?.reason || '未知原因'}`))
    socket.on('task:dispatch', (task: any) => { void this.handleTask(task) })
  }

  disconnect(): void {
    this.socket?.disconnect()
    this.socket = null
  }

  private register(): void {
    this.socket?.emit('device:register', {
      id: this.cfg.deviceId,
      name: this.cfg.agentName,
      group: '',
      platform: `android-adb (${this.cfg.model || this.cfg.serial})`,
      os: `ADB host ${os.platform()} → ${this.cfg.serial}`,
      capabilities: toolNames(),
      toolDefs: toolDefs(),
      version: '2.0.0',
      token: this.cfg.authToken,
      lifecycle: 'registered',
      // Same flag the on-device app sets → server device_type "android".
      isAndroid: true,
      aiConfigId: null,
      userId: this.cfg.userId,
    })
  }

  private async handleTask(task: any): Promise<void> {
    const taskId = String(task?.taskId || '')
    if (!taskId || this.finished.has(taskId)) return
    const tool = String(task?.tool || '')
    const args = (task?.args && typeof task.args === 'object') ? task.args : {}
    const allowed: string[] | undefined = Array.isArray(task?.allowedTools)
      ? task.allowedTools.map((x: any) => String(x)) : undefined

    this.log(`任务[${taskId}] 开始: ${tool}`)
    this.socket?.emit('task:progress', { taskId, progress: 0, message: `开始执行 ${tool}…` })

    const outcome = await executeTask(this.target, tool, args, allowed)
    this.finished.add(taskId)

    if (outcome.success) {
      this.socket?.emit('task:result', {
        taskId, userId: task?.userId, aiConfigId: task?.aiConfigId, sessionId: task?.sessionId,
        tool: outcome.tool, success: true, result: outcome.result, summary: outcome.summary,
      })
      this.log(`任务[${taskId}] 完成`)
    } else {
      this.socket?.emit('task:error', { taskId, userId: task?.userId, error: outcome.summary })
      this.log(`任务[${taskId}] 失败: ${outcome.summary}`)
    }
  }
}
