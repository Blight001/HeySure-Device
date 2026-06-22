package ai.heysure.agent.executor

import ai.heysure.agent.accessibility.GestureAccessibilityService
import ai.heysure.agent.capture.ScreenCaptureManager
import android.accessibilityservice.AccessibilityService
import android.graphics.Path
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Android endpoint's tool surface: tap / swipe / back-home-recents /
 * screenshot / record / type. Mirrors the desktop catalog's role — it both
 * advertises self-described schemas to the server and executes dispatched tasks.
 *
 * `screen.capture` returns a `dataUrl`, which the server's screenshot pipeline
 * auto-persists and forwards to the user (see device_dispatch `_SCREENSHOT_TOOLS`).
 */
class ToolCatalog(private val capture: ScreenCaptureManager) {

    private val builtinTools: Map<String, Tool> = buildList {
        add(tapTool())
        add(longPressTool())
        add(swipeTool())
        add(globalActionTool("touch.back", "返回上一页（系统返回键）", AccessibilityService.GLOBAL_ACTION_BACK))
        add(globalActionTool("touch.home", "回到桌面（系统 Home 键）", AccessibilityService.GLOBAL_ACTION_HOME, showHomeEffect = true))
        add(globalActionTool("touch.recents", "打开最近任务", AccessibilityService.GLOBAL_ACTION_RECENTS))
        add(typeTool())
        add(screenshotTool())
        add(recordTool())
    }.associateBy { it.name }
    private val dynamicTools = mutableMapOf<String, Tool>()
    private var dynamicRevision = ""

    private val tools: Map<String, Tool>
        get() = builtinTools + dynamicTools

    fun names(): List<String> = tools.keys.sorted()

    fun get(name: String): Tool? = tools[name]

    fun applyDynamicConfig(payload: JSONObject): Boolean {
        val revision = payload.optString("revision")
        if (revision.isNotBlank() && revision == dynamicRevision) return false
        val arr = payload.optJSONArray("tools") ?: JSONArray()
        val next = mutableMapOf<String, Tool>()
        for (i in 0 until arr.length()) {
            val raw = arr.optJSONObject(i) ?: continue
            val name = raw.optString("name").trim()
            val codeKind = raw.optString("code_kind", "program")
            if (name.isBlank() || codeKind != "program" || builtinTools.containsKey(name)) continue
            val description = raw.optString("description").trim().ifBlank { "Android 动态 MCP 工具：$name" }
            val inputSchema = raw.optJSONObject("input_schema") ?: objectSchema(JSONObject())
            val steps = raw.optJSONArray("code") ?: JSONArray()
            if (steps.length() == 0) continue
            next[name] = programTool(name, description, inputSchema, steps)
        }
        dynamicTools.clear()
        dynamicTools.putAll(next)
        dynamicRevision = revision
        return true
    }

    /** `toolDefs` payload for device:register, in the shape the server stores
     *  verbatim ({ name, description, input_schema, destructive }). */
    fun toolDefs(): JSONArray {
        val arr = JSONArray()
        for (name in names()) {
            val t = tools.getValue(name)
            arr.put(
                JSONObject()
                    .put("name", t.name)
                    .put("description", t.description)
                    .put("input_schema", t.inputSchema)
                    .put("destructive", t.destructive),
            )
        }
        return arr
    }

    private fun gesture() = GestureAccessibilityService.require()

    private fun programTool(toolName: String, desc: String, schema: JSONObject, steps: JSONArray) = object : Tool {
        override val name = toolName
        override val description = desc
        override val inputSchema = schema

        override suspend fun run(args: JSONObject): JSONObject {
            val vars = JSONObject()
            var last: Any? = JSONObject()
            for (i in 0 until steps.length()) {
                val step = steps.optJSONObject(i) ?: continue
                when (step.optString("op")) {
                    "set" -> {
                        val key = step.optString("name").trim()
                        if (key.isNotBlank()) vars.put(key, evalValue(step.opt("value"), args, vars, last))
                    }
                    "return" -> {
                        val value = evalValue(step.opt("value"), args, vars, last)
                        return asResultObject(value)
                    }
                    "call" -> {
                        val target = evalValue(step.opt("tool"), args, vars, last).toString()
                            .removePrefix("builtin:")
                            .trim()
                        if (target.isBlank()) throw IllegalArgumentException("Dynamic MCP $name has empty call target")
                        if (target == toolName) throw IllegalArgumentException("Dynamic MCP $toolName cannot call itself")
                        val targetTool = tools[target]
                            ?: throw IllegalArgumentException("Unknown dynamic MCP call target: $target")
                        val callArgs = asJsonObject(evalValue(step.opt("args") ?: JSONObject(), args, vars, last))
                        last = targetTool.run(callArgs)
                        val saveAs = step.optString("save_as").trim()
                        if (saveAs.isNotBlank()) vars.put(saveAs, last)
                    }
                }
            }
            return asResultObject(last)
        }
    }

