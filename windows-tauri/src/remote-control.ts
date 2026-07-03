// remote-control — desktop live remote control for the Tauri shell.
//
// Port of the Electron desktop's two-part design (remote/remote-control-host.ts
// + shared/renderer/remote-control.ts) collapsed into ONE module, because the
// Tauri WebView natively owns RTCPeerConnection — there is no hidden peer
// renderer to bridge to. The desktop is the **offerer**: it opens a ``control``
// DataChannel for inbound pointer/keyboard events and offers; the browser
// answers. Media + input then flow peer-to-peer; only the SDP/ICE signaling
// below crosses the server (relayed by connector_runtime/dispatch/remote_control.py
// over the agent socket).
//
// Screen capture is DIRECT, not screen-sharing: WebView2 has no Electron
// desktopCapturer and getDisplayMedia would pop a "share your screen" picker/
// indicator, so instead the Rust ``rc_capture_frame`` command grabs the primary
// screen natively (xcap → JPEG → raw bytes over IPC); we decode each frame with
// createImageBitmap, paint it onto an offscreen <canvas>, and use
// canvas.captureStream() as the WebRTC video track.
// Inbound input events are injected into the OS via ``rc_inject_input`` (enigo —
// the robotjs equivalent). Both Rust commands live in src-tauri/src/rc.rs.

import { native } from './native'

type SignalSender = (event: string, payload: any) => void
type RcLogger = (level: 'info' | 'warn' | 'error', message: string, data?: any) => void

const RC_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

// Native screen-capture pacing. The frame path is capture(GDI)+JPEG-encode in
// Rust → raw-bytes IPC → createImageBitmap+draw in the WebView. Moving off the
// base64 data-URL path (no ~33% inflation, no string marshaling, and
// createImageBitmap decodes faster/off-thread vs Image.decode) lets us run the
// capture loop meaningfully faster than the old ~10fps ceiling.
const CAPTURE_FPS = 20
const FRAME_INTERVAL_MS = Math.round(1000 / CAPTURE_FPS)
// JPEG quality of the *source* frame before WebRTC re-encodes it. 55 was visibly
// soft on text; 82 keeps text/edges crisp at a modest byte cost (the bytes never
// leave the machine — this hop is in-process IPC, not the network).
const JPEG_QUALITY = 82
// Cap the WebRTC video encoder well above the VP8 default so full-screen content
// isn't starved into a blurry low-bitrate stream. WebRTC still adapts *down*
// under real bandwidth pressure — this only lifts the artificial ceiling.
const MAX_VIDEO_BITRATE = 12_000_000

let rcPc: RTCPeerConnection | null = null
let rcStream: MediaStream | null = null
let rcSessionId = ''
let rcSend: SignalSender | null = null
let rcLog: RcLogger | null = null
const rcPendingIce: RTCIceCandidateInit[] = []
let inputSeen = false

// Capture loop state.
let rcCanvas: HTMLCanvasElement | null = null
let rcCtx: CanvasRenderingContext2D | null = null
let rcCapturing = false
let rcFrameTimer: ReturnType<typeof setTimeout> | null = null

/** Decode raw JPEG bytes from the native capture into a drawable bitmap, or null
 *  if the buffer is empty (capture unavailable) or malformed. */
async function decodeFrame(buf: ArrayBuffer): Promise<ImageBitmap | null> {
  if (!buf || buf.byteLength === 0) return null
  try {
    return await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }))
  } catch {
    return null
  }
}

/** Pull one native frame and paint it onto the capture canvas. */
async function drawFrame(): Promise<void> {
  if (!rcCanvas || !rcCtx) return
  let buf: ArrayBuffer
  try {
    buf = await native.rcCaptureFrame(JPEG_QUALITY)
  } catch {
    return // transient capture failure — keep the previous frame
  }
  const bitmap = await decodeFrame(buf)
  if (!bitmap) return // empty/undecodable frame — keep the previous one
  if (!rcCanvas || !rcCtx) { bitmap.close(); return } // session ended mid-decode
  // Later frames are scaled to the canvas set from the first frame, so a
  // mid-session resolution change never disrupts the video track dimensions.
  rcCtx.drawImage(bitmap, 0, 0, rcCanvas.width, rcCanvas.height)
  bitmap.close() // release the decoded frame promptly — one per tick adds up
}

