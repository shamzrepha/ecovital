package com.ecovital.app

import android.content.Context
import android.content.Intent
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
}
