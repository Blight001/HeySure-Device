package ai.heysure.agent.executor

import org.json.JSONArray
import org.json.JSONObject

/**
 * One dispatchable capability. `name` / `description` / `inputSchema` are
 * reported verbatim to the server in `device:register` (the server is never the
 * source of truth for an endpoint's tool schemas — see
 * desktop_device_tools.agent_endpoint_tool_defs), and `run` is what executes
 * when a `task:dispatch` for this tool arrives.
 */
interface Tool {
    val name: String
    val description: String
    val inputSchema: JSONObject
    val destructive: Boolean get() = false

    suspend fun run(args: JSONObject): JSONObject
}

/** Helper to build a JSON-schema object for a tool's parameters. */
fun objectSchema(
    properties: JSONObject,
    required: List<String> = emptyList(),
): JSONObject = JSONObject()
    .put("type", "object")
    .put("properties", properties)
    .put("required", JSONArray(required))

fun intProp(description: String): JSONObject =
    JSONObject().put("type", "integer").put("description", description)

fun stringProp(description: String): JSONObject =
    JSONObject().put("type", "string").put("description", description)
