package ai.heysure.agent.agent

import ai.heysure.agent.MainActivity
import ai.heysure.agent.R
import ai.heysure.agent.capture.ScreenCaptureManager
import ai.heysure.agent.executor.TaskExecutor
import ai.heysure.agent.executor.ToolCatalog
import ai.heysure.agent.remote.RemoteControlManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Foreground service that keeps the Socket.IO connection + MediaProjection grant
 * alive while the UI is backgrounded. This is the Android equivalent of the
 * desktop shell's main process: it owns the agent singleton and the executor.
 */
class AgentService : Service() {

    private lateinit var settings: Settings
    private lateinit var capture: ScreenCaptureManager
    private var agent: SocketAgent? = null
    private var remoteControl: RemoteControlManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    @Volatile private var recoveringAuth = false

    var lastStatus: DeviceStatus = DeviceStatus.DISCONNECTED
        private set
    var statusListener: ((DeviceStatus, String?) -> Unit)? = null
    var logListener: ((String) -> Unit)? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        settings = Settings(this)
        capture = ScreenCaptureManager(applicationContext)
        createChannel()
    }

    val screenCapture: ScreenCaptureManager get() = capture

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        when (intent?.action) {
            ACTION_GRANT_CAPTURE -> {
                val code = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                val data = intent.getParcelableExtraCompat<Intent>(EXTRA_RESULT_DATA)
                if (code != 0 && data != null) {
                    val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                    val projection = mpm.getMediaProjection(code, data)
                    if (projection != null) {
                        capture.attach(projection)
                        logListener?.invoke("已授权截屏/录屏")
                    } else {
                        logListener?.invoke("截屏/录屏授权失败")
                    }
                }
            }
            ACTION_STOP -> {
                stopAgent()
                stopSelf()
                return START_NOT_STICKY
            }
        }
        // Re-apply persisted power modes after a (re)start so they survive process death.
        updateWakeLock()
        if (settings.remoteControlMode) enterMinBrightness()
        ensureAgent()
        return START_STICKY
    }

    /**
     * "保持常亮"模式：持有一个 SCREEN_DIM_WAKE_LOCK，让 CPU 与屏幕保持唤醒（压暗），
     * 这样放着不动时截屏不黑、手势能注入、socket 不易被 Doze 掐断。代价是耗电。
     * 真正的息屏 + 安全锁屏控制仍需方案 B（电脑 ADB）或 root。
     */
    fun applyKeepAwake(enabled: Boolean) {
        settings.keepScreenAwake = enabled
        updateWakeLock()
        if (enabled) logListener?.invoke("已开启保持常亮（WakeLock）")
    }

    /**
     * "远程控制模式"：屏幕常亮 + 系统亮度调到最低。投屏抓的是帧缓冲（不受背光影响），
     * 远端依旧能看到清晰画面，而本机背光降到最低，省电且不显眼。需要「修改系统设置」权限。
     */
    fun applyRemoteControlMode(enabled: Boolean) {
        settings.remoteControlMode = enabled
        if (enabled) {
            enterMinBrightness()
            updateWakeLock()
            logListener?.invoke("已开启远程控制模式（常亮 + 最低亮度）")
        } else {
            restoreBrightness()
            updateWakeLock()
            logListener?.invoke("已退出远程控制模式")
        }
    }

    /** WakeLock 由「保持常亮」与「远程控制模式」共用：任一开启即持有，全部关闭才释放。 */
    private fun updateWakeLock() {
        val shouldHold = settings.keepScreenAwake || settings.remoteControlMode
        if (shouldHold) {
            if (wakeLock?.isHeld == true) return
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            @Suppress("DEPRECATION")
            val lock = pm.newWakeLock(
                PowerManager.SCREEN_DIM_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "heysure:keep-awake",
            )
            lock.setReferenceCounted(false)
            lock.acquire()
            wakeLock = lock
        } else {
            if (wakeLock?.isHeld == true) wakeLock?.release()
            wakeLock = null
        }
    }

    private fun canWriteSettings(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || AndroidSettings.System.canWrite(this)

    /** 把系统亮度切到手动并调到最低，首次进入时记下原值以便退出还原。 */
    private fun enterMinBrightness() {
        if (!canWriteSettings()) {
            logListener?.invoke("无法调整亮度：尚未授予「修改系统设置」权限")
            return
        }
        val resolver = contentResolver
        // Only snapshot the original state once, so repeated entries don't overwrite it with the min value.
        if (settings.savedBrightness < 0) {
            settings.savedBrightness = runCatching {
                AndroidSettings.System.getInt(resolver, AndroidSettings.System.SCREEN_BRIGHTNESS)
            }.getOrDefault(-1)
            settings.savedBrightnessMode = runCatching {
                AndroidSettings.System.getInt(resolver, AndroidSettings.System.SCREEN_BRIGHTNESS_MODE)
            }.getOrDefault(AndroidSettings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC)
        }
        runCatching {
            AndroidSettings.System.putInt(
                resolver,
                AndroidSettings.System.SCREEN_BRIGHTNESS_MODE,
                AndroidSettings.System.SCREEN_BRIGHTNESS_MODE_MANUAL,
            )
            AndroidSettings.System.putInt(
                resolver, AndroidSettings.System.SCREEN_BRIGHTNESS, MIN_BRIGHTNESS,
            )
        }.onFailure { logListener?.invoke("调整亮度失败：${it.message}") }
    }

    /** 还原进入远程控制模式前的亮度与亮度模式。 */
    private fun restoreBrightness() {
        if (!canWriteSettings()) return
        val resolver = contentResolver
        runCatching {
            settings.savedBrightnessMode.takeIf { it >= 0 }?.let {
                AndroidSettings.System.putInt(resolver, AndroidSettings.System.SCREEN_BRIGHTNESS_MODE, it)
            }
            settings.savedBrightness.takeIf { it >= 0 }?.let {
                AndroidSettings.System.putInt(resolver, AndroidSettings.System.SCREEN_BRIGHTNESS, it)
            }
        }
        settings.savedBrightness = -1
        settings.savedBrightnessMode = -1
    }

    private fun ensureAgent() {
        if (agent != null) return
        if (!settings.isLoggedIn) return
        val catalog = ToolCatalog(capture)
        val executor = TaskExecutor(catalog)
        // The manager's signal sender reads `agent` lazily, so it resolves once
        // the SocketAgent below is assigned (signals only fire after connect).
        val rc = RemoteControlManager(
            appContext = applicationContext,
            capture = capture,
            sendSignal = { event, payload -> agent?.emitSignal(event, payload) },
            onLog = { msg -> logListener?.invoke(msg) },
            serverUrl = { settings.serverUrl },
            authToken = { settings.authToken },
        )
        remoteControl = rc
        agent = SocketAgent(
            settings = settings,
            executor = executor,
            toolDefs = { catalog.toolDefs() },
            // Advertise remote_control alongside the tool names so the server can
            // gate live control on it (see RemoteControlManager.CAPABILITY).
            capabilities = { catalog.names() + RemoteControlManager.CAPABILITY },
            onToolConfig = { payload -> catalog.applyDynamicConfig(payload) },
            onStatus = { status, reason ->
                lastStatus = status
                statusListener?.invoke(status, reason)
                updateNotification(status)
            },
            onLog = { msg -> logListener?.invoke(msg) },
            onRcSignal = { event, data -> rc.onSignal(event, data) },
            onAuthFailure = { reason -> recoverAuth(reason) },
        ).also { it.connect() }
    }

    /**
     * Silent re-login with saved credentials when the server rejects our token.
     * Mirrors Windows `recoverAuth`: one attempt, then rebuild the socket agent.
     */
    private fun recoverAuth(reason: String) {
        if (recoveringAuth) return
        if (!settings.canSilentLogin) {
            logListener?.invoke("登录态失效（$reason），请手动重新登录")
            return
        }
        recoveringAuth = true
        logListener?.invoke("登录态失效，正在用保存的凭据重新登录…")
        serviceScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    ServerApi.login(settings.serverUrl, settings.userAccount, settings.userPassword)
                }
            }
            recoveringAuth = false
            result.onSuccess { res ->
                settings.applyLogin(
                    serverUrl = settings.serverUrl,
                    result = res,
                    account = settings.userAccount,
                    password = settings.userPassword,
                    remember = true,
                )
                logListener?.invoke("已自动恢复登录")
                reconnect()
            }.onFailure { e ->
                logListener?.invoke("自动重新登录失败: ${e.message ?: e}")
            }
        }
    }

    fun reconnect() {
        agent?.shutdown()
        agent = null
        remoteControl?.shutdown()
        remoteControl = null
        ensureAgent()
    }

    private fun stopAgent() {
        agent?.shutdown()
        agent = null
        remoteControl?.shutdown()
        remoteControl = null
        capture.release()
    }

    override fun onDestroy() {
        serviceScope.cancel()
        stopAgent()
        // Hand the screen back to the system; the persisted flag re-dims on next start.
        restoreBrightness()
        if (wakeLock?.isHeld == true) wakeLock?.release()
        wakeLock = null
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // --- notification / foreground plumbing ---

    private fun startForegroundCompat() {
        val notif = buildNotification(getString(R.string.notif_running))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID, getString(R.string.notif_channel_name), NotificationManager.IMPORTANCE_LOW,
        )
        mgr.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }
        return builder
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(status: DeviceStatus) {
        val text = when (status) {
            DeviceStatus.REGISTERED -> "已注册，等待任务"
            DeviceStatus.CONNECTED -> "已连接"
            DeviceStatus.CONNECTING -> "连接中…"
            DeviceStatus.ERROR -> "连接错误"
            DeviceStatus.DISCONNECTED -> "未连接"
        }
        getSystemService(NotificationManager::class.java)
            ?.notify(NOTIF_ID, buildNotification(text))
    }

    companion object {
        @Volatile
        var instance: AgentService? = null
            private set

        private const val NOTIF_ID = 1001
        private const val CHANNEL_ID = "heysure_agent"
        /** 系统亮度最低值（0-255）；系统会自动夹到设备可见下限。 */
        private const val MIN_BRIGHTNESS = 0

        const val ACTION_GRANT_CAPTURE = "ai.heysure.agent.GRANT_CAPTURE"
        const val ACTION_STOP = "ai.heysure.agent.STOP"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"

        fun start(context: Context) {
            val intent = Intent(context, AgentService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}

private inline fun <reified T> Intent.getParcelableExtraCompat(name: String): T? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        getParcelableExtra(name, T::class.java)
    } else {
        @Suppress("DEPRECATION") getParcelableExtra(name) as? T
    }
