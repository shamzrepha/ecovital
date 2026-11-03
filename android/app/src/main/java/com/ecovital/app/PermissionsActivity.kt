package com.ecovital.app

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class PermissionsActivity : AppCompatActivity() {

    private val requestNotificationLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        updateStatus()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_permissions)

        findViewById<Button>(R.id.btnGrantNotification).setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                requestNotificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        findViewById<Button>(R.id.btnGrantFullScreen).setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                try {
                    val intent = Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).apply {
                        data = Uri.parse("package:$packageName")
                    }
                    startActivity(intent)
                } catch (_: Exception) {
                    openAppSettings()
                }
            }
        }

        findViewById<Button>(R.id.btnGrantBattery).setOnClickListener {
            try {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
            } catch (_: Exception) {
                openAppSettings()
            }
        }

        findViewById<Button>(R.id.btnGrantDnd).setOnClickListener {
            try {
                val intent = Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
                startActivity(intent)
            } catch (_: Exception) {
                openAppSettings()
            }
        }

        findViewById<Button>(R.id.btnOpenAppSettings).setOnClickListener {
            openAppSettings()
        }

        findViewById<Button>(R.id.btnContinue).setOnClickListener {
            finish()
        }
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
    }

    private fun openAppSettings() {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
        } catch (_: Exception) {}
    }

    private fun updateStatus() {
        // 1. Notifications
        val statusNotif = findViewById<TextView>(R.id.statusNotification)
        val btnNotif = findViewById<Button>(R.id.btnGrantNotification)
        val notifGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        if (notifGranted) {
            statusNotif.text = "✅"
            btnNotif.isEnabled = false
            btnNotif.text = "Enabled"
        } else {
            statusNotif.text = "⚠️"
            btnNotif.isEnabled = true
            btnNotif.text = "Enable"
        }

        // 2. Full Screen Intent (Android 14+)
        val statusFull = findViewById<TextView>(R.id.statusFullScreen)
        val btnFull = findViewById<Button>(R.id.btnGrantFullScreen)
        val fullGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.canUseFullScreenIntent()
        } else {
            true
        }
        if (fullGranted) {
            statusFull.text = "✅"
            btnFull.isEnabled = false
            btnFull.text = "Allowed"
        } else {
            statusFull.text = "⚠️"
            btnFull.isEnabled = true
            btnFull.text = "Allow"
        }

        // 3. Battery Optimizations
        val statusBat = findViewById<TextView>(R.id.statusBattery)
        val btnBat = findViewById<Button>(R.id.btnGrantBattery)
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        val batteryIgnored = pm?.isIgnoringBatteryOptimizations(packageName) == true
        if (batteryIgnored) {
            statusBat.text = "✅"
            btnBat.isEnabled = false
            btnBat.text = "Excluded"
        } else {
            statusBat.text = "⚠️"
            btnBat.isEnabled = true
            btnBat.text = "Exclude"
        }

        // 4. Do Not Disturb Access
        val statusDnd = findViewById<TextView>(R.id.statusDnd)
        val btnDnd = findViewById<Button>(R.id.btnGrantDnd)
        val nm = getSystemService(NotificationManager::class.java)
        val dndGranted = nm.isNotificationPolicyAccessGranted
        if (dndGranted) {
            statusDnd.text = "✅"
            btnDnd.isEnabled = false
            btnDnd.text = "Allowed"
        } else {
            statusDnd.text = "⚠️"
            btnDnd.isEnabled = true
            btnDnd.text = "Setup"
        }
    }
}
