package ai.heysure.agent.remote

import ai.heysure.agent.accessibility.GestureAccessibilityService
import ai.heysure.agent.capture.ScreenCaptureManager
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.graphics.Path
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.view.Display
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

/**
 * One live remote-control link. The device is the **offerer**: it captures the
 * screen into a WebRTC video track, opens a ``control`` DataChannel for inbound
 * pointer/key events, creates the SDP offer, and trickles ICE. The browser
 * answers. Media and input then flow peer-to-peer — the server only carried the
 * handshake.
 *
 * Input coordinates arrive normalized to [0,1] of the live screen so the web
 * never needs the device's pixel dimensions; we scale by the real display size
 * (not the possibly down-scaled stream size) before injecting the gesture.
 */
class RemoteControlSession(
    val sessionId: String,
    private val appContext: Context,
    private val factory: PeerConnectionFactory,
    private val eglBase: EglBase,
    private val capture: ScreenCaptureManager,
    private val iceServers: List<PeerConnection.IceServer>,
    private val scope: CoroutineScope,
    private val sendSignal: (event: String, payload: JSONObject) -> Unit,
    private val onClosed: (sessionId: String, reason: String) -> Unit,
) {
    private var pc: PeerConnection? = null
    private var capturer: SharedProjectionCapturer? = null
    private var surfaceHelper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var dataChannel: DataChannel? = null
    private val pendingRemoteIce = mutableListOf<IceCandidate>()
    @Volatile
    private var remoteDescriptionSet = false
    private var closed = false
    private val inputMutex = Mutex()
    private var activeDragStroke: GestureDescription.StrokeDescription? = null
    private var activeDragX = 0f
    private var activeDragY = 0f

    // Live physical display size. Mutable because it swaps on rotation, and input
    // scaling (handleInput) must use the *current* dimensions, not the ones from
    // session start. Volatile: written on the display-listener thread, read on the
    // input coroutine.
    @Volatile
    private var realW = 0
    @Volatile
    private var realH = 0
    private val mainHandler = Handler(Looper.getMainLooper())
    private var displayManager: DisplayManager? = null
    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) {
            if (displayId == Display.DEFAULT_DISPLAY) handleRotation()
        }
    }

    fun start() {
        val projection = capture.activeProjection()
        if (projection == null) {
            fail("needs_projection", "未授权截屏：请先在 App 内点击\"授权截屏/录屏\"")
            return
        }
        realW = capture.displayWidthPx()
        realH = capture.displayHeightPx()
        val dpi = capture.displayDensityDpi()
        val (streamW, streamH) = scaledStreamSize(realW, realH)

        val helper = SurfaceTextureHelper.create("rc-$sessionId", eglBase.eglBaseContext)
        surfaceHelper = helper
        val source = factory.createVideoSource(/* isScreencast = */ true)
        videoSource = source
        val cap = SharedProjectionCapturer(projection, dpi)
        capturer = cap
        cap.initialize(helper, appContext, source.capturerObserver)
        cap.startCapture(streamW, streamH, TARGET_FPS)
        val track = factory.createVideoTrack("rc-video", source)
        track.setEnabled(true)
        videoTrack = track

        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy =
                PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        val connection = factory.createPeerConnection(config, pcObserver) ?: run {
            fail("pc_failed", "无法创建 WebRTC 连接")
            return
        }
        pc = connection
        connection.addTrack(track, listOf("rc-stream"))
        dataChannel = connection.createDataChannel("control", DataChannel.Init()).also {
            it.registerObserver(makeChannelObserver())
        }

        // Follow device rotation: resize the mirror so the stream (and the
        // operator's window) tracks the live orientation instead of letterboxing.
        (appContext.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager)?.let {
            displayManager = it
            it.registerDisplayListener(displayListener, mainHandler)
        }

        // Tell the operator the geometry up-front so the canvas can size itself
        // even before the first frame paints.
        sendSignal("rc:ready", JSONObject()
            .put("sessionId", sessionId)
            .put("width", realW)
            .put("height", realH)
            .put("rotation", 0))

        createOffer(connection)
    }

    /** Device rotated (or the display geometry otherwise changed): resize the
     *  mirror to the new physical size and tell the operator so the floating
     *  window re-shapes between portrait and landscape. */
    private fun handleRotation() {
        if (closed) return
        val newW = capture.displayWidthPx()
        val newH = capture.displayHeightPx()
        if (newW <= 0 || newH <= 0 || (newW == realW && newH == realH)) return
        realW = newW
        realH = newH
        val (streamW, streamH) = scaledStreamSize(newW, newH)
        capturer?.resize(streamW, streamH)
        sendSignal("rc:ready", JSONObject()
            .put("sessionId", sessionId)
            .put("width", newW)
            .put("height", newH)
            .put("rotation", 0))
    }

    fun onAnswer(sdp: String?) {
        val connection = pc ?: return
        if (sdp.isNullOrBlank()) return
        connection.setRemoteDescription(
            object : NoopSdpObserver() {
                override fun onSetSuccess() {
                    val queued = synchronized(pendingRemoteIce) {
                        remoteDescriptionSet = true
                        pendingRemoteIce.toList().also { pendingRemoteIce.clear() }
                    }
                    queued.forEach { candidate ->
                        if (!connection.addIceCandidate(candidate)) {
                            reportError("ice_add_failed", "添加排队的远端 ICE 候选失败")
                        }
                    }
                }

                override fun onSetFailure(error: String?) {
                    fail("answer_failed", "设置远端 SDP answer 失败：${error ?: "unknown"}")
                }
            },
            SessionDescription(SessionDescription.Type.ANSWER, sdp),
        )
    }

    fun onRemoteIce(candidate: JSONObject?) {
        val connection = pc ?: return
        candidate ?: return
        val sdp = candidate.optString("candidate")
        if (sdp.isBlank()) return
        val ice = IceCandidate(
            candidate.optString("sdpMid"),
            candidate.optInt("sdpMLineIndex"),
            sdp,
        )
        synchronized(pendingRemoteIce) {
            if (!remoteDescriptionSet) {
                pendingRemoteIce.add(ice)
                return
            }
        }
        if (!connection.addIceCandidate(ice)) {
            reportError("ice_add_failed", "添加远端 ICE 候选失败")
        }
    }

    fun close(reason: String, notifyPeer: Boolean) {
        if (closed) return
        closed = true
        runCatching { displayManager?.unregisterDisplayListener(displayListener) }
        displayManager = null
        runCatching { dataChannel?.unregisterObserver() }
        runCatching { dataChannel?.close() }
        runCatching { capturer?.stopCapture() }
        runCatching { capturer?.dispose() }
        runCatching { surfaceHelper?.dispose() }
        runCatching { videoTrack?.dispose() }
        runCatching { videoSource?.dispose() }
        runCatching { pc?.dispose() }
        activeDragStroke = null
        synchronized(pendingRemoteIce) {
            pendingRemoteIce.clear()
            remoteDescriptionSet = false
        }
        pc = null
        if (notifyPeer) {
            sendSignal("rc:stopped", JSONObject().put("sessionId", sessionId).put("reason", reason))
        }
        onClosed(sessionId, reason)
    }

    private fun fail(code: String, message: String) {
        reportError(code, message)
        close(code, notifyPeer = false)
    }

    private fun reportError(code: String, message: String) {
        sendSignal("rc:error", JSONObject()
            .put("sessionId", sessionId).put("code", code).put("message", message))
    }

    private fun createOffer(connection: PeerConnection) {
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
        }
        connection.createOffer(object : NoopSdpObserver() {
            override fun onCreateSuccess(desc: SessionDescription) {
                connection.setLocalDescription(object : NoopSdpObserver() {
                    override fun onSetSuccess() {
                        sendSignal("rc:offer", JSONObject()
                            .put("sessionId", sessionId)
                            .put("sdp", desc.description))
                    }

                    override fun onSetFailure(error: String?) {
                        fail("offer_set_failed", "设置本地 SDP offer 失败：${error ?: "unknown"}")
                    }
                }, desc)
            }

            override fun onCreateFailure(error: String?) {
                fail("offer_create_failed", "创建 SDP offer 失败：${error ?: "unknown"}")
            }
        }, constraints)
    }

    private val pcObserver = object : SimplePeerConnectionObserver() {
        override fun onIceCandidate(candidate: IceCandidate) {
            sendSignal("rc:ice", JSONObject()
                .put("sessionId", sessionId)
                .put("candidate", JSONObject()
                    .put("candidate", candidate.sdp)
                    .put("sdpMid", candidate.sdpMid)
                    .put("sdpMLineIndex", candidate.sdpMLineIndex)))
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            if (state == PeerConnection.IceConnectionState.FAILED ||
                state == PeerConnection.IceConnectionState.CLOSED
            ) {
                close("ice_$state", notifyPeer = true)
            }
        }
    }

    private fun makeChannelObserver() =
        object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {}
            override fun onMessage(buffer: DataChannel.Buffer) {
                val data = buffer.data
                val bytes = ByteArray(data.remaining())
                data.get(bytes)
                val text = String(bytes, StandardCharsets.UTF_8)
                val json = runCatching { JSONObject(text) }.getOrNull() ?: return
                scope.launch { inputMutex.withLock { handleInput(json) } }
            }
        }

    /** Translate one normalized input event into an injected gesture. Reads the
     *  live realW/realH so coordinates stay correct across rotation. */
    private suspend fun handleInput(json: JSONObject) {
        val service = GestureAccessibilityService.instance ?: return
        fun px(key: String, span: Int, default: Double = 0.0) =
            (json.optDouble(key, default) * span)
                .coerceIn(0.0, (span - 1).coerceAtLeast(1).toDouble())
                .toFloat()
        when (json.optString("type")) {
            "tap" -> {
                val x = px("x", realW); val y = px("y", realH)
                service.showTapEffect(x, y)
                service.dispatch(Path().apply { moveTo(x, y) }, 0, 60)
            }
            "long_press" -> {
                val x = px("x", realW); val y = px("y", realH)
                val dur = json.optLong("durationMs", 600)
                service.showTapEffect(x, y)
                service.dispatch(Path().apply { moveTo(x, y) }, 0, dur)
            }
            "swipe" -> {
                val x1 = px("x", realW); val y1 = px("y", realH)
                val x2 = px("x2", realW); val y2 = px("y2", realH)
                val dur = json.optLong("durationMs", 300)
                service.showDragEffect(x1, y1, x2, y2, dur)
                service.dispatch(Path().apply { moveTo(x1, y1); lineTo(x2, y2) }, 0, dur)
            }
            "down" -> {
                val x = px("x", realW); val y = px("y", realH)
                startDrag(service, x, y)
            }
            "move" -> {
                val x = px("x", realW); val y = px("y", realH)
                continueDrag(
                    service,
                    x,
                    y,
                    json.optLong("durationMs", DRAG_MOVE_MS).coerceIn(16L, 180L),
                    willContinue = true,
                )
            }
            "up" -> {
                val x = px("x", realW, activeDragX.toDouble() / realW)
                val y = px("y", realH, activeDragY.toDouble() / realH)
                continueDrag(service, x, y, DRAG_UP_MS, willContinue = false)
            }
            "scroll" -> {
                val dy = json.optDouble("dy", 0.0)
                if (kotlin.math.abs(dy) >= 1.0) {
                    val x = px("x", realW, 0.5)
                    val y = px("y", realH, 0.5)
                    val travel = (kotlin.math.abs(dy).toFloat() / 700f)
                        .coerceIn(0.10f, 0.36f) * realH
                    val fingerDirection = if (dy > 0) -1f else 1f
                    val y1 = (y - fingerDirection * travel / 2f).coerceIn(realH * 0.05f, realH * 0.95f)
                    val y2 = (y + fingerDirection * travel / 2f).coerceIn(realH * 0.05f, realH * 0.95f)
                    val dur = (160 + travel / realH * 260).toLong().coerceIn(160L, 320L)
                    service.showDragEffect(x, y1, x, y2, dur)
                    service.dispatch(Path().apply { moveTo(x, y1); lineTo(x, y2) }, 0, dur)
                }
            }
            "key" -> when (json.optString("key")) {
                "back" -> service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
                "home" -> { service.showHomeEffect(); service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME) }
                "recents" -> service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_RECENTS)
            }
            "text" -> service.typeIntoFocused(json.optString("text"))
        }
    }

    private suspend fun startDrag(
        service: GestureAccessibilityService,
        x: Float,
        y: Float,
    ) {
        activeDragX = x
        activeDragY = y
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, DRAG_DOWN_MS, true)
        activeDragStroke = if (service.dispatchStroke(stroke, DRAG_DOWN_MS)) stroke else null
        service.showTapEffect(x, y)
    }

    private suspend fun continueDrag(
        service: GestureAccessibilityService,
        x: Float,
        y: Float,
        durationMs: Long,
        willContinue: Boolean,
    ) {
        val previous = activeDragStroke ?: return
        val path = Path().apply {
            moveTo(activeDragX, activeDragY)
            lineTo(x, y)
        }
        val next = previous.continueStroke(path, 0, durationMs.coerceAtLeast(1), willContinue)
        val ok = service.dispatchStroke(next, durationMs)
        activeDragX = x
        activeDragY = y
        activeDragStroke = if (willContinue && ok) next else null
    }

    private fun scaledStreamSize(width: Int, height: Int): Pair<Int, Int> {
        val longest = maxOf(width, height)
        if (longest <= MAX_STREAM_SIDE) return even(width) to even(height)
        val scale = MAX_STREAM_SIDE.toFloat() / longest
        return even((width * scale).toInt()) to even((height * scale).toInt())
    }

    private fun even(value: Int): Int = value.coerceAtLeast(2).let { if (it % 2 == 0) it else it - 1 }

    private companion object {
        const val TARGET_FPS = 30
        const val MAX_STREAM_SIDE = 1280
        const val DRAG_DOWN_MS = 80L
        const val DRAG_MOVE_MS = 55L
        const val DRAG_UP_MS = 36L
    }
}
