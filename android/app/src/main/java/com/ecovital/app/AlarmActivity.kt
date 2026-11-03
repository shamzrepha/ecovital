package com.ecovital.app

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class AlarmActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Wake screen and show over keyguard
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            km?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContentView(R.layout.activity_alarm)

        val podId = intent.getStringExtra(AlarmService.EXTRA_POD_ID) ?: ""
        val podName = intent.getStringExtra(AlarmService.EXTRA_POD_NAME) ?: "Living Room Pod"
        val cause = intent.getStringExtra(AlarmService.EXTRA_CAUSE) ?: "gas"

        val tvPodName = findViewById<TextView>(R.id.tvPodName)
        val tvCause = findViewById<TextView>(R.id.tvCause)
        val tvAdvice = findViewById<TextView>(R.id.tvAdvice)
        val btnStop = findViewById<Button>(R.id.btnStopAlarm)
        val btnOpen = findViewById<Button>(R.id.btnOpenPod)

        tvPodName.text = "Pod: $podName"

        val isSmoke = cause.contains("smoke", ignoreCase = true)
        if (isSmoke) {
            tvCause.text = "Smoke or burning likely"
            tvAdvice.text = "Open windows, check for fire, evacuate if necessary."
        } else {
            tvCause.text = "Possible gas or fumes"
            tvAdvice.text = "Open windows, put out flames, leave if you smell gas."
        }

        btnStop.setOnClickListener {
            AlarmService.stopAlarm(this)
            finish()
        }

        btnOpen.setOnClickListener {
            AlarmService.stopAlarm(this)
            val mainIntent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                if (podId.isNotEmpty()) {
                    putExtra("target_url", "https://ecovital-phi.vercel.app/pods/$podId")
                } else {
                    putExtra("target_url", "https://ecovital-phi.vercel.app/dashboard")
                }
            }
            startActivity(mainIntent)
            finish()
        }
    }

    @Deprecated("Deprecated in Java", ReplaceWith("Unit"))
    override fun onBackPressed() {
        // Disallow dismissing critical alarm with back button; user must tap Stop Alarm
    }
}
