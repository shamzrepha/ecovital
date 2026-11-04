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
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
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
    private var isNetworkCallbackRegistered = false
    private val mainHandler = Handler(Looper.getMainLooper())

    private val permissionsLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        Log.i(TAG, "Returned from PermissionsActivity, loading dashboard")
        loadDashboard()
    }

    private val requestNotificationLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        Log.i(TAG, "Notification permission granted: $isGranted")
        if (isGranted) {
            setupFCM()
        }
    }

    // Network callback to automatically recover when internet is restored
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            Log.i(TAG, "Network became available, auto-retrying dashboard")
            mainHandler.post {
                if (!hasLoadedSuccessfully || offlineView.visibility == View.VISIBLE) {
                    offlineView.visibility = View.GONE
                    webView.visibility = View.VISIBLE
                    loadDashboard()
                }
            }
        }

        override fun onLost(network: Network) {
            Log.w(TAG, "Network lost")
        }
    }

    // Real-time receiver to auto-update / reload content or launch alarm when an alert push arrives
    private val pushReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val type = intent?.getStringExtra("type")
            if (type == "alarm") {
                val alarmIntent = Intent(this@MainActivity, AlarmActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    putExtra(AlarmService.EXTRA_POD_ID, intent.getStringExtra("podId"))
                    putExtra(AlarmService.EXTRA_CAUSE, intent.getStringExtra("cause"))
                    putExtra(AlarmService.EXTRA_TITLE, intent.getStringExtra("title"))
                    putExtra(AlarmService.EXTRA_BODY, intent.getStringExtra("body"))
                }
                startActivity(alarmIntent)
                return
            }

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
        setupNetworkCallback()
        setupFCM()

        promptNotificationPermissionIfNeeded()

        btnRetry.setOnClickListener {
            offlineView.visibility = View.GONE
            webView.visibility = View.VISIBLE
            swipeRefresh.isRefreshing = true
            loadDashboard()
        }

        swipeRefresh.setOnRefreshListener {
            offlineView.visibility = View.GONE
            webView.visibility = View.VISIBLE
            loadDashboard()
        }

        val prefs = getSharedPreferences("ecovital_prefs", Context.MODE_PRIVATE)
        val hasSeenSetup = prefs.getBoolean("has_seen_perm_setup", false)
        if (!hasSeenSetup) {
            prefs.edit().putBoolean("has_seen_perm_setup", true).apply()
            val intent = Intent(this, PermissionsActivity::class.java)
            permissionsLauncher.launch(intent)
        } else {
            loadDashboard()
        }
    }

    private fun loadDashboard() {
        val target = intent?.getStringExtra("target_url")
        val urlToLoad = if (!target.isNullOrEmpty()) {
            target
        } else if (!webView.url.isNullOrEmpty() && webView.url != "about:blank") {
            webView.url!!
        } else {
            DASHBOARD_URL
        }
        Log.i(TAG, "loadDashboard -> $urlToLoad")
        webView.loadUrl(urlToLoad)
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

    private fun setupNetworkCallback() {
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            cm.registerNetworkCallback(request, networkCallback)
            isNetworkCallbackRegistered = true
        } catch (e: Exception) {
            Log.w(TAG, "Could not register network callback", e)
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
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

        // If previously failed or offline view is up, attempt auto-reload when returning to foreground
        if (!hasLoadedSuccessfully || offlineView.visibility == View.VISIBLE) {
            loadDashboard()
        }
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
        try {
            unregisterReceiver(pushReceiver)
        } catch (_: Exception) {}
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isNetworkCallbackRegistered) {
            try {
                val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                cm?.unregisterNetworkCallback(networkCallback)
            } catch (_: Exception) {}
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val targetUrl = intent.getStringExtra("target_url")
        if (!targetUrl.isNullOrEmpty()) {
            webView.loadUrl(targetUrl)
        } else {
            loadDashboard()
        }
    }

    private fun setupCookies() {
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(webView, true)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        // Sanitize User-Agent to avoid Vercel edge/WAF bot-detection dropping embedded WebViews
        val defaultUa = settings.userAgentString
        settings.userAgentString = defaultUa.replace("; wv", "").replace(Regex("Version/\\d+\\.\\d+\\s*"), "")

        // Register native bridge for web settings page and emergency overlay
        val bridge = AndroidBridge(this) {
            // Test alarm trigger
            AlarmService.startAlarm(
                context = this,
                podId = "test-pod",
                podName = "Demo Pod (Test)",
                title = "🚨 Emergency Siren Test",
                cause = "smoke",
                body = "Testing phone emergency siren over lock screen."
            )
            // Also launch AlarmActivity immediately
            val alarmIntent = Intent(this, AlarmActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
                putExtra(AlarmService.EXTRA_POD_ID, "test-pod")
                putExtra(AlarmService.EXTRA_POD_NAME, "Demo Pod (Test)")
                putExtra(AlarmService.EXTRA_TITLE, "🚨 Emergency Siren Test")
                putExtra(AlarmService.EXTRA_CAUSE, "smoke")
                putExtra(AlarmService.EXTRA_BODY, "Testing phone emergency siren over lock screen.")
            }
            startActivity(alarmIntent)
        }
        webView.addJavascriptInterface(bridge, "AndroidBridge")
        webView.addJavascriptInterface(bridge, "Android")

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
                    val errorCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) error?.errorCode else null
                    val desc = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) error?.description else null
                    Log.w(TAG, "onReceivedError main frame: $errorCode - $desc on ${request.url}")

                    swipeRefresh.isRefreshing = false
                    // Show friendly retry UI instead of dead blank Chromium error
                    webView.visibility = View.GONE
                    offlineView.visibility = View.VISIBLE
                }
            }

            override fun onReceivedSslError(
                view: WebView?,
                handler: SslErrorHandler?,
                error: SslError?
            ) {
                Log.e(TAG, "onReceivedSslError: ${error?.primaryError} on ${error?.url}")
                super.onReceivedSslError(view, handler, error)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url?.toString() ?: return false

                // Handle Nigerian Emergency Number or phone dialer links
                if (url.startsWith("tel:")) {
                    try {
                        val dialIntent = Intent(Intent.ACTION_DIAL, Uri.parse(url)).apply {
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        }
                        startActivity(dialIntent)
                        return true
                    } catch (_: Exception) {
                        return false
                    }
                }

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
}
