package ai.heysure.agent.remote

import ai.heysure.agent.accessibility.GestureAccessibilityService
import ai.heysure.agent.capture.ScreenCaptureManager
import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Path
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
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
    private var closed = false

    fun start() {
        val projection = capture.activeProjection()
        if (projection == null) {
            fail("needs_projection", "未授权截屏：请先在 App 内点击\"授权截屏/录屏\"")
            return
        }
        val realW = capture.displayWidthPx()
        val realH = capture.displayHeightPx()
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
            it.registerObserver(makeChannelObserver(it, realW, realH))
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

    fun onAnswer(sdp: String?) {
        val connection = pc ?: return
        if (sdp.isNullOrBlank()) return
        connection.setRemoteDescription(
            object : NoopSdpObserver() {},
            SessionDescription(SessionDescription.Type.ANSWER, sdp),
        )
    }

    fun onRemoteIce(candidate: JSONObject?) {
        val connection = pc ?: return
        candidate ?: return
        val sdp = candidate.optString("candidate")
        if (sdp.isBlank()) return
        connection.addIceCandidate(
            IceCandidate(
                candidate.optString("sdpMid"),
                candidate.optInt("sdpMLineIndex"),
                sdp,
            ),
        )
    }

    fun close(reason: String, notifyPeer: Boolean) {
        if (closed) return
        closed = true
        runCatching { dataChannel?.unregisterObserver() }
        runCatching { dataChannel?.close() }
        runCatching { capturer?.stopCapture() }
        runCatching { capturer?.dispose() }
        runCatching { surfaceHelper?.dispose() }
        runCatching { videoTrack?.dispose() }
        runCatching { videoSource?.dispose() }
        runCatching { pc?.dispose() }
        pc = null
        if (notifyPeer) {
            sendSignal("rc:stopped", JSONObject().put("sessionId", sessionId).put("reason", reason))
        }
        onClosed(sessionId, reason)
    }

    private fun fail(code: String, message: String) {
        sendSignal("rc:error", JSONObject()
            .put("sessionId", sessionId).put("code", code).put("message", message))
        close(code, notifyPeer = false)
    }

    private fun createOffer(connection: PeerConnection) {
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
        }
        connection.createOffer(object : NoopSdpObserver() {
            override fun onCreateSuccess(desc: SessionDescription) {
                connection.setLocalDescription(object : NoopSdpObserver() {}, desc)
                sendSignal("rc:offer", JSONObject()
                    .put("sessionId", sessionId)
                    .put("sdp", desc.description))
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

    private fun makeChannelObserver(channel: DataChannel, realW: Int, realH: Int) =
        object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {}
            override fun onMessage(buffer: DataChannel.Buffer) {
                val data = buffer.data
                val bytes = ByteArray(data.remaining())
                data.get(bytes)
                val text = String(bytes, StandardCharsets.UTF_8)
                val json = runCatching { JSONObject(text) }.getOrNull() ?: return
                scope.launch { handleInput(json, realW, realH) }
            }
        }

    /** Translate one normalized input event into an injected gesture. */
    private suspend fun handleInput(json: JSONObject, realW: Int, realH: Int) {
        val service = GestureAccessibilityService.instance ?: return
        fun px(key: String, span: Int) = (json.optDouble(key, 0.0) * span).toFloat()
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
            "key" -> when (json.optString("key")) {
                "back" -> service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
                "home" -> { service.showHomeEffect(); service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME) }
                "recents" -> service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_RECENTS)
            }
            "text" -> service.typeIntoFocused(json.optString("text"))
        }
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
    }
}