/** Self-pacing capture loop (setTimeout, not setInterval) so a slow frame never
 *  piles up overlapping captures. */
function scheduleCapture(): void {
  const tick = async () => {
    if (!rcCapturing) return
    const t0 = performance.now()
    await drawFrame()
    if (!rcCapturing) return
    const delay = Math.max(0, FRAME_INTERVAL_MS - (performance.now() - t0))
    rcFrameTimer = setTimeout(() => { void tick() }, delay)
  }
  void tick()
}

function stopCapture(): void {
  rcCapturing = false
  if (rcFrameTimer) {
    clearTimeout(rcFrameTimer)
    rcFrameTimer = null
  }
  rcCanvas = null
  rcCtx = null
}

function log(level: 'info' | 'warn' | 'error', message: string, data?: any): void {
  rcLog?.(level, `[远程控制] ${message}`, data)
}

function signal(event: string, payload: any): void {
  rcSend?.(event, payload)
}

/** Tear down the live session. ``notifyStopped`` tells the controller we ended. */
function cleanup(notifyStopped: boolean): void {
  if (notifyStopped && rcSessionId) signal('rc:stopped', { sessionId: rcSessionId })
  stopCapture()
  if (rcStream) {
    rcStream.getTracks().forEach(t => t.stop())
    rcStream = null
  }
  if (rcPc) {
    rcPc.onicecandidate = null
    rcPc.onconnectionstatechange = null
    rcPc.close()
    rcPc = null
  }
  rcPendingIce.length = 0
  rcSessionId = ''
  inputSeen = false
}

/** Raise the video sender's encoder limits so full-screen content stays sharp.
 *  ``maintain-resolution`` makes WebRTC drop frame rate (not resolution) under
 *  pressure — a lower but crisp image beats a smeared full-rate one — and the
 *  bitrate/framerate caps lift VP8's conservative defaults. Best-effort: a
 *  browser that rejects setParameters just keeps its defaults. */
async function tuneVideoEncoder(connection: RTCPeerConnection): Promise<void> {
  const sender = connection.getSenders().find(s => s.track?.kind === 'video')
  if (!sender) return
  try {
    const params = sender.getParameters()
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
    params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE
    params.encodings[0].maxFramerate = CAPTURE_FPS
    params.degradationPreference = 'maintain-resolution'
    await sender.setParameters(params)
  } catch (err: any) {
    log('warn', `视频编码参数设置失败（保持默认）：${err?.message || err}`)
  }
}

