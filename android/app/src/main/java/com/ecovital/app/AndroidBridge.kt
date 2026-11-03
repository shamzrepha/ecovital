package com.ecovital.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface

class AndroidBridge(
    private val context: Context,
    private val onTriggerTestAlarm: () -> Unit
) {

    @JavascriptInterface
    fun isAndroidApp(): Boolean {
        return true
    }

    @JavascriptInterface
    fun testAlarm() {
        onTriggerTestAlarm()
    }

    @JavascriptInterface
    fun callEmergency() {
        try {
            val dialIntent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:112")).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(dialIntent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    @JavascriptInterface
    fun openPermissions() {
        val intent = Intent(context, PermissionsActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        context.startActivity(intent)
    }

    @JavascriptInterface
    fun getFcmToken(): String {
        val prefs = context.getSharedPreferences("ecovital_prefs", Context.MODE_PRIVATE)
        return prefs.getString("fcm_token", "") ?: ""
    }

    @JavascriptInterface
    fun syncToken(): String {
        val prefs = context.getSharedPreferences("ecovital_prefs", Context.MODE_PRIVATE)
        val token = prefs.getString("fcm_token", "") ?: ""
        if (token.isNotEmpty()) {
            EcoFirebaseMessagingService.syncFcmTokenWithServer(token)
        }
        return token
    }
}
