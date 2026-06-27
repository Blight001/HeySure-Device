package ai.heysure.agent.executor

import kotlinx.coroutines.CancellationException
import org.json.JSONObject

data class TaskResult(
    val success: Boolean,
    val tool: String,
    val result: Any?,
    val summary: String,
)

/**
 * Validates a dispatched task against the catalog + the per-task allow-list,
 * then runs it. Mirrors the desktop shell's `executeTask` contract so the
 * server-side dispatch loop treats Android identically.
 */
class TaskExecutor(private val catalog: ToolCatalog) {

    suspend fun execute(tool: String, args: JSONObject, allowedTools: List<String>?): TaskResult {
        val def = catalog.get(tool)
        if (def == null) {
            return TaskResult(
                success = false, tool = tool, result = null,
                summary = "Unknown tool: $tool. Use one of: ${catalog.names().joinToString(", ")}",
            )
        }
        if (allowedTools != null && allowedTools.isNotEmpty() && tool !in allowedTools) {
            return TaskResult(false, tool, null, "Tool not allowed for this task: $tool.")
        }
        return try {
            val result = def.run(args)
            TaskResult(true, tool, result, "$tool completed successfully")
        } catch (e: CancellationException) {
            // Never swallow coroutine cancellation (e.g. agent shutdown) — let it
            // propagate so the scope can unwind cleanly. Tool-level timeouts are
            // already converted to ordinary failures by the tools themselves.
            throw e
        } catch (e: Exception) {
            TaskResult(false, tool, null, e.message ?: e.toString())
        }
    }
}
