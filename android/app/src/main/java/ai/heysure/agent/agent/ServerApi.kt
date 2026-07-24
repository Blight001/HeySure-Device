package ai.heysure.agent.agent

import org.json.JSONArray
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

    /** Result of probing GET /api/auth/me. */
    enum class TokenProbe { VALID, UNAUTHORIZED, UNREACHABLE }

    /**
     * Probe whether [token] is still accepted.
     * - [TokenProbe.VALID] — server accepted it
     * - [TokenProbe.UNAUTHORIZED] — 401/403, token is dead
     * - [TokenProbe.UNREACHABLE] — network/server error; keep the cached session
     */
    fun probeToken(serverUrl: String, token: String): TokenProbe {
        if (serverUrl.isBlank() || token.isBlank()) return TokenProbe.UNAUTHORIZED
        return try {
            val base = normalizeBaseUrl(serverUrl)
            val conn = (URL("$base/api/auth/me").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 10_000
                readTimeout = 15_000
                setRequestProperty("Authorization", "Bearer $token")
            }
            try {
                when (conn.responseCode) {
                    in 200..299 -> TokenProbe.VALID
                    401, 403 -> TokenProbe.UNAUTHORIZED
                    else -> TokenProbe.UNREACHABLE
                }
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
            TokenProbe.UNREACHABLE
        }
    }

    /**
     * Restore a session from cache when possible.
     * Prefer a still-valid JWT; on 401 silent-relogin with saved credentials;
     * on network errors keep the existing token so offline reopen still works.
     *
     * Returns null only when there is no usable session and no way to re-login.
     */
    @Throws(Exception::class)
    fun restoreSession(settings: Settings): LoginResult? {
        if (settings.isLoggedIn) {
            when (probeToken(settings.serverUrl, settings.authToken)) {
                TokenProbe.VALID, TokenProbe.UNREACHABLE -> {
                    // Valid, or offline — keep cached token so the app stays "logged in".
                    return LoginResult(
                        accessToken = settings.authToken,
                        agentSocketUrl = settings.agentSocketUrl,
                        userId = settings.userId,
                        userName = settings.userName,
                        userAvatar = settings.userAvatar,
                    )
                }
                TokenProbe.UNAUTHORIZED -> {
                    // fall through to silent re-login
                }
            }
        }
        if (!settings.canSilentLogin) {
            if (settings.isLoggedIn) {
                // Dead token and no password on disk — only then drop the session.
                settings.clearSession()
            }
            return null
        }
        return login(settings.serverUrl, settings.userAccount, settings.userPassword)
    }

    /** One ICE server descriptor (STUN or TURN) as delivered by the server. */
    data class IceServerConfig(
        val urls: String,
        val username: String?,
        val credential: String?,
    )

    /**
     * Resolve the server-configured ICE servers (STUN + optional TURN) for
     * remote control. Never throws — returns an empty list on any failure so the
     * caller can fall back to its built-in STUN default.
     */
    fun getIceServers(serverUrl: String, token: String): List<IceServerConfig> {
        return try {
            val base = normalizeBaseUrl(serverUrl)
            val json = getJson("$base/api/rtc/ice-servers", token)
            val arr = json.optJSONArray("ice_servers") ?: JSONArray()
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val urls = when {
                    o.opt("urls") is JSONArray -> o.getJSONArray("urls").optString(0)
                    else -> o.optString("urls")
                }
                if (urls.isNullOrBlank()) null
                else IceServerConfig(
                    urls = urls,
                    username = o.optString("username").ifBlank { null },
                    credential = o.optString("credential").ifBlank { null },
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun getJson(urlStr: String, token: String?): JSONObject {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 15_000
            token?.let { setRequestProperty("Authorization", "Bearer $it") }
        }
        try {
            val ok = conn.responseCode in 200..299
            val stream = if (ok) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            if (!ok) throw IllegalStateException("请求失败 (${conn.responseCode})")
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally {
            conn.disconnect()
        }
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