    private fun asJsonObject(value: Any?): JSONObject {
        return when (value) {
            is JSONObject -> value
            null, JSONObject.NULL -> JSONObject()
            else -> JSONObject().put("value", value)
        }
    }

    private fun asResultObject(value: Any?): JSONObject {
        return when (value) {
            is JSONObject -> value
            null, JSONObject.NULL -> JSONObject()
            else -> JSONObject().put("value", value)
        }
    }

    private fun evalValue(value: Any?, args: JSONObject, vars: JSONObject, last: Any?): Any? {
        return when (value) {
            is JSONObject -> {
                val out = JSONObject()
                val keys = value.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    out.put(key, evalValue(value.opt(key), args, vars, last))
                }
                out
            }
            is JSONArray -> {
                val out = JSONArray()
                for (i in 0 until value.length()) out.put(evalValue(value.opt(i), args, vars, last))
                out
            }
            is String -> evalString(value, args, vars, last)
            JSONObject.NULL -> null
            else -> value
        }
    }

    private fun evalString(raw: String, args: JSONObject, vars: JSONObject, last: Any?): Any? {
        val exact = Regex("^\\$\\{([^}]+)}$").matchEntire(raw)
        if (exact != null) return resolveToken(exact.groupValues[1], args, vars, last)
        return Regex("\\$\\{([^}]+)}").replace(raw) { match ->
            val resolved = resolveToken(match.groupValues[1], args, vars, last)
            when (resolved) {
                null, JSONObject.NULL -> ""
                is JSONObject, is JSONArray -> resolved.toString()
                else -> resolved.toString()
            }
        }
    }

    private fun resolveToken(token: String, args: JSONObject, vars: JSONObject, last: Any?): Any? {
        val path = token.trim()
        return when {
            path == "last" -> last
            path.startsWith("args.") -> getPath(args, path.removePrefix("args."))
            path.startsWith("vars.") -> getPath(vars, path.removePrefix("vars."))
            else -> ""
        }
    }

    private fun getPath(root: Any?, path: String): Any? {
        var current: Any? = root
        for (part in path.split('.').filter { it.isNotBlank() }) {
            current = when (current) {
                is JSONObject -> current.opt(part)
                is JSONArray -> {
                    val arr = current as JSONArray
                    part.toIntOrNull()?.let { idx ->
                        if (idx in 0 until arr.length()) arr.opt(idx) else null
                    }
                }
                else -> null
            }
            if (current == null || current == JSONObject.NULL) return null
        }
        return current
    }

    private fun tapTool() = object : Tool {
        override val name = "touch.tap"
        override val description = "在屏幕坐标 (x, y) 处单击（像素坐标，原点在左上角）。"
        override val inputSchema = objectSchema(
            JSONObject().put("x", intProp("横坐标，像素")).put("y", intProp("纵坐标，像素")),
            required = listOf("x", "y"),
        )
        override suspend fun run(args: JSONObject): JSONObject {
            val x = args.getInt("x").toFloat()
            val y = args.getInt("y").toFloat()
            val path = Path().apply { moveTo(x, y) }
            val service = gesture()
            service.showTapEffect(x, y)
            val ok = service.dispatch(path, 0, 60)
            return JSONObject().put("ok", ok).put("x", x).put("y", y)
        }
    }

    private fun longPressTool() = object : Tool {
        override val name = "touch.long_press"
        override val description = "在 (x, y) 处长按指定毫秒数。"
        override val inputSchema = objectSchema(
            JSONObject()
                .put("x", intProp("横坐标，像素"))
                .put("y", intProp("纵坐标，像素"))
                .put("duration_ms", intProp("长按时长，毫秒，默认 600")),
            required = listOf("x", "y"),
        )
        override suspend fun run(args: JSONObject): JSONObject {
            val x = args.getInt("x").toFloat()
            val y = args.getInt("y").toFloat()
            val dur = args.optLong("duration_ms", 600)
            val path = Path().apply { moveTo(x, y) }
            val service = gesture()
            service.showTapEffect(x, y)
            val ok = service.dispatch(path, 0, dur)
            return JSONObject().put("ok", ok)
        }
    }

    private fun swipeTool() = object : Tool {
        override val name = "touch.swipe"
        override val description = "从 (x1, y1) 滑动到 (x2, y2)，可指定时长（毫秒）。用于滑动列表、翻页、拖拽。"
        override val inputSchema = objectSchema(
            JSONObject()
                .put("x1", intProp("起点横坐标"))
                .put("y1", intProp("起点纵坐标"))
                .put("x2", intProp("终点横坐标"))
                .put("y2", intProp("终点纵坐标"))
                .put("duration_ms", intProp("滑动时长，毫秒，默认 300")),
            required = listOf("x1", "y1", "x2", "y2"),
        )
        override suspend fun run(args: JSONObject): JSONObject {
            val x1 = args.getInt("x1").toFloat()
            val y1 = args.getInt("y1").toFloat()
            val x2 = args.getInt("x2").toFloat()
            val y2 = args.getInt("y2").toFloat()
            val durationMs = args.optLong("duration_ms", 300)
            val path = Path().apply {
                moveTo(x1, y1)
                lineTo(x2, y2)
            }
            val service = gesture()
            service.showDragEffect(x1, y1, x2, y2, durationMs)
            val ok = service.dispatch(path, 0, durationMs)
            return JSONObject().put("ok", ok)
        }
    }

    private fun globalActionTool(
        toolName: String,
        desc: String,
        action: Int,
        showHomeEffect: Boolean = false,
    ) = object : Tool {
        override val name = toolName
        override val description = desc
        override val inputSchema = objectSchema(JSONObject())
        override suspend fun run(args: JSONObject): JSONObject {
            val service = gesture()
            if (showHomeEffect) service.showHomeEffect()
            val ok = service.performGlobalAction(action)
            return JSONObject().put("ok", ok)
        }
    }

    private fun typeTool() = object : Tool {
        override val name = "input.text"
        override val description = "向当前获得焦点的输入框写入文本（需先点击聚焦输入框）。"
        override val inputSchema = objectSchema(
            JSONObject().put("text", stringProp("要输入的文本")),
            required = listOf("text"),
        )
        override suspend fun run(args: JSONObject): JSONObject {
            val ok = gesture().typeIntoFocused(args.getString("text"))
            return JSONObject().put("ok", ok)
        }
    }

    private fun screenshotTool() = object : Tool {
        override val name = "screen.capture"
        override val description = "按当前画质设置对手机屏幕截图，返回 500KB 以内的压缩图片。"
        override val inputSchema = objectSchema(JSONObject())
        override suspend fun run(args: JSONObject): JSONObject {
            val dataUrl = capture.captureDataUrl()
            // send_to_user lets the connector forward the screenshot to the chat.
            return JSONObject().put("dataUrl", dataUrl).put("send_to_user", true)
        }
    }

    private fun recordTool() = object : Tool {
        override val name = "screen.record"
        override val description = "按当前画质设置录制屏幕一段时间，生成 mp4 视频文件并返回本机路径（仅画面，不含音频）。"
        override val destructive = false
        override val inputSchema = objectSchema(
            JSONObject()
                .put("duration_ms", intProp("录制时长，毫秒，默认 5000，最长 120000")),
        )
        override suspend fun run(args: JSONObject): JSONObject {
            val file = capture.recordToFile(
                durationMs = args.optLong("duration_ms", 5_000),
            )
            return JSONObject()
                .put("path", file.absolutePath)
                .put("size_bytes", file.length())
        }
    }
}
