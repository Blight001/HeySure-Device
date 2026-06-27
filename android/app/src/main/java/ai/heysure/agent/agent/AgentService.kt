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
        applyKeepAwake(settings.keepScreenAwake)
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
        if (enabled) {
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
            logListener?.invoke("已开启保持常亮（WakeLock）")
        } else {
            if (wakeLock?.isHeld == true) wakeLock?.release()
            wakeLock = null
        }
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
        ).also { it.connect() }
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
        stopAgent()
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
