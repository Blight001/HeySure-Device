package ai.heysure.agent.notifications

import ai.heysure.agent.console.ConsoleActivity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/** System notifications for messages that could not be delivered by a bound bot. */
class UserMessageNotifier(context: Context) {
    private val appContext = context.applicationContext
    private val manager = appContext.getSystemService(NotificationManager::class.java)
    private val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    init {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL_ID,
                "数字成员消息",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "没有可用外部机器人时，由 HeySure 直接提醒用户"
                enableVibration(true)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            })
        }
    }

    fun show(payload: JSONObject) {
        val id = payload.optString("notification_id").trim()
        if (!isSafeId(id) || payload.optString("status", "unread") != "unread") return
        val title = safeText(payload.optString("title"), 100).ifBlank { "数字成员发来消息" }
        var body = safeText(payload.optString("body"), 500).ifBlank { "请进入 HeySure 查看消息" }
        val attachmentCount = payload.optInt("attachment_count", 0)
        if (attachmentCount > 0) body += "（含 $attachmentCount 个文件）"
        val intent = Intent(appContext, ConsoleActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val pendingIntent = PendingIntent.getActivity(
            appContext,
            id.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(appContext, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setPriority(Notification.PRIORITY_HIGH)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .build()
        runCatching { manager.notify(id, NOTIFICATION_ID, notification) }
        remember(id)
    }

    fun replaceSnapshot(payload: JSONObject) {
        val items = payload.optJSONArray("items") ?: JSONArray()
        val live = mutableSetOf<String>()
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            val id = item.optString("notification_id").trim()
            if (isSafeId(id) && item.optString("status") == "unread") {
                live += id
                show(item)
            }
        }
        rememberedIds().filterNot(live::contains).forEach(::cancel)
    }

    fun resolve(payload: JSONObject) {
        val id = payload.optString("notification_id").trim()
        if (isSafeId(id)) cancel(id)
    }

    private fun cancel(id: String) {
        manager.cancel(id, NOTIFICATION_ID)
        prefs.edit().putStringSet(KEY_ACTIVE_IDS, rememberedIds() - id).apply()
    }

    private fun remember(id: String) {
        prefs.edit().putStringSet(KEY_ACTIVE_IDS, rememberedIds() + id).apply()
    }

    private fun rememberedIds(): Set<String> =
        prefs.getStringSet(KEY_ACTIVE_IDS, emptySet())?.toSet() ?: emptySet()

    private fun safeText(value: String, limit: Int): String =
        value.replace(Regex("\\s+"), " ").trim().take(limit)

    private fun isSafeId(value: String): Boolean =
        value.length in 1..160 && value.all { it.isLetterOrDigit() || it == '_' || it == '-' }

    private companion object {
        const val CHANNEL_ID = "heysure_member_messages_v1"
        const val NOTIFICATION_ID = 2101
        const val PREFS_NAME = "heysure_user_notifications"
        const val KEY_ACTIVE_IDS = "active_notification_ids"
    }
}
