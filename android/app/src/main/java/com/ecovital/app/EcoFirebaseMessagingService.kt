package com.ecovital.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.RingtoneManager
import android.os.Build
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
        const val ALERTS_CHANNEL_ID = "ecovital_alerts_v1"
        const val SERVER_BASE_URL = "https://ecovital-phi.vercel.app"

        fun syncFcmTokenWithServer(token: String) {
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val cookieManager = CookieManager.getInstance()
                    val cookies = cookieManager.getCookie(SERVER_BASE_URL) ?: ""
                    if (!cookies.contains("ecovital_session")) {
                        // User not logged in yet; token will be synced once they sign in
                        return@launch
                    }

                    val url = URL("$SERVER_BASE_URL/api/fcm")
                    val conn = (url.openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"
                        doOutput = true
                        setRequestProperty("Content-Type", "application/json")
                        setRequestProperty("Cookie", cookies)
                        connectTimeout = 10000
                        readTimeout = 10000
                    }

                    val json = """{"token":"$token","platform":"android"}"""
                    conn.outputStream.use { os ->
                        os.write(json.toByteArray(Charsets.UTF_8))
                    }

                    conn.responseCode
                    conn.disconnect()
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        }
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        val prefs = getSharedPreferences("ecovital_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString("fcm_token", token).apply()

        syncFcmTokenWithServer(token)
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)

        val data = remoteMessage.data
        if (data.isEmpty()) return

        val type = data["type"] ?: "alert"
        val title = data["title"] ?: "EcoVital Notification"
        val body = data["body"] ?: "Air quality alert received"
        val podId = data["podId"] ?: ""
        val cause = data["cause"] ?: "smoke"

        if (type == "alarm") {
            // Trigger emergency siren foreground service & full-screen lock-screen alert
            AlarmService.startAlarm(
                context = applicationContext,
                podId = podId,
                podName = if (podId.isNotEmpty()) podId else "EcoVital Pod",
                title = title,
                cause = cause,
                body = body
            )
        } else {
            // Standard advisory room alert
            showStandardAlertNotification(title, body, podId)
        }
    }

    private fun showStandardAlertNotification(title: String, body: String, podId: String) {
        createAlertsChannel()

        val targetUrl = if (podId.isNotEmpty()) "$SERVER_BASE_URL/pods/$podId" else "$SERVER_BASE_URL/dashboard"
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("target_url", targetUrl)
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            System.currentTimeMillis().toInt(),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        )

        val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)

        val notification = NotificationCompat.Builder(this, ALERTS_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setSound(soundUri)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .build()

        val nm = getSystemService(NotificationManager::class.java)
        nm.notify((System.currentTimeMillis() % 100000).toInt(), notification)
    }

    private fun createAlertsChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                ALERTS_CHANNEL_ID,
                getString(R.string.alerts_channel_name),
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = getString(R.string.alerts_channel_desc)
                enableVibration(true)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }
}
