package ai.heysure.agent.agent

import ai.heysure.agent.executor.TaskExecutor
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.net.URISyntaxException

enum class DeviceStatus { DISCONNECTED, CONNECTING, CONNECTED, REGISTERED, ERROR }

/**
 * Android counterpart of the desktop shell's `HeySureAgent` (device.ts):
 *  - opens a Socket.IO connection to the connector runtime,
 *  - emits `device:register` (platform="android-mobile", isAndroid=true),
 *  - executes each `task:dispatch` and replies with task:result / task:error.
 *
 * Idempotency on taskId mirrors the desktop client so duplicate dispatches
 * replay the cached outcome instead of re-running a gesture.
 *
 * Reconnect policy: while [wantConnected] is true (after [connect], until
 * intentional [disconnect]/[shutdown]), a health poll keeps kicking the
 * socket forever. Socket.IO does not auto-retry "io server disconnect"
 * (server restart/deploy), so we handle that explicitly plus a watchdog.
 */
class SocketAgent(
    private val settings: Settings,
    private val executor: TaskExecutor,
    private val toolDefs: () -> JSONArray,
    private val capabilities: () -> List<String>,
    private val onToolConfig: (JSONObject) -> Boolean,
    private val onStatus: (DeviceStatus, String?) -> Unit,
    private val onLog: (String) -> Unit,
    private val onRcSignal: (event: String, data: JSONObject) -> Unit = { _, _ -> },
) {
    private var socket: Socket? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var wantConnected = false
    private var healthWatchRunning = false

    // Bounded, access-ordered LRU of task ids we've already accepted. A plain
    // growing set leaked memory over a long-lived session; this caps it while
    // still ignoring duplicate dispatches (idempotent replay guard).
    private val seenTasks = object : LinkedHashMap<String, Boolean>(MAX_SEEN_TASKS, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>?): Boolean =
            size > MAX_SEEN_TASKS
    }

    private val healthWatch = object : Runnable {
        override fun run() {
            if (!wantConnected) {
                healthWatchRunning = false
                return
            }
            try {
                nudgeConnection()
            } catch (err: Exception) {
                onLog("健康轮询异常: ${err.message ?: err}")
            }
            mainHandler.postDelayed(this, HEALTH_WATCH_MS)
        }
    }

    fun connect() {
        val token = settings.authToken
        if (token.isBlank()) {
            wantConnected = false
            stopHealthWatch()
            onStatus(DeviceStatus.DISCONNECTED, "未登录")
            return
        }
        wantConnected = true
        startHealthWatch()
        if (socket != null) {
            nudgeConnection()
            return
        }
        openSocket()
    }

    private fun startHealthWatch() {
        if (healthWatchRunning) return
        healthWatchRunning = true
        mainHandler.removeCallbacks(healthWatch)
        mainHandler.postDelayed(healthWatch, HEALTH_WATCH_MS)
    }

    private fun stopHealthWatch() {
        healthWatchRunning = false
        mainHandler.removeCallbacks(healthWatch)
    }

    /** Kick a dead socket; recreate if the object is gone. Never stops while wantConnected. */
    private fun nudgeConnection() {
        if (!wantConnected) return
        if (settings.authToken.isBlank()) return
        val s = socket
        if (s == null) {
            openSocket()
            return
        }
        // Java client: !connected after server restart may leave the manager idle.
        if (!s.connected()) {
            try {
                s.connect()
            } catch (err: Exception) {
                onLog("重连触发失败，将重建连接: ${err.message ?: err}")
                teardownSocketOnly()
                openSocket()
            }
        }
    }

    private fun teardownSocketOnly() {
        try {
            socket?.off()
            socket?.disconnect()
        } catch (_: Exception) { /* noop */ }
        socket = null
    }

    private fun openSocket() {
        if (socket != null) return
        if (!wantConnected || settings.authToken.isBlank()) return

        onStatus(DeviceStatus.CONNECTING, null)
        val opts = IO.Options().apply {
            transports = arrayOf("websocket", "polling")
            reconnection = true
            reconnectionDelay = 2000
            reconnectionDelayMax = 15000
            reconnectionAttempts = Int.MAX_VALUE
        }
        val s = try {
            IO.socket(settings.agentSocketUrl, opts)
        } catch (e: URISyntaxException) {
            onStatus(DeviceStatus.ERROR, "Agent 连接地址无效")
            return
        }
        socket = s

        s.on(Socket.EVENT_CONNECT) {
            onStatus(DeviceStatus.CONNECTED, null)
            onLog("已连接到服务器")
            register()
        }
        s.on(Socket.EVENT_DISCONNECT) { args ->
            val reason = args.firstOrNull()?.toString() ?: ""
            onStatus(DeviceStatus.DISCONNECTED, reason)
            onLog("连接断开: $reason")
            // "io server disconnect" (deploy/restart) does not auto-retry.
            if (wantConnected && reason != "io client disconnect") {
                if (reason == "io server disconnect" || reason.isBlank()) {
                    mainHandler.postDelayed({
                        if (wantConnected) nudgeConnection()
                    }, 1500)
                }
            }
        }
        s.on(Socket.EVENT_CONNECT_ERROR) { args ->
            onStatus(DeviceStatus.ERROR, args.firstOrNull()?.toString())
            onLog("连接错误: ${args.firstOrNull()}")
            // Health watch keeps polling; no permanent stop.
        }
        s.on("device:registered") { _ ->
            onStatus(DeviceStatus.REGISTERED, null)
            onLog("注册成功")
        }
        s.on("device:tool-config") { args ->
            val payload = args.firstOrNull() as? JSONObject ?: return@on
            val changed = runCatching { onToolConfig(payload) }.getOrElse { err ->
                onLog("动态 MCP 配置失败: ${err.message ?: err}")
                false
            }
            if (changed) {
                val count = payload.optJSONArray("tools")?.length() ?: 0
                onLog("已同步动态 MCP：$count 个工具")
                register()
            }
        }
        s.on("device:register_rejected") { args ->
            val reason = (args.firstOrNull() as? JSONObject)?.optString("reason") ?: "注册被拒绝"
            onStatus(DeviceStatus.ERROR, reason)
            onLog("注册失败: $reason（保持重连轮询）")
            // Do not stop the health watch — server may recover after redeploy.
        }
        s.on("task:dispatch") { args ->
            val task = args.firstOrNull() as? JSONObject ?: return@on
            scope.launch { handleTask(task) }
        }
        // Remote-control WebRTC signaling (controller → device). The handful of
        // SDP/ICE messages are forwarded to the RemoteControlManager; media and
        // input then flow peer-to-peer, off the socket.
        for (event in RC_SIGNAL_EVENTS) {
            s.on(event) { args ->
                val payload = args.firstOrNull() as? JSONObject ?: JSONObject()
                onRcSignal(event, payload)
            }
        }
        s.connect()
    }

    /** Emit one outbound remote-control signaling message (device → controller):
     *  rc:offer / rc:ice / rc:ready / rc:error / rc:stopped. */
    fun emitSignal(event: String, payload: JSONObject) {
        socket?.emit(event, payload)
    }

    fun disconnect() {
        wantConnected = false
        stopHealthWatch()
        teardownSocketOnly()
        onStatus(DeviceStatus.DISCONNECTED, null)
    }

    fun shutdown() {
        disconnect()
        scope.cancel()
    }

    private fun register() {
        val payload = JSONObject().apply {
            put("id", settings.deviceId)
            put("name", settings.agentName.ifBlank { settings.userName.ifBlank { Build.MODEL } })
            put("group", "")
            put("platform", "android-mobile (${Build.MODEL})")
            put("os", "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            put("capabilities", JSONArray(capabilities()))
            put("toolDefs", toolDefs())
            put("version", "2.0.0")
            put("token", settings.authToken)
            put("lifecycle", "registered")
            // Server classifies this as a mobile endpoint; routing treats it as a
            // desktop-class endpoint (see desktop_device_tools.device_type_of).
            put("isAndroid", true)
            put("aiConfigId", JSONObject.NULL)
            put("userId", if (settings.userId > 0) settings.userId else JSONObject.NULL)
        }
        onLog("注册 agent（AI 由服务器作坊分配）")
        socket?.emit("device:register", payload)
    }

    private suspend fun handleTask(task: JSONObject) {
        val taskId = task.optString("taskId")
        if (taskId.isBlank()) return
        // Reserve the id up-front (under lock) so two near-simultaneous dispatches
        // of the same task can't both slip past and replay a gesture. The previous
        // check-then-add-after-run window was racy.
        synchronized(seenTasks) {
            if (seenTasks.containsKey(taskId)) return
            seenTasks[taskId] = true
        }

        val tool = task.optString("tool")
        val args = task.optJSONObject("args") ?: JSONObject()
        val allowed = task.optJSONArray("allowedTools")?.let { arr ->
            (0 until arr.length()).map { arr.getString(it) }
        }
        onLog("任务[$taskId] 开始: $tool")
        socket?.emit("task:progress", JSONObject()
            .put("taskId", taskId).put("progress", 0).put("message", "开始执行 $tool…"))

        val outcome = executor.execute(tool, args, allowed)

        if (outcome.success) {
            socket?.emit("task:result", JSONObject()
                .put("taskId", taskId)
                .put("userId", task.opt("userId"))
                .put("aiConfigId", task.opt("aiConfigId"))
                .put("sessionId", task.opt("sessionId"))
                .put("tool", outcome.tool)
                .put("success", true)
                .put("result", outcome.result)
                .put("summary", outcome.summary))
            onLog("任务[$taskId] 完成")
        } else {
            socket?.emit("task:error", JSONObject()
                .put("taskId", taskId)
                .put("userId", task.opt("userId"))
                .put("error", outcome.summary))
            onLog("任务[$taskId] 失败: ${outcome.summary}")
        }
    }

    private companion object {
        const val MAX_SEEN_TASKS = 500
        const val HEALTH_WATCH_MS = 5000L
        val RC_SIGNAL_EVENTS = listOf("rc:start", "rc:answer", "rc:ice", "rc:stop")
    }
}
