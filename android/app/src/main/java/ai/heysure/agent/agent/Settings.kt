package ai.heysure.agent.agent

import android.content.Context
import android.provider.Settings as AndroidSettings
import java.util.UUID

/**
 * Thin SharedPreferences wrapper — the Android analogue of the desktop shell's
 * `store.ts`. Holds the server URL, auth token, and the stable device id the
 * server keys dispatch on.
 *
 * Login is cached across process death: token + socket URL keep [isLoggedIn]
 * true after the app is closed; with [rememberLogin] the account/password are
 * also kept so token expiry can silent-relogin (same idea as Windows shell).
 */
class Settings(context: Context) {
    private val prefs = context.applicationContext
        .getSharedPreferences("heysure_agent", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value).apply()

    /** Socket.IO endpoint returned by /api/auth/login (may differ from serverUrl). */
    var agentSocketUrl: String
        get() = prefs.getString(KEY_AGENT_SOCKET_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_AGENT_SOCKET_URL, value).apply()

    var authToken: String
        get() = prefs.getString(KEY_AUTH_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_AUTH_TOKEN, value).apply()

    var userId: Int
        get() = prefs.getInt(KEY_USER_ID, 0)
        set(value) = prefs.edit().putInt(KEY_USER_ID, value).apply()

    var userName: String
        get() = prefs.getString(KEY_USER_NAME, "") ?: ""
        set(value) = prefs.edit().putString(KEY_USER_NAME, value).apply()

    /** 设备展示名称（上报给服务器的 device:register name），默认“安卓设备”。 */
    var agentName: String
        get() = prefs.getString(KEY_AGENT_NAME, "") ?: ""
        set(value) = prefs.edit().putString(KEY_AGENT_NAME, value).apply()

    var userAvatar: String
        get() = prefs.getString(KEY_USER_AVATAR, "") ?: ""
        set(value) = prefs.edit().putString(KEY_USER_AVATAR, value).apply()

    var userAccount: String
        get() = prefs.getString(KEY_USER_ACCOUNT, "") ?: ""
        set(value) = prefs.edit().putString(KEY_USER_ACCOUNT, value).apply()

    var userPassword: String
        get() = prefs.getString(KEY_USER_PASSWORD, "") ?: ""
        set(value) = prefs.edit().putString(KEY_USER_PASSWORD, value).apply()

    /** Default true so cold starts keep account/password for silent re-login. */
    var rememberLogin: Boolean
        get() = prefs.getBoolean(KEY_REMEMBER_LOGIN, true)
        set(value) = prefs.edit().putBoolean(KEY_REMEMBER_LOGIN, value).apply()

    /** "保持常亮"模式：用 WakeLock 让 CPU/屏幕保持唤醒，放着不动也尽量可控。 */
    var keepScreenAwake: Boolean
        get() = prefs.getBoolean(KEY_KEEP_AWAKE, false)
        set(value) = prefs.edit().putBoolean(KEY_KEEP_AWAKE, value).apply()

    /**
     * "远程控制模式"：屏幕常亮 + 系统亮度调到最低。投屏抓的是帧缓冲，与背光无关，
     * 因此远端仍看到清晰画面，而本机背光最低，省电且不显眼。
     */
    var remoteControlMode: Boolean
        get() = prefs.getBoolean(KEY_REMOTE_CONTROL, false)
        set(value) = prefs.edit().putBoolean(KEY_REMOTE_CONTROL, value).apply()

    /** 进入远程控制模式前的系统亮度（0-255），用于退出时还原；-1 表示未保存。 */
    var savedBrightness: Int
        get() = prefs.getInt(KEY_SAVED_BRIGHTNESS, -1)
        set(value) = prefs.edit().putInt(KEY_SAVED_BRIGHTNESS, value).apply()

    /** 进入远程控制模式前的亮度模式（手动/自动），用于退出时还原；-1 表示未保存。 */
    var savedBrightnessMode: Int
        get() = prefs.getInt(KEY_SAVED_BRIGHTNESS_MODE, -1)
        set(value) = prefs.edit().putInt(KEY_SAVED_BRIGHTNESS_MODE, value).apply()

    var captureQuality: CaptureQuality
        get() = CaptureQuality.fromId(prefs.getString(KEY_CAPTURE_QUALITY, null))
        set(value) = prefs.edit().putString(KEY_CAPTURE_QUALITY, value.id).apply()

    /** Stable per-install id so reconnects update the same logical agent. */
    val deviceId: String
        get() {
            val saved = prefs.getString(KEY_DEVICE_ID, null)
            if (!saved.isNullOrBlank()) return saved
            @Suppress("HardwareIds")
            val androidId = runCatching {
                AndroidSettings.Secure.getString(
                    null, AndroidSettings.Secure.ANDROID_ID,
                )
            }.getOrNull()
            val id = "android-" + (androidId?.take(12) ?: UUID.randomUUID().toString().take(12))
            prefs.edit().putString(KEY_DEVICE_ID, id).apply()
            return id
        }

