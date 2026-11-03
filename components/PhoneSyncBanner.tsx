"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";

export default function PhoneSyncBanner() {
  const [isAndroidApp, setIsAndroidApp] = useState(false);
  const [fcmToken, setFcmToken] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    // Check if running in Android Companion App WebView
    const checkBridge = () => {
      if (typeof window !== "undefined") {
        const bridge = (window as any).AndroidBridge;
        if (bridge) {
          setIsAndroidApp(true);
          const t = bridge.getFcmToken?.();
          if (t) {
            setFcmToken(t);
            // Auto sync token on dashboard load
            fetch("/api/fcm", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ token: t, platform: "android" }),
            })
              .then((r) => r.json())
              .then((j) => {
                if (j.ok) {
                  setStatusMsg("Phone alerts linked & active");
                }
              })
              .catch(() => {});
          }
        }
      }
    };

    checkBridge();
    const timer = setTimeout(checkBridge, 600);
    return () => clearTimeout(timer);
  }, []);

  const handleManualSync = async () => {
    setIsSyncing(true);
    setStatusMsg("Syncing phone token with your EcoVital account...");
    try {
      let token = fcmToken;
      if (typeof window !== "undefined" && (window as any).AndroidBridge) {
        token = (window as any).AndroidBridge.getFcmToken?.() || (window as any).AndroidBridge.syncToken?.() || "";
      }

      if (!token) {
        setStatusMsg("Initializing FCM on device. If this persists, restart the app.");
        setIsSyncing(false);
        return;
      }

      const res = await fetch("/api/fcm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, platform: "android" }),
      });
      const j = await res.json();
      if (j.ok) {
        setStatusMsg("✅ Phone successfully synced! Emergency sirens are ready.");
      } else {
        setStatusMsg(`Sync error: ${j.error || "Failed to register"}`);
      }
    } catch (e: any) {
      setStatusMsg(`Sync error: ${e?.message ?? e}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleTestAlarm = () => {
    // 1. If in Android app, trigger native AlarmService & AlarmActivity
    if (typeof window !== "undefined" && (window as any).AndroidBridge?.testAlarm) {
      (window as any).AndroidBridge.testAlarm();
    }
    // 2. Also trigger the web EmergencySosOverlay
    if (typeof window !== "undefined" && (window as any).triggerTestSos) {
      (window as any).triggerTestSos({
        title: "🚨 EMERGENCY SIREN TEST",
        message: "Testing emergency alarm overlay and ambulance siren sound.",
        cause: "gas",
      });
    }
  };

  return (
    <div
      style={{
        margin: "0 0 20px",
        padding: "16px 20px",
        borderRadius: 14,
        background: isAndroidApp
          ? "linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(5, 150, 105, 0.08))"
          : "linear-gradient(135deg, rgba(59, 130, 246, 0.08), rgba(245, 158, 11, 0.08))",
        border: isAndroidApp ? "1.5px solid rgba(16, 185, 129, 0.4)" : "1.5px solid rgba(59, 130, 246, 0.25)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 20 }}>{isAndroidApp ? "🟢" : "📱"}</span>
            <strong style={{ fontSize: 16 }}>
              {isAndroidApp ? "Android Companion App: Phone Alarm Connected" : "Emergency Phone Alerts & Siren"}
            </strong>
          </div>
          <p style={{ margin: "2px 0 8px", fontSize: 13.5, color: "var(--ink2)", maxWidth: 640 }}>
            {isAndroidApp
              ? "Your Android phone is paired. In case of dangerous smoke or gas, an ambulance siren will ring over your lock screen with 1-tap 112 emergency calling."
              : "Pair your Android phone to receive non-stop ambulance sirens over your lock screen and instant 1-tap Nigerian emergency calling (112) when gas or smoke is detected."}
          </p>
          {statusMsg && (
            <div style={{ fontSize: 13, fontWeight: 600, color: statusMsg.startsWith("✅") ? "var(--good)" : "var(--watch)", marginTop: 4 }}>
              {statusMsg}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {isAndroidApp ? (
            <>
              <button
                type="button"
                className="btn small"
                onClick={handleManualSync}
                disabled={isSyncing}
                style={{ fontWeight: 600 }}
              >
                🔄 {isSyncing ? "Syncing…" : "Sync Phone Alerts"}
              </button>
              <button
                type="button"
                className="btn small danger"
                onClick={handleTestAlarm}
                style={{ fontWeight: 600 }}
              >
                🚨 Test Alarm Siren
              </button>
              <Link href="/settings" className="btn small" style={{ fontWeight: 600 }}>
                ⚙ Settings
              </Link>
            </>
          ) : (
            <>
              <Link href="/download" className="btn small primary" style={{ fontWeight: 600 }}>
                📲 Get Android App
              </Link>
              <button
                type="button"
                className="btn small danger"
                onClick={handleTestAlarm}
                style={{ fontWeight: 600 }}
                title="Preview the full-screen emergency red alert overlay & ambulance siren"
              >
                🚨 Test SOS Alert Overlay
              </button>
              <Link href="/settings" className="btn small" style={{ fontWeight: 600 }}>
                ⚙ Settings
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
