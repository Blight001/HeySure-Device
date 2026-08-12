package ai.heysure.agent.notifications

import ai.heysure.agent.BuildConfig
import ai.heysure.agent.agent.ServerApi
import ai.heysure.agent.agent.Settings
import android.content.Context
import android.util.Log
import com.huawei.hms.aaid.HmsInstanceId

/** Obtains an HMS token and binds it to the currently authenticated HeySure user. */
object HuaweiPushRegistration {
    private const val TAG = "HeySureHms"

    fun requestAndSync(context: Context) {
        val appContext = context.applicationContext
        val appId = BuildConfig.HUAWEI_PUSH_APP_ID.trim()
        if (appId.isBlank()) return
        Thread({
            val settings = Settings(appContext)
            val token = runCatching {
                HmsInstanceId.getInstance(appContext).getToken(appId, "HCM")
            }.getOrElse {
                Log.w(TAG, "HMS token request failed: ${it.javaClass.simpleName}")
                return@Thread
            }
            if (token.isBlank()) return@Thread
            settings.huaweiPushToken = token
            syncStored(appContext)
        }, "heysure-hms-register").start()
    }

    fun acceptRotatedToken(context: Context, token: String) {
        if (token.isBlank()) return
        val appContext = context.applicationContext
        Settings(appContext).huaweiPushToken = token
        Thread({ syncStored(appContext) }, "heysure-hms-rotate").start()
    }

    fun syncStored(context: Context) {
        val settings = Settings(context)
        val pushToken = settings.huaweiPushToken
        if (!settings.isLoggedIn || pushToken.isBlank()) return
        runCatching {
            ServerApi.registerHuaweiPushEndpoint(
                serverUrl = settings.serverUrl,
                token = settings.authToken,
                deviceId = settings.deviceId,
                pushToken = pushToken,
                appVersion = BuildConfig.VERSION_NAME,
            )
        }.onFailure {
            Log.w(TAG, "HMS endpoint sync failed: ${it.javaClass.simpleName}")
        }
    }

    fun unregisterAsync(
        serverUrl: String,
        authToken: String,
        deviceId: String,
    ) {
        Thread({
            runCatching {
                ServerApi.unregisterHuaweiPushEndpoint(serverUrl, authToken, deviceId)
            }.onFailure {
                Log.w(TAG, "HMS endpoint unregister failed: ${it.javaClass.simpleName}")
            }
        }, "heysure-hms-unregister").start()
    }
}
