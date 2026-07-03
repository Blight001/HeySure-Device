// Hidden renderer that hosts the WebRTC peer for desktop remote control.
//
// getUserMedia / RTCPeerConnection only exist in a renderer (Chromium) context,
// not in the Electron main process, so the live screen mirror runs here. The
// window has no UI and is never shown — it is purely an execution host that the
// main-process [remote-control-host] drives over IPC.

import { BrowserWindow } from 'electron'
import * as path from 'path'

let rcWindow: BrowserWindow | null = null

export function getRemoteControlWindow(): BrowserWindow | null {
  return rcWindow && !rcWindow.isDestroyed() ? rcWindow : null
}

/** Create (or reuse) the hidden peer window. Resolves once its renderer has
 *  loaded, so callers can safely ``webContents.send`` afterwards. */
export async function ensureRemoteControlWindow(): Promise<BrowserWindow> {
  const existing = getRemoteControlWindow()
  if (existing) return existing

  const win = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, '../preload.js'),
    },
  })
  rcWindow = win
  win.on('closed', () => { rcWindow = null })

  await win.loadFile(path.join(__dirname, '../renderer/remote-control.html'))
  return win
}

export function closeRemoteControlWindow(): void {
  if (rcWindow && !rcWindow.isDestroyed()) rcWindow.destroy()
  rcWindow = null
}
