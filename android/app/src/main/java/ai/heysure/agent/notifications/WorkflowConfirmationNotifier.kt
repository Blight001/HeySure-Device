package ai.heysure.agent.notifications

import ai.heysure.agent.console.ConsoleActivity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/** Displays durable, user-scoped workflow approvals without exposing tool arguments. */
class WorkflowConfirmationNotifier(context: Context) {
    private val appContext = context.applicationContext
    private val manager = appContext.getSystemService(NotificationManager::class.java)
    private val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    init {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(
                CHANNEL_ID,
                "人工确认",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "自动化卡片等待用户批准或拒绝时提醒"
                enableVibration(true)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            })
        }
    }

    fun show(payload: JSONObject) {
        val confirmationId = payload.optString("confirmation_id").trim()
        val runId = payload.optString("run_id").trim()
        val expiresAt = payload.optDouble("expires_at", 0.0)
        if (!isSafeId(confirmationId) || !isSafeId(runId) || expiresAt * 1000 <= System.currentTimeMillis()) {
            if (confirmationId.isNotBlank()) cancel(confirmationId)
            return
        }
        val actor = safeText(payload.optString("actor_name"), 80)
        val card = safeText(payload.optString("card_name"), 80).ifBlank { "自动化卡片" }
        val summary = safeText(payload.optString("risk_summary"), 300).ifBlank { "请查看详情后决定是否继续" }
        val title = if (actor.isBlank()) "人工确认请求" else "${actor}请求人工确认"
        val body = "$card：$summary"
        val intent = Intent(appContext, ConsoleActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.Builder().scheme("heysure").authority("workflow-confirmation").appendPath(runId).build()
            putExtra(ConsoleActivity.EXTRA_WORKFLOW_RUN_ID, runId)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val pendingIntent = PendingIntent.getActivity(
            appContext,
            confirmationId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(appContext, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setCategory(Notification.CATEGORY_REMINDER)
            .setPriority(Notification.PRIORITY_HIGH)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOnlyAlertOnce(true)
            .setAutoCancel(false)
            .setTimeoutAfter((expiresAt * 1000 - System.currentTimeMillis()).toLong().coerceAtLeast(1L))
            .addAction(Notification.Action.Builder(null, "查看并处理", pendingIntent).build())
            .build()
        runCatching { manager.notify(confirmationId, NOTIFICATION_ID, notification) }
        remember(confirmationId)
    }

    fun replaceSnapshot(payload: JSONObject) {
        val items = payload.optJSONArray("items") ?: JSONArray()
        val liveIds = mutableSetOf<String>()
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            val id = item.optString("confirmation_id").trim()
            if (isSafeId(id) && item.optString("status") == "pending") {
                liveIds += id
                show(item)
            }
        }
        rememberedIds().filterNot(liveIds::contains).forEach(::cancel)
    }

    fun resolve(payload: JSONObject) {
        val id = payload.optString("confirmation_id").trim()
        if (isSafeId(id)) cancel(id)
    }

    fun cancelAll() {
        rememberedIds().forEach { manager.cancel(it, NOTIFICATION_ID) }
        prefs.edit().remove(KEY_ACTIVE_IDS).apply()
    }

    private fun cancel(confirmationId: String) {
        manager.cancel(confirmationId, NOTIFICATION_ID)
        val remaining = rememberedIds() - confirmationId
        prefs.edit().putStringSet(KEY_ACTIVE_IDS, remaining).apply()
    }

    private fun remember(confirmationId: String) {
        prefs.edit().putStringSet(KEY_ACTIVE_IDS, rememberedIds() + confirmationId).apply()
    }

    private fun rememberedIds(): Set<String> =
        prefs.getStringSet(KEY_ACTIVE_IDS, emptySet())?.toSet() ?: emptySet()

    private fun safeText(value: String, limit: Int): String =
        value.replace(Regex("\\s+"), " ").trim().take(limit)

    private fun isSafeId(value: String): Boolean =
        value.length in 1..160 && value.all { it.isLetterOrDigit() || it == '_' || it == '-' }

    private companion object {
        const val CHANNEL_ID = "heysure_workflow_approvals_v1"
        const val NOTIFICATION_ID = 2001
        const val PREFS_NAME = "heysure_workflow_notifications"
        const val KEY_ACTIVE_IDS = "active_confirmation_ids"
    }
}
