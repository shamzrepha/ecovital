package com.ecovital.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.google.firebase.messaging.FirebaseMessaging

class MainActivity : AppCompatActivity() {

    companion object {
        const val BASE_URL = "https://ecovital-phi.vercel.app"
        const val DASHBOARD_URL = "$BASE_URL/dashboard"
        private const val TAG = "EcoVitalMain"
    }

    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var offlineView: View
    private lateinit var btnRetry: Button
    private lateinit var rootContainer: View

    private var hasLoadedSuccessfully = false

    private val requestNotificationLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        Log.i(TAG, "Notification permission granted: $isGranted")
        if (isGranted) {
            setupFCM()
        }
    }

    // Real-time receiver to auto-update / reload content when an alert push arrives
    private val pushReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val targetUrl = intent?.getStringExtra("target_url")
            runOnUiThread {
                if (!targetUrl.isNullOrEmpty() && targetUrl != webView.url) {
                    webView.loadUrl(targetUrl)
                } else {
                    webView.reload()
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        rootContainer = findViewById(R.id.rootContainer)
        webView = findViewById(R.id.webView)
        swipeRefresh = findViewById(R.id.swipeRefresh)
        offlineView = findViewById(R.id.offlineView)
        btnRetry = findViewById(R.id.btnRetry)

        setupWindowInsets()
        setupCookies()
        setupWebView()
        setupBackNavigation()
        setupFCM()

        promptNotificationPermissionIfNeeded()

        btnRetry.setOnClickListener {
            offlineView.visibility = View.GONE
            webView.visibility = View.VISIBLE
            webView.reload()
        }

        swipeRefresh.setOnRefreshListener {
            webView.reload()
        }

        // Check if opened from notification with specific pod URL
        val targetUrl = intent?.getStringExtra("target_url") ?: DASHBOARD_URL
        webView.loadUrl(targetUrl)

        checkFirstRunPermissions()
    }

    private fun promptNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.POST_NOTIFICATIONS
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                requestNotificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private fun setupWindowInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(rootContainer) { view, windowInsets ->
            val statusBars = windowInsets.getInsets(WindowInsetsCompat.Type.statusBars())
            val navBars = windowInsets.getInsets(WindowInsetsCompat.Type.navigationBars())
            view.setPadding(0, statusBars.top, 0, navBars.bottom)
            windowInsets
        }
    }

    override fun onResume() {
        super.onResume()
        try {
            val filter = IntentFilter(EcoFirebaseMessagingService.ACTION_PUSH_ALERT)
            ContextCompat.registerReceiver(
                this,
                pushReceiver,
                filter,
                ContextCompat.RECEIVER_NOT_EXPORTED
            )
        } catch (e: Exception) {
            e.printStackTrace()
        }

        checkAndSyncSession()
    }

    override fun onPause() {
        super.onPause()
        try {
            unregisterReceiver(pushReceiver)
        } catch (_: Exception) {}
        CookieManager.getInstance().flush()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val targetUrl = intent.getStringExtra("target_url")
        if (!targetUrl.isNullOrEmpty()) {
            webView.loadUrl(targetUrl)
        } else {
            webView.reload()
        }
    }

    private fun setupCookies() {
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(webView, false)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        // Register native bridge for web settings page
        webView.addJavascriptInterface(
            AndroidBridge(this) {
                // Test alarm trigger
                AlarmService.startAlarm(
                    context = this,
                    podId = "test-pod",
                    podName = "Demo Pod (Test)",
                    title = "🚨 Emergency Siren Test",
                    cause = "smoke",
                    body = "Testing phone emergency siren over lock screen."
                )
            },
            "AndroidBridge"
        )

        webView.webChromeClient = WebChromeClient()

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                swipeRefresh.isRefreshing = true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                swipeRefresh.isRefreshing = false
                hasLoadedSuccessfully = true
                offlineView.visibility = View.GONE
                webView.visibility = View.VISIBLE

                CookieManager.getInstance().flush()
                checkAndSyncSession()

                // Inject JavaScript to sync token via WebView's active authenticated session
                val prefs = getSharedPreferences("ecovital_prefs", Context.MODE_PRIVATE)
                val token = prefs.getString("fcm_token", null)
                if (!token.isNullOrEmpty()) {
                    injectFcmSync(token)
                }
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    swipeRefresh.isRefreshing = false
                    if (!isOnline()) {
                        webView.visibility = View.GONE
                        offlineView.visibility = View.VISIBLE
                    }
                }
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url?.toString() ?: return false
                // Internal app URLs stay inside WebView
                if (url.startsWith(BASE_URL) || url.startsWith("/")) {
                    return false
                }
                // External URLs open in system browser
                try {
                    val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    startActivity(browserIntent)
                    return true
                } catch (_: Exception) {
                    return false
                }
            }
        }
    }

    private fun injectFcmSync(token: String) {
        val js = """
            (function() {
                try {
                    fetch('/api/fcm', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token: '$token', platform: 'android' })
                    }).catch(function(e) {});
                } catch(e) {}
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    private fun setupFCM() {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                Log.w(TAG, "Fetching FCM registration token failed", task.exception)
                return@addOnCompleteListener
            }
            val token = task.result
            if (!token.isNullOrEmpty()) {
                Log.i(TAG, "FCM Token obtained: $token")
                val prefs = getSharedPreferences("ecovital_prefs", Context.MODE_PRIVATE)
                prefs.edit().putString("fcm_token", token).apply()
                checkAndSyncSession()
                runOnUiThread {
                    injectFcmSync(token)
                }
            }
        }
    }

    private fun checkAndSyncSession() {
        val prefs = getSharedPreferences("ecovital_prefs", Context.MODE_PRIVATE)
        val token = prefs.getString("fcm_token", null) ?: return
        EcoFirebaseMessagingService.syncFcmTokenWithServer(token)
    }

    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val network = cm.activeNetwork ?: return false
        val capabilities = cm.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun checkFirstRunPermissions() {
        val prefs = getSharedPreferences("ecovital_prefs", Context.MODE_PRIVATE)
        val hasSeenSetup = prefs.getBoolean("has_seen_perm_setup", false)
        if (!hasSeenSetup) {
            prefs.edit().putBoolean("has_seen_perm_setup", true).apply()
            val intent = Intent(this, PermissionsActivity::class.java)
            startActivity(intent)
        }
    }
}
