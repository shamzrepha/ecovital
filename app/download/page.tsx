"use client";

import Link from "next/link";

export default function DownloadPage() {
  return (
    <div className="wrap">
      <header className="top">
        <span className="brand">EcoVital Android App</span>
        <span className="crumb">Emergency lock-screen siren, 112 emergency dialer, and full-screen red SOS overlay</span>
      </header>

      <main style={{ maxWidth: 720, margin: "24px auto" }}>
        <div className="card" style={{ padding: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
            <img src="/assets/logo.png" alt="EcoVital App Logo" style={{ width: 64, height: 64, borderRadius: 12 }} />
            <div>
              <h2 style={{ margin: 0 }}>EcoVital Native Companion</h2>
              <div style={{ color: "#059669", fontSize: 14, fontWeight: 700 }}>Version 1.2.0 (Latest Release) • Android 8.0 to 15</div>
            </div>
          </div>

          <div style={{ background: "#FEF2F2", border: "1.5px solid #F87171", borderRadius: 10, padding: 18, marginBottom: 20 }}>
            <h3 style={{ margin: "0 0 6px 0", color: "#991B1B", fontSize: 16, display: "flex", alignItems: "center", gap: 6 }}>
              🚨 Emergency Lock-Screen Siren &amp; 112 Dialer
            </h3>
            <p style={{ margin: 0, color: "#7F1D1D", fontSize: 14, lineHeight: 1.5 }}>
              Standard web browsers cannot pierce silent mode or display alarms over a locked screen. The native Android companion
              rings a continuous loud ambulance siren, vibrates persistently, and pops up a full-screen red SOS overlay with 1-tap
              calling to Nigerian Emergency Services (112) whenever your pod detects smoke, gas, or hazardous air.
            </p>
          </div>

          <div style={{ textAlign: "center", margin: "28px 0" }}>
            <a
              href="/downloads/ecovital-app.apk"
              download="ecovital-app.apk"
              className="btn primary"
              style={{ fontSize: 18, padding: "14px 28px", textDecoration: "none", display: "inline-block", fontWeight: 700 }}
            >
              📥 Download Android APK v1.2.0 (8.0 MB)
            </a>
            <div style={{ color: "#64748B", fontSize: 12, marginTop: 8 }}>
              Direct install for Android phones • No Google Play Store account needed
            </div>
          </div>

          <div style={{ background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 8, padding: 14, marginBottom: 20 }}>
            <strong style={{ color: "#166534", fontSize: 14 }}>✨ What's New in Version 1.2.0:</strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 20, fontSize: 13.5, color: "#14532D", lineHeight: 1.5 }}>
              <li><b>1-Tap Nigerian Emergency Dialer (112)</b> directly from alarm screen &amp; notification.</li>
              <li><b>Continuous Ambulance Siren</b> playing non-stop until acknowledged.</li>
              <li><b>Dedicated Settings Navigation</b> on mobile tab bar and header.</li>
              <li><b>Automatic Phone Alert Sync</b> linking your phone on launch.</li>
              <li><b>Flashing Red SOS Overlay</b> with instant emergency guidance.</li>
            </ul>
          </div>

          <h3 style={{ borderTop: "1px solid #E2E8F0", paddingTop: 20, marginTop: 24 }}>Quick Installation Guide</h3>
          <ol style={{ fontSize: 14, lineHeight: 1.6, paddingLeft: 20, color: "#334155" }}>
            <li>Tap the <b>Download Android APK</b> button above on your Android phone.</li>
            <li>When prompted, tap <b>Open</b> or tap the downloaded file in your notification bar.</li>
            <li>If asked to allow installs from your browser, tap <b>Settings</b> and switch on <i>Allow from this source</i>.</li>
            <li>Tap <b>Install</b> (or Update), then open EcoVital.</li>
            <li>Grant the requested permissions (Notifications &amp; Lock-Screen Alert) so alarms ring when you sleep.</li>
            <li>Sign in with your account to pair phone sirens automatically.</li>
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
              ⚙ Settings &amp; Alarm Status
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
