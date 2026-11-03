"use client";

import Link from "next/link";

export default function DownloadPage() {
  return (
    <div className="wrap">
      <header className="top">
        <span className="brand">EcoVital Android App</span>
        <span className="crumb">Emergency lock-screen siren for smoke, gas, and severe air events</span>
      </header>

      <main style={{ maxWidth: 720, margin: "24px auto" }}>
        <div className="card" style={{ padding: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
            <img src="/assets/logo.png" alt="EcoVital App Logo" style={{ width: 64, height: 64, borderRadius: 12 }} />
            <div>
              <h2 style={{ margin: 0 }}>EcoVital Native Companion</h2>
              <div style={{ color: "#059669", fontSize: 14, fontWeight: 600 }}>Version 1.1.0 (Latest Release) • Android 8.0 to 15</div>
            </div>
          </div>

          <div style={{ background: "#FEF2F2", border: "1px solid #F87171", borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <h3 style={{ margin: "0 0 6px 0", color: "#991B1B", fontSize: 16 }}>🚨 Why install the native app?</h3>
            <p style={{ margin: 0, color: "#7F1D1D", fontSize: 14, lineHeight: 1.5 }}>
              Web browsers cannot pierce silent mode or display alarms over a locked screen. The native Android companion
              rings a loud emergency siren and launches full-screen directly over your phone’s lock screen whenever your pod detects smoke, gas, or hazardous air.
            </p>
          </div>

          <div style={{ textAlign: "center", margin: "28px 0" }}>
            <a
              href="/downloads/ecovital-app.apk"
              download="ecovital-app.apk"
              className="btn primary"
              style={{ fontSize: 18, padding: "14px 28px", textDecoration: "none", display: "inline-block" }}
            >
              📥 Download Android APK (7.9 MB)
            </a>
            <div style={{ color: "#64748B", fontSize: 12, marginTop: 8 }}>
              Direct install for Android phones • No app store account needed
            </div>
          </div>

          <h3 style={{ borderTop: "1px solid #E2E8F0", paddingTop: 20, marginTop: 24 }}>Quick Installation Guide</h3>
          <ol style={{ fontSize: 14, lineHeight: 1.6, paddingLeft: 20, color: "#334155" }}>
            <li>Tap the <b>Download Android APK</b> button above on your Android phone.</li>
            <li>When prompted, tap <b>Open</b> or tap the downloaded file in your notification bar.</li>
            <li>If asked to allow installs from your browser, tap <b>Settings</b> and switch on <i>Allow from this source</i>.</li>
            <li>Tap <b>Install</b>, then open EcoVital.</li>
            <li>Grant the requested permissions (Notifications, Full-screen lock-screen alert, and Exclude from battery saving) so alarms sound when you sleep.</li>
            <li>Sign in with your account to link your pods and phone sirens automatically.</li>
          </ol>

          <h3 style={{ borderTop: "1px solid #E2E8F0", paddingTop: 20, marginTop: 24 }}>Developer / USB Debugging</h3>
          <p style={{ fontSize: 14, color: "#334155" }}>
            To install via USB debugging using Android ADB from your computer:
          </p>
          <pre style={{ background: "#0F172A", color: "#38BDF8", padding: 12, borderRadius: 6, fontSize: 13, overflowX: "auto" }}>
adb install -r public/downloads/ecovital-app.apk
          </pre>

          <div style={{ marginTop: 28, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Link href="/dashboard" className="btn">
              ← Return to Dashboard
            </Link>
            <Link href="/settings" className="btn small">
              Settings &amp; Alarm Status
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
