package ai.heysure.agent.agent

import ai.heysure.agent.executor.TaskExecutor
import android.os.Build
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
 */
class SocketAgent(
    private val settings: Settings,
    private val executor: TaskExecutor,
    private val toolDefs: () -> JSONArray,
    private val capabilities: () -> List<String>,
    private val onToolConfig: (JSONObject) -> Boolean,
    private val onStatus: (DeviceStatus, String?) -> Unit,
    private val onLog: (String) -> Unit,
) {
    private var socket: Socket? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val finishedTasks = mutableSetOf<String>()

    fun connect() {
        if (socket != null) return
        val token = settings.authToken
        if (token.isBlank()) {
            onStatus(DeviceStatus.DISCONNECTED, "未登录")
            return
        }
        onStatus(DeviceStatus.CONNECTING, null)
        val opts = IO.Options().apply {
            transports = arrayOf("websocket", "polling")
            reconnection = true
            reconnectionDelay = 2000
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
            onStatus(DeviceStatus.DISCONNECTED, args.firstOrNull()?.toString())
            onLog("连接断开")
        }
        s.on(Socket.EVENT_CONNECT_ERROR) { args ->
            onStatus(DeviceStatus.ERROR, args.firstOrNull()?.toString())
            onLog("连接错误: ${args.firstOrNull()}")
        }
        s.on("device:registered") { args ->
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
            onLog("注册失败: $reason")
        }
        s.on("task:dispatch") { args ->
            val task = args.firstOrNull() as? JSONObject ?: return@on
            scope.launch { handleTask(task) }
        }
        s.connect()
    }

    fun disconnect() {
        socket?.disconnect()
        socket?.off()
        socket = null
        onStatus(DeviceStatus.DISCONNECTED, null)
    }

    fun shutdown() {
        disconnect()
        scope.cancel()
    }

    private fun register() {
        val payload = JSONObject().apply {
            put("id", settings.deviceId)
            put("name", settings.userName.ifBlank { Build.MODEL })
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
        if (taskId in finishedTasks) return  // idempotent replay guard

        val tool = task.optString("tool")
        val args = task.optJSONObject("args") ?: JSONObject()
        val allowed = task.optJSONArray("allowedTools")?.let { arr ->
            (0 until arr.length()).map { arr.getString(it) }
        }
        onLog("任务[$taskId] 开始: $tool")
        socket?.emit("task:progress", JSONObject()
            .put("taskId", taskId).put("progress", 0).put("message", "开始执行 $tool…"))

        val outcome = executor.execute(tool, args, allowed)
        finishedTasks.add(taskId)

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
}
