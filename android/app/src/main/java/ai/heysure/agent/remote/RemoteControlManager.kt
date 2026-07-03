package ai.heysure.agent.remote

import ai.heysure.agent.agent.ServerApi
import ai.heysure.agent.capture.ScreenCaptureManager
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory

/**
 * Owns the singleton WebRTC stack (PeerConnectionFactory + EglBase) and the set
 * of live [RemoteControlSession]s. The Android agent is the offerer for every
 * session; this routes the small signaling messages between the Socket.IO
 * transport ([ai.heysure.agent.agent.SocketAgent]) and the right session.
 *
 * Capability gate: only constructed/wired when the device advertises
 * ``remote_control``. Gestures still require the accessibility service and the
 * mirror still requires the MediaProjection grant — both surfaced as
 * ``rc:error`` to the operator if missing.
 */
class RemoteControlManager(
    private val appContext: Context,
    private val capture: ScreenCaptureManager,
    private val sendSignal: (event: String, payload: JSONObject) -> Unit,
    private val onLog: (String) -> Unit,
    // Server connection used to resolve the ICE (STUN/TURN) config; both read
    // lazily so they reflect the current login.
    private val serverUrl: () -> String = { "" },
    private val authToken: () -> String = { "" },
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val sessions = mutableMapOf<String, RemoteControlSession>()

    private var eglBase: EglBase? = null
    private var factory: PeerConnectionFactory? = null

    // Built-in STUN fallback (no relay). Replaced by [refreshIceServers] with the
    // server-configured STUN + optional TURN so control survives symmetric NAT.
    private val fallbackIceServers: List<PeerConnection.IceServer> = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
    )

    @Volatile
    private var iceServers: List<PeerConnection.IceServer> = fallbackIceServers

    init {
        refreshIceServers()
    }

    /** Fetch the server-configured ICE servers off-thread and cache them for the
     *  next session. Best-effort: on any failure the STUN fallback is kept. */
    fun refreshIceServers() {
        val base = serverUrl()
        val token = authToken()
        if (base.isBlank() || token.isBlank()) return
        scope.launch {
            val configs = ServerApi.getIceServers(base, token)
            if (configs.isEmpty()) return@launch
            iceServers = configs.map { c ->
                PeerConnection.IceServer.builder(c.urls).apply {
                    c.username?.let { setUsername(it) }
                    c.credential?.let { setPassword(it) }
                }.createIceServer()
            }
        }
    }

    @Synchronized
    private fun ensureFactory(): PeerConnectionFactory {
        factory?.let { return it }
        val egl = EglBase.create()
        eglBase = egl
        // Native init is process-global and must run exactly once.
        if (!nativeInitialized) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(appContext)
                    .createInitializationOptions(),
            )
            nativeInitialized = true
        }
        val built = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(
                DefaultVideoEncoderFactory(egl.eglBaseContext, /* enableIntelVp8 = */ true, /* enableH264HighProfile = */ true),
            )
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
        factory = built
        return built
    }

    /** Dispatch one inbound signaling message (rc:start / rc:answer / rc:ice /
     *  rc:stop). Called from the Socket.IO thread. */
    fun onSignal(event: String, data: JSONObject) {
        val sessionId = data.optString("sessionId")
        when (event) {
            "rc:start" -> startSession(sessionId)
            "rc:answer" -> sessions[sessionId]?.onAnswer(data.optString("sdp"))
            "rc:ice" -> sessions[sessionId]?.onRemoteIce(data.optJSONObject("candidate"))
            "rc:stop" -> sessions[sessionId]?.close("operator_stop", notifyPeer = false)
        }
    }

    @Synchronized
    private fun startSession(sessionId: String) {
        if (sessionId.isBlank() || sessions.containsKey(sessionId)) return
        onLog("远程控制会话开始：$sessionId")
        val session = RemoteControlSession(
            sessionId = sessionId,
            appContext = appContext,
            factory = ensureFactory(),
            eglBase = eglBase!!,
            capture = capture,
            iceServers = iceServers,
            scope = scope,
            sendSignal = sendSignal,
            onClosed = { id, reason ->
                synchronized(this) { sessions.remove(id) }
                onLog("远程控制会话结束：$id（$reason）")
            },
        )
        sessions[sessionId] = session
        session.start()
    }

    @Synchronized
    fun stopAll() {
        sessions.values.toList().forEach { it.close("agent_shutdown", notifyPeer = true) }
        sessions.clear()
    }

    fun shutdown() {
        stopAll()
        runCatching { factory?.dispose() }
        runCatching { eglBase?.release() }
        factory = null
        eglBase = null
        scope.cancel()
    }

    companion object {
        /** Advertised in device:register so the server gates remote control on
         *  it (mirrors ``remote_control.RC_CAPABILITY`` server-side). */
        const val CAPABILITY = "remote_control"

        @Volatile
        private var nativeInitialized = false
    }
}
