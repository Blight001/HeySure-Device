package ai.heysure.agent.agent

import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * Minimal REST client for the auth handshake. Mirrors the desktop shell's
 * `auth:login` IPC: POST /api/auth/login returns the JWT, the user record, and
 * the Socket.IO endpoint the agent then connects to.
 */
object ServerApi {

    data class LoginResult(
        val accessToken: String,
        val agentSocketUrl: String,
        val userId: Int,
        val userName: String,
        val userAvatar: String,
    )

    /** Normalize "host:port" / trailing-slash variants to a clean base URL. */
    fun normalizeBaseUrl(raw: String): String {
        var url = raw.trim()
        if (url.isEmpty()) throw IllegalArgumentException("服务器 URL 不能为空")
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://$url"
        return url.trimEnd('/')
    }

    @Throws(Exception::class)
    fun login(serverUrl: String, account: String, password: String): LoginResult {
        val base = normalizeBaseUrl(serverUrl)
        val body = JSONObject().put("account", account).put("password", password)
        val json = postJson("$base/api/auth/login", body, token = null)

        val token = json.optString("access_token")
        if (token.isBlank()) throw IllegalStateException("登录响应缺少 access_token")
        val socketUrl = json.optString("agent_socket_url").ifBlank { base }
        val user = json.optJSONObject("user")
        return LoginResult(
            accessToken = token,
            agentSocketUrl = normalizeBaseUrl(socketUrl),
            userId = user?.optInt("id", 0) ?: 0,
            userName = user?.optString("name").orEmpty().ifBlank { account },
            userAvatar = user?.optString("avatar").orEmpty(),
        )
    }

    private fun postJson(urlStr: String, body: JSONObject, token: String?): JSONObject {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 10_000
            readTimeout = 15_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            token?.let { setRequestProperty("Authorization", "Bearer $it") }
        }
        try {
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val ok = conn.responseCode in 200..299
            val stream = if (ok) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            if (!ok) {
                val detail = runCatching { JSONObject(text).optString("detail") }.getOrNull()
                throw IllegalStateException(detail?.ifBlank { null } ?: "请求失败 (${conn.responseCode})")
            }
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }
}