async function rcStartSession(sessionId: string): Promise<void> {
  // A new start while one is live replaces it (single operator per desktop).
  if (rcPc) cleanup(false)
  rcSessionId = sessionId

  // Native screen capture (no getDisplayMedia → no screen-share prompt). The
  // first frame both proves capture works and fixes the video dimensions; from
  // then on frames are painted into the same canvas and captureStream() turns it
  // into the WebRTC video track.
  let firstBuf: ArrayBuffer | null = null
  try {
    firstBuf = await native.rcCaptureFrame(JPEG_QUALITY)
  } catch (err: any) {
    log('error', `屏幕捕获失败：${err?.message || err}`)
  }
  if (!firstBuf || firstBuf.byteLength === 0) {
    signal('rc:error', { sessionId, code: 'capture_failed', message: '屏幕捕获失败（无法访问桌面画面）' })
    cleanup(false)
    return
  }

  const firstBitmap = await decodeFrame(firstBuf)
  if (!firstBitmap) {
    log('error', '首帧解码失败')
    signal('rc:error', { sessionId, code: 'capture_failed', message: '屏幕捕获失败（首帧解码失败）' })
    cleanup(false)
    return
  }
  const canvas = document.createElement('canvas')
  // alpha:false lets the compositor skip blending (frames are opaque);
  // desynchronized trims canvas→captureStream latency.
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
  if (!ctx) {
    firstBitmap.close()
    signal('rc:error', { sessionId, code: 'capture_failed', message: '屏幕捕获失败（canvas 不可用）' })
    cleanup(false)
    return
  }
  canvas.width = firstBitmap.width
  canvas.height = firstBitmap.height
  ctx.drawImage(firstBitmap, 0, 0)
  firstBitmap.close()
  rcCanvas = canvas
  rcCtx = ctx

  const width = canvas.width
  const height = canvas.height
  // captureStream samples the canvas as we repaint it; start the paced loop that
  // keeps drawing fresh native frames into it.
  rcStream = canvas.captureStream(CAPTURE_FPS)
  // contentHint 'detail' tells the WebRTC encoder this is a screen/text source:
  // preserve spatial sharpness over motion smoothness (the default camera-motion
  // heuristic smears static text — the main cause of the "blurry" complaint).
  for (const track of rcStream.getVideoTracks()) track.contentHint = 'detail'
  rcCapturing = true
  scheduleCapture()
  log('info', `已捕获主屏 ${width}×${height}（原生捕获，无屏幕共享），建立 WebRTC 连接中…`)

  const connection = new RTCPeerConnection({ iceServers: RC_ICE_SERVERS })
  rcPc = connection
  connection.onicecandidate = (event) => {
    if (event.candidate) signal('rc:ice', { sessionId: rcSessionId, candidate: event.candidate.toJSON() })
  }
  connection.onconnectionstatechange = () => {
    const state = connection.connectionState
    log(state === 'failed' ? 'warn' : 'info', `WebRTC 连接状态：${state}`)
    if (state === 'failed' || state === 'disconnected' || state === 'closed') cleanup(true)
  }

  const activeStream = rcStream
  activeStream.getTracks().forEach(t => connection.addTrack(t, activeStream))
  await tuneVideoEncoder(connection)

  // The desktop owns the control channel; the browser sends input on it.
  const channel = connection.createDataChannel('control')
  channel.onopen = () => log('info', '控制通道已打开，等待鼠标/键盘输入')
  channel.onmessage = (event) => {
    if (!inputSeen) {
      inputSeen = true
      log('info', '已收到远程控制输入，开始注入鼠标/键盘')
    }
    let payload: Record<string, any>
    try {
      payload = JSON.parse(String(event.data))
    } catch {
      return // ignore malformed input frames
    }
    // Fire-and-forget: a bad event must not tear down the session.
    void native.rcInjectInput(payload).catch(() => {})
  }

  signal('rc:ready', { sessionId: rcSessionId, width, height, rotation: 0 })

  const offer = await connection.createOffer()
  await connection.setLocalDescription(offer)
  signal('rc:offer', { sessionId: rcSessionId, sdp: offer.sdp })
}

/**
 * One inbound signaling message from the controller (via the agent socket).
 * ``send`` emits back on that same socket; ``logger`` surfaces diagnostics in
 * the desktop app's activity log.
 */
export async function handleRemoteControlSignal(
  event: string,
  data: any,
  send: SignalSender,
  logger?: RcLogger,
): Promise<void> {
  const sessionId = String(data?.sessionId || '')
  if (!sessionId) return
  rcSend = send
  if (logger) rcLog = logger

  if (event === 'rc:start') {
    await rcStartSession(sessionId)
    return
  }
  // Everything else targets the live session only.
  if (sessionId !== rcSessionId || !rcPc) return

  if (event === 'rc:answer') {
    await rcPc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
    for (const candidate of rcPendingIce.splice(0)) {
      await rcPc.addIceCandidate(candidate).catch(() => {})
    }
  } else if (event === 'rc:ice') {
    if (!data.candidate) return
    if (rcPc.remoteDescription) await rcPc.addIceCandidate(data.candidate).catch(() => {})
    else rcPendingIce.push(data.candidate)
  } else if (event === 'rc:stop') {
    cleanup(false)
  }
}

/** The agent socket dropped — tear down the session and stop capturing. */
export function handleRemoteControlDisconnect(): void {
  cleanup(false)
}