    val isLoggedIn: Boolean get() = authToken.isNotBlank() && agentSocketUrl.isNotBlank()

    /** Enough saved fields to POST /api/auth/login without the user re-typing. */
    val canSilentLogin: Boolean
        get() = rememberLogin &&
            serverUrl.isNotBlank() &&
            userAccount.isNotBlank() &&
            userPassword.isNotBlank()

    /**
     * Persist a full login result atomically (commit) so a process kill right after
     * login still restores the session on next cold start.
     */
    fun applyLogin(
        serverUrl: String,
        result: ServerApi.LoginResult,
        account: String,
        password: String,
        remember: Boolean,
    ) {
        val editor = prefs.edit()
            .putString(KEY_SERVER_URL, ServerApi.normalizeBaseUrl(serverUrl))
            .putString(KEY_AGENT_SOCKET_URL, result.agentSocketUrl)
            .putString(KEY_AUTH_TOKEN, result.accessToken)
            .putInt(KEY_USER_ID, result.userId)
            .putString(KEY_USER_NAME, result.userName)
            .putString(KEY_USER_AVATAR, result.userAvatar)
            .putString(KEY_USER_ACCOUNT, account)
            .putBoolean(KEY_REMEMBER_LOGIN, remember)
        if (remember) {
            editor.putString(KEY_USER_PASSWORD, password)
        } else {
            editor.remove(KEY_USER_PASSWORD)
        }
        if ((prefs.getString(KEY_AGENT_NAME, "") ?: "").isBlank()) {
            editor.putString(KEY_AGENT_NAME, "安卓设备")
        }
        editor.commit()
    }

    /**
     * Drop the live session only. Account/password stay when [rememberLogin] is on
     * so the next launch can silent-relogin without re-typing.
     */
    fun clearSession() {
        val editor = prefs.edit()
            .remove(KEY_AUTH_TOKEN)
            .remove(KEY_AGENT_SOCKET_URL)
            .remove(KEY_USER_ID)
            .remove(KEY_USER_NAME)
            .remove(KEY_USER_AVATAR)
        if (!rememberLogin) {
            editor.remove(KEY_USER_ACCOUNT)
            editor.remove(KEY_USER_PASSWORD)
        }
        editor.commit()
    }

    private companion object {
        const val KEY_SERVER_URL = "serverUrl"
        const val KEY_AGENT_SOCKET_URL = "agentSocketUrl"
        const val KEY_AUTH_TOKEN = "authToken"
        const val KEY_USER_ID = "userId"
        const val KEY_USER_NAME = "userName"
        const val KEY_AGENT_NAME = "agentName"
        const val KEY_USER_AVATAR = "userAvatar"
        const val KEY_USER_ACCOUNT = "userAccount"
        const val KEY_USER_PASSWORD = "userPassword"
        const val KEY_REMEMBER_LOGIN = "rememberLogin"
        const val KEY_DEVICE_ID = "deviceId"
        const val KEY_KEEP_AWAKE = "keepScreenAwake"
        const val KEY_REMOTE_CONTROL = "remoteControlMode"
        const val KEY_SAVED_BRIGHTNESS = "savedBrightness"
        const val KEY_SAVED_BRIGHTNESS_MODE = "savedBrightnessMode"
        const val KEY_CAPTURE_QUALITY = "captureQuality"
    }
}

enum class CaptureQuality(
    val id: String,
    val label: String,
    val description: String,
    val imageMaxSide: Int,
    val imageStartQuality: Int,
    val videoScale: Float,
    val videoBitrate: Int,
) {
    LOW(
        id = "low",
        label = "低",
        description = "更小文件，适合弱网和快速识别",
        imageMaxSide = 900,
        imageStartQuality = 62,
        videoScale = 0.42f,
        videoBitrate = 450_000,
    ),
    MEDIUM(
        id = "medium",
        label = "中",
        description = "默认设置，兼顾清晰度与 500KB 限制",
        imageMaxSide = 1280,
        imageStartQuality = 76,
        videoScale = 0.55f,
        videoBitrate = 800_000,
    ),
    HIGH(
        id = "high",
        label = "高",
        description = "优先清晰度，仍会压缩到 500KB 以内",
        imageMaxSide = 1600,
        imageStartQuality = 88,
        videoScale = 0.72f,
        videoBitrate = 1_200_000,
    );

    companion object {
        fun fromId(id: String?): CaptureQuality =
            entries.firstOrNull { it.id == id } ?: MEDIUM
    }
}
