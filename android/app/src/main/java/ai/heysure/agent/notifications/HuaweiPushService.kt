package ai.heysure.agent.notifications

import com.huawei.hms.push.HmsMessageService
import com.huawei.hms.push.RemoteMessage
import org.json.JSONObject

/** HMS Core entry point. Notification messages are displayed by the system when killed. */
class HuaweiPushService : HmsMessageService() {
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        HuaweiPushRegistration.acceptRotatedToken(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = runCatching { JSONObject(message.data.orEmpty()) }.getOrDefault(JSONObject())
        val notification = message.notification
        val payload = JSONObject()
            .put("notification_id", data.optString("notification_id"))
            .put("status", "unread")
            .put("title", notification?.title.orEmpty())
            .put("body", notification?.body.orEmpty())
        UserMessageNotifier(applicationContext).show(payload)
    }
}
