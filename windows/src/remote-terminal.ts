// remote-terminal — 命令行远程（PTY）在 Tauri 壳里的桥。是画面远程
// (remote-control.ts, WebRTC) 的姊妹通道，但**没有 WebRTC**：终端是低带宽字节流，
// 直接走服务器的 rt:* Socket.IO relay（见 server/connector_runtime/dispatch/remote_terminal.py），
// 因此天生不依赖 TURN，公网可用。
//
// 这里只做「服务器信令 ⇄ 本机 ConPTY」的翻译（PTY 本体在 src-tauri/src/pty.rs）：
//   rt:open   → native.ptyOpen 起一个 shell；PTY 输出经 pty://data 事件回来后转成 rt:data
//   rt:input  → native.ptyWrite 写入键入（data 为 base64 字节，原样透传）
//   rt:resize → native.ptyResize 调整行列
//   rt:close  → native.ptyClose 结束会话
//   （PTY 退出 → pty://exit 事件 → 转成 rt:exit）
// data 字段全程是「PTY 原始字节的 base64」，本层不解码，避免破坏 ANSI/控制序列。

import { native } from './native'
import type { UnlistenFn } from '@tauri-apps/api/event'

type SignalSender = (event: string, payload: any) => void
type RtLogger = (level: 'info' | 'warn' | 'error', message: string, data?: any) => void

let rtSend: SignalSender | null = null
let rtLog: RtLogger | null = null
// Session ids with a live PTY on this device (a device may host several terminals).
const rtSessions = new Set<string>()
// Global PTY output/exit subscriptions, registered lazily on first open and kept
// for the process lifetime (a single pair fans out by sessionId to every session).
let ptyDataUnlisten: UnlistenFn | null = null
let ptyExitUnlisten: UnlistenFn | null = null
let subscribing = false

function log(level: 'info' | 'warn' | 'error', message: string, data?: any): void {
  rtLog?.(level, `[命令行远程] ${message}`, data)
}

function signal(event: string, payload: any): void {
  rtSend?.(event, payload)
}

/** Subscribe once to native PTY output/exit and fan events out by sessionId. */
async function ensureSubscribed(): Promise<void> {
  if (ptyDataUnlisten || subscribing) return
  subscribing = true
  try {
    ptyDataUnlisten = await native.onPtyData(({ sessionId, data }) => {
      // Only relay for sessions we still consider live (drop late frames after close).
      if (rtSessions.has(sessionId)) signal('rt:data', { sessionId, data })
    })
    ptyExitUnlisten = await native.onPtyExit(({ sessionId, code }) => {
      if (!rtSessions.has(sessionId)) return
      rtSessions.delete(sessionId)
      signal('rt:exit', { sessionId, code })
      log('info', `会话结束（退出码 ${code ?? '未知'}）：${sessionId}`)
    })
  } finally {
    subscribing = false
  }
}

async function openSession(sessionId: string, data: any): Promise<void> {
  await ensureSubscribed()
  rtSessions.add(sessionId)
  try {
    await native.ptyOpen({
      sessionId,
      shell: data?.shell || undefined,
      cols: Number(data?.cols) || undefined,
      rows: Number(data?.rows) || undefined,
      cwd: data?.cwd || undefined,
    })
    log('info', `已启动终端会话：${sessionId}`)
  } catch (err: any) {
    rtSessions.delete(sessionId)
    const message = err?.message || String(err)
    log('error', `启动终端失败：${message}`)
    signal('rt:error', { sessionId, code: 'spawn_failed', message: `启动终端失败：${message}` })
  }
}

/**
 * One inbound rt:* signaling message from the controller (via the agent socket).
 * ``send`` emits back on that same socket; ``logger`` surfaces diagnostics in the
 * desktop app's activity log.
 */
export async function handleRemoteTerminalSignal(
  event: string,
  data: any,
  send: SignalSender,
  logger?: RtLogger,
): Promise<void> {
  const sessionId = String(data?.sessionId || '')
  if (!sessionId) return
  rtSend = send
  if (logger) rtLog = logger

  if (event === 'rt:open') {
    await openSession(sessionId, data)
    return
  }
  // Everything else targets a live session only.
  if (!rtSessions.has(sessionId)) return

  if (event === 'rt:input') {
    if (typeof data?.data === 'string') await native.ptyWrite(sessionId, data.data).catch(() => {})
  } else if (event === 'rt:resize') {
    const cols = Number(data?.cols) || 80
    const rows = Number(data?.rows) || 24
    await native.ptyResize(sessionId, cols, rows).catch(() => {})
  } else if (event === 'rt:close') {
    rtSessions.delete(sessionId)
    await native.ptyClose(sessionId).catch(() => {})
    log('info', `会话已关闭：${sessionId}`)
  }
}

/** The agent socket dropped — kill every live PTY so no shell is left orphaned,
 *  and drop the native subscriptions (re-created on the next rt:open). */
export function handleRemoteTerminalDisconnect(): void {
  for (const sessionId of rtSessions) void native.ptyClose(sessionId).catch(() => {})
  rtSessions.clear()
  ptyDataUnlisten?.()
  ptyExitUnlisten?.()
  ptyDataUnlisten = null
  ptyExitUnlisten = null
}
