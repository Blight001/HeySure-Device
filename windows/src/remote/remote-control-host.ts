// Main-process orchestrator for desktop remote control.
//
// Bridges three parties:
//   - the controller (browser) — reached over the agent's Socket.IO connection;
//   - the WebRTC peer — the hidden renderer ([remote-control-window]);
//   - the OS — via robotjs ([input-injector]).
//
// Signaling is the only thing that crosses the server (a handful of SDP/ICE
// messages). The live screen and the input events ride the peer-to-peer WebRTC
// link, so neither touches the server or even the main process — input comes
// back over the control DataChannel and is injected here.

import { ipcMain } from 'electron'
import {
  ensureRemoteControlWindow,
  getRemoteControlWindow,
  closeRemoteControlWindow,
} from '../windows/remote-control-window'
import { getPrimaryScreenSource } from './desktop-source'
import { injectInput, RcInputEvent } from './input-injector'

type SignalSender = (event: string, payload: any) => void

interface RcSession {
  sessionId: string
  send: SignalSender
}

const sessions = new Map<string, RcSession>()
let ipcReady = false

function toRenderer(channel: string, payload: any): void {
  getRemoteControlWindow()?.webContents.send(channel, payload)
}

function endSession(sessionId: string): void {
  sessions.delete(sessionId)
  // No peers left — close the hidden window so the desktop stops being captured.
  if (sessions.size === 0) closeRemoteControlWindow()
}

/** Register the renderer → main IPC channels once. */
export function initRemoteControlHost(): void {
  if (ipcReady) return
  ipcReady = true

  // Renderer's outbound signaling (offer / ICE / ready / error / stopped):
  // forward to the controller over the socket via the owning session's sender.
  ipcMain.on('rc:signal', (_event, msg: { event?: string; payload?: any }) => {
    if (!msg?.event) return
    const session = sessions.get(String(msg.payload?.sessionId || ''))
    if (!session) return
    session.send(msg.event, msg.payload)
    if (msg.event === 'rc:stopped' || msg.event === 'rc:error') {
      endSession(session.sessionId)
    }
  })

  // A pointer / keyboard event from the controller, relayed by the renderer
  // off the P2P control channel. Inject it into the OS.
  ipcMain.on('rc:input', (_event, payload: RcInputEvent) => {
    injectInput(payload || ({} as RcInputEvent))
  })
}

/** Socket → main: one inbound signaling message from the controller. */
export async function handleRemoteControlSignal(
  event: string,
  data: any,
  send: SignalSender,
): Promise<void> {
  const sessionId = String(data?.sessionId || '')
  if (!sessionId) return

  if (event === 'rc:start') {
    sessions.set(sessionId, { sessionId, send })
    try {
      const win = await ensureRemoteControlWindow()
      const source = await getPrimaryScreenSource()
      win.webContents.send('rc:start', {
        sessionId,
        sourceId: source.sourceId,
        width: source.width,
        height: source.height,
      })
    } catch (err: any) {
      send('rc:error', { sessionId, code: 'capture_failed', message: err?.message || String(err) })
      endSession(sessionId)
    }
    return
  }

  // rc:answer / rc:ice / rc:stop → hand to the renderer peer.
  toRenderer(event, data)
  if (event === 'rc:stop') endSession(sessionId)
}

/** The agent socket dropped — tear down every session and stop capturing. */
export function handleRemoteControlDisconnect(): void {
  for (const sessionId of [...sessions.keys()]) {
    toRenderer('rc:stop', { sessionId })
  }
  sessions.clear()
  closeRemoteControlWindow()
}
