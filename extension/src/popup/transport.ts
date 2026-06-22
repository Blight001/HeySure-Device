// popup/transport.ts — resilient popup <-> background port management.
// MV3 service workers can be torn down at any time, so the popup must be able
// to recreate its runtime port and retry messages without throwing when the
// old port disappears.

import { BgMsg, PopupMsg } from '../lib/types'
import { state } from './state'

type PopupMessageHandler = (msg: BgMsg) => void

let currentPort: chrome.runtime.Port | null = null
let messageHandler: PopupMessageHandler | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const pendingMessages: PopupMsg[] = []

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect() {
  if (!messageHandler || reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectPort()
  }, 1000)
}

function flushPendingMessages() {
  if (!currentPort || !messageHandler) return
  while (pendingMessages.length) {
    const msg = pendingMessages.shift()!
    try {
      currentPort.postMessage(msg)
    } catch {
      // The port died again while flushing. Put the message back, clear the
      // live port reference and try again after a short delay.
      pendingMessages.unshift(msg)
      currentPort = null
      scheduleReconnect()
      return
    }
  }
}

function connectPort() {
  if (!messageHandler) return
  if (currentPort) return currentPort

  const port = chrome.runtime.connect({ name: 'popup' })
  currentPort = port
  state.port = port

  port.onMessage.addListener(messageHandler)
  port.onDisconnect.addListener(() => {
    // Chrome exposes a failed runtime.connect() through runtime.lastError on
    // disconnect. Reading it prevents "Unchecked runtime.lastError" console
    // noise; the reconnect loop below handles the transient failure.
    void chrome.runtime.lastError
    if (currentPort !== port) return
    currentPort = null
    scheduleReconnect()
  })

  flushPendingMessages()
  return port
}

export function initPopupPort(onMessage: PopupMessageHandler) {
  messageHandler = onMessage
  clearReconnectTimer()
  connectPort()
}

export function sendToBackground(msg: PopupMsg) {
  if (!currentPort) {
    pendingMessages.push(msg)
    scheduleReconnect()
    connectPort()
    return false
  }

  try {
    currentPort.postMessage(msg)
    return true
  } catch {
    pendingMessages.push(msg)
    currentPort = null
    scheduleReconnect()
    connectPort()
    return false
  }
}
