// offscreen.ts — keepalive pacemaker + WebRTC peer host for the MV3 service worker.
//
// Two jobs, both of which must live outside the service worker:
//
//  1. Keepalive: the worker owns the Socket.IO connection but Chrome tears it
//     down after ~30s idle. A periodic runtime message from this document (which
//     is NOT reclaimed for inactivity) is an event that resets the worker's idle
//     timer, keeping the socket alive while the browser is minimized.
//
//  2. Remote-control peer: a service worker can't run WebRTC, so the
//     RTCPeerConnection for desktop-style tab control lives here. The worker
//     captures the tab (CDP screencast — see lib/remote-control.ts) and streams
//     JPEG frames to us; we paint them onto a canvas, expose it as a real WebRTC
//     video track (so the web reuses its <video> path), and relay input from the
//     P2P control DataChannel back to the worker for CDP injection.

// ── 1. Keepalive ──────────────────────────────────────────────────────────────
const PING_INTERVAL_MS = 20_000 // comfortably under the worker's ~30s idle teardown

function ping() {
  chrome.runtime.sendMessage({ type: 'offscreen:keepalive', at: Date.now() }).catch(() => {})
}
ping()
setInterval(ping, PING_INTERVAL_MS)

// ── 2. Remote-control WebRTC peer ──────────────────────────────────────────────
const RC_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

let pc: RTCPeerConnection | null = null
let channel: RTCDataChannel | null = null
let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let sessionId = ''
let readySent = false
const pendingIce: RTCIceCandidateInit[] = []
// The worker broadcasts the initial tab/address state the instant a session
// starts — before the control channel finishes negotiating. We stash the latest
// state here and flush it on channel.onopen so the operator sees all tabs (and
// the live URL) the moment the stream appears, not only after a tab changes.
let lastBrowserState: unknown = null

function sendBrowserState(): void {
  if (channel && channel.readyState === 'open' && lastBrowserState != null) {
    try { channel.send(JSON.stringify({ kind: 'browser-state', state: lastBrowserState })) } catch { /* noop */ }
  }
}

function toBg(event: string, payload: any): void {
  chrome.runtime.sendMessage({ rc: true, dir: 'to-bg', event, sessionId, ...payload }).catch(() => {})
}

function rcCleanup(): void {
  if (channel) { try { channel.close() } catch { /* noop */ } channel = null }
  if (pc) {
    pc.onicecandidate = null
    pc.onconnectionstatechange = null
    try { pc.close() } catch { /* noop */ }
    pc = null
  }
  canvas = null
  ctx = null
  readySent = false
  pendingIce.length = 0
  lastBrowserState = null
  sessionId = ''
}

async function startPeer(sid: string): Promise<void> {
  if (pc) rcCleanup()
  sessionId = sid

  canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  ctx = canvas.getContext('2d')
  const stream = canvas.captureStream(30)

  const connection = new RTCPeerConnection({ iceServers: RC_ICE_SERVERS })
  pc = connection
  connection.onicecandidate = (e) => { if (e.candidate) toBg('ice', { candidate: e.candidate.toJSON() }) }
  connection.onconnectionstatechange = () => {
    const s = connection.connectionState
    if (s === 'failed' || s === 'disconnected' || s === 'closed') toBg('stopped', {})
  }

  const [videoTrack] = stream.getVideoTracks()
  // 'detail' tells the encoder this is screen/text content: keep resolution
  // sharp instead of trading it for frame rate (the default camera behavior).
  if (videoTrack) videoTrack.contentHint = 'detail'
  const sender = videoTrack ? connection.addTrack(videoTrack, stream) : null
  if (sender) {
    try {
      const params = sender.getParameters()
      if (!params.encodings || !params.encodings.length) (params as any).encodings = [{}]
      params.encodings[0].maxBitrate = 8_000_000
      ;(params as any).degradationPreference = 'maintain-resolution'
      await sender.setParameters(params)
    } catch { /* setParameters can reject before negotiation — non-fatal */ }
  }

  // We own the control channel: the operator sends pointer/keyboard input and
  // browser commands on it; we push tab-strip / address-bar state back on it.
  channel = connection.createDataChannel('control')
  // Flush whatever tab/address state arrived during negotiation so the operator's
  // tab strip and address bar populate immediately on connect.
  channel.onopen = () => sendBrowserState()
  channel.onmessage = (e) => {
    try { toBg('control-msg', { msg: JSON.parse(String(e.data)) }) } catch { /* ignore */ }
  }

  const offer = await connection.createOffer()
  await connection.setLocalDescription(offer)
  toBg('offer', { sdp: offer.sdp })
}

function drawFrame(dataUrl: string): void {
  if (!ctx || !canvas) return
  const img = new Image()
  img.onload = () => {
    if (!ctx || !canvas) return
    if (canvas.width !== img.width || canvas.height !== img.height) {
      canvas.width = img.width
      canvas.height = img.height
    }
    ctx.drawImage(img, 0, 0)
    if (!readySent) {
      readySent = true
      toBg('ready', { width: img.width, height: img.height })
    }
  }
  img.src = dataUrl
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.rc || msg.dir !== 'to-offscreen') return
  switch (msg.event) {
    case 'peer-start':
      void startPeer(String(msg.sessionId || ''))
      break
    case 'answer':
      if (pc && msg.sessionId === sessionId) {
        void pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).then(async () => {
          for (const c of pendingIce.splice(0)) await pc!.addIceCandidate(c).catch(() => {})
        })
      }
      break
    case 'ice':
      if (pc && msg.sessionId === sessionId && msg.candidate) {
        if (pc.remoteDescription) void pc.addIceCandidate(msg.candidate).catch(() => {})
        else pendingIce.push(msg.candidate)
      }
      break
    case 'frame':
      if (msg.sessionId === sessionId) drawFrame(String(msg.dataUrl || ''))
      break
    case 'browser-state':
      // Push the Edge-style tab/address state to the operator over the channel.
      // Stash it too: if the channel is still negotiating, channel.onopen flushes
      // the latest stashed state so the operator never starts with an empty strip.
      lastBrowserState = msg.state
      sendBrowserState()
      break
    case 'peer-stop':
      rcCleanup()
      break
  }
  return false
})
