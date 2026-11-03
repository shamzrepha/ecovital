package com.ecovital.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.net.HttpURLConnection
import java.net.URL

class EcoFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        const val ALERTS_CHANNEL_ID = "ecovital_alerts_v2"
        const val SERVER_BASE_URL = "https://ecovital-phi.vercel.app"
        const val ACTION_PUSH_ALERT = "com.ecovital.app.ACTION_PUSH_ALERT"
        private const val TAG = "EcoFCM"

        fun syncFcmTokenWithServer(token: String) {
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val cookieManager = CookieManager.getInstance()
                    val cookies = cookieManager.getCookie(SERVER_BASE_URL) ?: ""

                    val url = URL("$SERVER_BASE_URL/api/fcm")
                    val conn = (url.openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"
                        doOutput = true
                        setRequestProperty("Content-Type", "application/json")
                        setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android; Mobile) EcoVital/1.0")
                        if (cookies.isNotEmpty()) {
                            setRequestProperty("Cookie", cookies)
                        }
                        connectTimeout = 10000
                        readTimeout = 10000
                    }

                    val json = """{"token":"$token","platform":"android"}"""
                    conn.outputStream.use { os ->
                        os.write(json.toByteArray(Charsets.UTF_8))
                    }

                    val code = conn.responseCode
                    Log.i(TAG, "FCM token sync response: HTTP $code")
                    conn.disconnect()
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to sync FCM token with server", e)
                }
            }
        }
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.i(TAG, "onNewToken: $token")
        val prefs = getSharedPreferences("ecovital_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString("fcm_token", token).apply()

        syncFcmTokenWithServer(token)
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)

        val data = remoteMessage.data
        Log.i(TAG, "onMessageReceived from: ${remoteMessage.from}, data: $data")
        if (data.isEmpty()) return

        val type = data["type"] ?: "alert"
        val title = data["title"] ?: "EcoVital Notification"
        val body = data["body"] ?: "Air quality alert received"
        val podId = data["podId"] ?: ""
        val cause = data["cause"] ?: "smoke"

        // Broadcast to MainActivity so foreground WebView auto-updates
        try {
            val targetUrl = if (podId.isNotEmpty()) "$SERVER_BASE_URL/pods/$podId" else "$SERVER_BASE_URL/dashboard"
            val broadcast = Intent(ACTION_PUSH_ALERT).apply {
                setPackage(packageName)
                putExtra("podId", podId)
                putExtra("cause", cause)
                putExtra("type", type)
                putExtra("target_url", targetUrl)
            }
            sendBroadcast(broadcast)
        } catch (e: Exception) {
            e.printStackTrace()
        }

        // 1. ALWAYS display a high-priority system notification with heads-up banner & sound
        showStandardAlertNotification(title, body, podId, type == "alarm")

        // 2. If it is an emergency alarm, also attempt to launch looping siren service & lock screen alert
        if (type == "alarm") {
            try {
                AlarmService.startAlarm(
                    context = applicationContext,
                    podId = podId,
                    podName = if (podId.isNotEmpty()) podId else "EcoVital Pod",
                    title = title,
                    cause = cause,
                    body = body
                )
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start AlarmService, notification was shown", e)
            }
        }
    }

    private fun showStandardAlertNotification(
        title: String,
        body: String,
        podId: String,
        isAlarm: Boolean
    ) {
        createAlertsChannel()

        val targetUrl = if (podId.isNotEmpty()) "$SERVER_BASE_URL/pods/$podId" else "$SERVER_BASE_URL/dashboard"
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("target_url", targetUrl)
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            System.currentTimeMillis().toInt(),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val defaultSoundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val builder = NotificationCompat.Builder(this, ALERTS_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setSound(defaultSoundUri)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(if (isAlarm) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setContentIntent(pendingIntent)

        if (isAlarm) {
            builder.setFullScreenIntent(pendingIntent, true)
        }

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        manager?.notify(System.currentTimeMillis().toInt(), builder.build())
    }

    private fun createAlertsChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val audioAttributes = AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
                .build()

            val channel = NotificationChannel(
                ALERTS_CHANNEL_ID,
                "EcoVital Air Alerts",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Notifies when air quality or dust leaves healthy range"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 400, 200, 400)
                setSound(soundUri, audioAttributes)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            manager?.createNotificationChannel(channel)
        }
    }
}
