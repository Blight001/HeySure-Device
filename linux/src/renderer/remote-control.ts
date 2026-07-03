// Headless WebRTC peer for desktop remote control. Runs in a hidden renderer
// because getUserMedia / RTCPeerConnection are renderer-only. The desktop is the
// **offerer**: it captures the primary screen into a video track, opens a
// ``control`` DataChannel for inbound pointer/keyboard events, and offers; the
// browser answers. Media + input then flow peer-to-peer.
//
// All signaling crosses to the main process over the ``heysureRC`` preload
// bridge, which relays it to the controller over the agent's Socket.IO socket.
//
// NOTE: this is a plain <script> (module: commonjs would emit `exports` and
// crash in the browser), so it uses no import/export — matching offline-chat.ts.

type RcStartPayload = { sessionId: string; sourceId: string; width: number; height: number }
type RcSdpPayload = { sessionId: string; sdp: string }
type RcIcePayload = { sessionId: string; candidate: RTCIceCandidateInit }

const rc = (window as any).heysureRC as {
  onStart(cb: (data: RcStartPayload) => void): void
  onAnswer(cb: (data: RcSdpPayload) => void): void
  onIce(cb: (data: RcIcePayload) => void): void
  onStop(cb: (data: { sessionId: string }) => void): void
  signal(event: string, payload: any): void
  input(payload: any): void
  debug(status: string, message: string, data?: any): void
}

let inputSeen = false

const RC_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

let rcPc: RTCPeerConnection | null = null
let rcStream: MediaStream | null = null
let rcSessionId = ''
const rcPendingIce: RTCIceCandidateInit[] = []

function rcCleanup(notifyStopped: boolean): void {
  if (notifyStopped && rcSessionId) rc.signal('rc:stopped', { sessionId: rcSessionId })
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
}

async function rcStart(data: RcStartPayload): Promise<void> {
  // A new start while one is live replaces it (single operator per desktop).
  if (rcPc) rcCleanup(false)
  rcSessionId = data.sessionId

  try {
    rcStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // Electron desktop-capture constraints (legacy mandatory form).
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: data.sourceId,
          maxWidth: data.width,
          maxHeight: data.height,
          maxFrameRate: 30,
        },
      } as unknown as MediaTrackConstraints,
    })
  } catch (err: any) {
    rc.debug('error', `屏幕捕获失败：${err?.message || err}`)
    rc.signal('rc:error', { sessionId: rcSessionId, code: 'capture_failed', message: err?.message || '屏幕捕获失败' })
    rcCleanup(false)
    return
  }
  rc.debug('info', '已捕获屏幕，建立 WebRTC 连接中…')

  const connection = new RTCPeerConnection({ iceServers: RC_ICE_SERVERS })
  rcPc = connection
  connection.onicecandidate = (event) => {
    if (event.candidate) rc.signal('rc:ice', { sessionId: rcSessionId, candidate: event.candidate.toJSON() })
  }
  connection.onconnectionstatechange = () => {
    const state = connection.connectionState
    rc.debug(state === 'connected' ? 'success' : 'info', `WebRTC 连接状态：${state}`)
    if (state === 'failed' || state === 'disconnected' || state === 'closed') rcCleanup(true)
  }

  const activeStream = rcStream
  activeStream.getTracks().forEach(track => connection.addTrack(track, activeStream))

  // The desktop owns the control channel; the browser sends input on it.
  const channel = connection.createDataChannel('control')
  channel.onopen = () => rc.debug('success', '控制通道已打开，等待鼠标/键盘输入')
  channel.onmessage = (event) => {
    if (!inputSeen) {
      inputSeen = true
      rc.debug('success', '已收到浏览器输入事件')
    }
    try {
      rc.input(JSON.parse(String(event.data)))
    } catch {
      // ignore malformed input frames
    }
  }

  rc.signal('rc:ready', { sessionId: rcSessionId, width: data.width, height: data.height, rotation: 0 })

  const offer = await connection.createOffer()
  await connection.setLocalDescription(offer)
  rc.signal('rc:offer', { sessionId: rcSessionId, sdp: offer.sdp })
}

rc.onStart((data) => { void rcStart(data) })

rc.onAnswer(async (data) => {
  if (!rcPc || data.sessionId !== rcSessionId) return
  await rcPc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
  for (const candidate of rcPendingIce.splice(0)) {
    await rcPc.addIceCandidate(candidate).catch(() => {})
  }
})

rc.onIce(async (data) => {
  if (!rcPc || data.sessionId !== rcSessionId || !data.candidate) return
  if (rcPc.remoteDescription) await rcPc.addIceCandidate(data.candidate).catch(() => {})
  else rcPendingIce.push(data.candidate)
})

rc.onStop(() => { rcCleanup(false) })
