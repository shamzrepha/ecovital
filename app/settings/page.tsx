"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { METRICS, METRIC_KEYS, type MetricKey } from "@/lib/config";

export default function SettingsPage() {
  const [name, setName] = useState("Shamaryah");
  const [email, setEmail] = useState("shamaryah@futo.edu.ng");
  const [language, setLanguage] = useState<"en-NG" | "pcm" | "ig" | "yo" | "ha">("en-NG");
  const [voice, setVoice] = useState("Kore");
  const [voiceSpeed, setVoiceSpeed] = useState<"slow" | "normal" | "fast">("normal");
  const [quietStart, setQuietStart] = useState(22);
  const [quietEnd, setQuietEnd] = useState(7);
  const [notifyMetrics, setNotifyMetrics] = useState<Record<MetricKey, boolean>>({
    dust: true,
    air: true,
    temp: true,
    hum: true,
  });
  const [notifications, setNotifications] = useState<any[]>([]);
  const [pushStatus, setPushStatus] = useState<string>("Checking alert status…");
  const [isAndroidApp, setIsAndroidApp] = useState(false);
  const [fcmToken, setFcmToken] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    if (typeof window !== "undefined") {
      const bridge = (window as any).AndroidBridge;
      if (bridge) {
        setIsAndroidApp(true);
        const bridgeToken = bridge.getFcmToken?.() || bridge.syncToken?.();
        if (bridgeToken) {
          setFcmToken(bridgeToken);
          fetch("/api/fcm", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: bridgeToken, platform: "android" }),
          })
            .then((r) => r.json())
            .then((j) => {
              if (j.ok) {
                setPushStatus("Active: Native Android Companion App paired for sirens");
              }
            })
            .catch(() => {});
        }
      } else if ("Notification" in window) {
        setPushStatus(`Browser permission: ${Notification.permission}`);
      }
    }

    const res = await fetch("/api/user", { cache: "no-store" });
    const j = await res.json();
    if (j.user) {
      setName(j.user.name || "Shamaryah");
      setEmail(j.user.email || "shamaryah@futo.edu.ng");
      setLanguage(j.user.language || "en-NG");
      setVoice(j.user.voice || "Kore");
      setVoiceSpeed(j.user.voiceSpeed || "normal");
      setQuietStart(j.user.quietStart ?? 22);
      setQuietEnd(j.user.quietEnd ?? 7);
      if (j.user.notifyMetrics) setNotifyMetrics(j.user.notifyMetrics);
    }
    setNotifications(j.notifications || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg("Saving account and preferences...");
    const res = await fetch("/api/user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        email,
        language,
        voice,
        voiceSpeed,
        quietStart,
        quietEnd,
        notifyMetrics,
      }),
    });
    const j = await res.json();
    setMsg(j.ok ? "Preferences saved!" : j.error || "Save failed");
    load();
  }

  function urlBase64ToUint8Array(base64String: string) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/\-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function syncAndroidToken() {
    try {
      setMsg("Syncing Android phone token with your EcoVital account...");
      let t = fcmToken;
      if (typeof window !== "undefined" && (window as any).AndroidBridge) {
        t = (window as any).AndroidBridge.getFcmToken?.() || (window as any).AndroidBridge.syncToken?.() || "";
      }
      if (!t) {
        setMsg("Initializing FCM token on device. Please wait a few seconds and tap again.");
        return;
      }
      const r = await fetch("/api/fcm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: t, platform: "android" }),
      });
      const j = await r.json();
      if (j.ok) {
        setMsg("✅ Android phone alerts successfully linked to your account!");
        setPushStatus("Active: Native Android Companion App linked");
      } else {
        setMsg(`Sync failed: ${j.error || "Unknown server error"}`);
      }
    } catch (e: any) {
      setMsg(`Sync error: ${e?.message ?? e}`);
    }
  }

  async function requestBrowserNotifications() {
    // If inside Android companion app, use native phone sync instead of web push!
    if (isAndroidApp || (typeof window !== "undefined" && (window as any).AndroidBridge)) {
      await syncAndroidToken();
      return;
    }

    if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
      setPushStatus("Web Push is not supported in this browser. Please use the EcoVital Android App.");
      return;
    }

    try {
      const perm = await Notification.requestPermission();
      setPushStatus(`Browser permission: ${perm}`);
      if (perm !== "granted") {
        setMsg("Notification permission not granted. Please allow notifications in your browser settings.");
        return;
      }

      let reg: ServiceWorkerRegistration;
      try {
        reg = await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;
      } catch (swErr: any) {
        setPushStatus(`Service Worker error: ${swErr?.message ?? swErr}`);
        return;
      }

      const vapidRes = await fetch("/api/push");
      const { vapidPublicKey } = await vapidRes.json();
      if (!vapidPublicKey) {
        setPushStatus("VAPID public key not configured on server.");
        return;
      }

      let old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe().catch(() => {});

      let sub: PushSubscription;
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        });
      } catch (subErr: any) {
        console.error("Push subscribe error", subErr);
        setPushStatus(`Push setup: Browser push registration failed (${subErr?.message || "unsupported"}). On mobile, use the EcoVital Android App.`);
        return;
      }

      const saveRes = await fetch("/api/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sub),
      });
      const saveJson = await saveRes.json();
      if (saveJson.ok) {
        setPushStatus("Active! Browser push alerts enabled (even with app closed).");
        setMsg("Browser notifications enabled!");
      } else {
        setPushStatus(`Failed to save subscription: ${saveJson.error || "error"}`);
      }
    } catch (e: any) {
      setPushStatus(`Push setup: ${e?.message ?? e}`);
    }
  }

  async function testPushNotification() {
    try {
      setMsg("Sending test notification to your device...");
      const res = await fetch("/api/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ testSend: true }),
      });
      const j = await res.json();
      if (j.ok && j.sent > 0) {
        setMsg(`Delivered alert to ${j.sent} device(s)!`);
      } else if (j.ok && j.sent === 0) {
        setMsg("No active phone registration found. Tap 'Sync Phone Alerts' or 'Enable Push' first.");
      } else {
        setMsg(j.error || "Test failed");
      }
      load();
    } catch (e: any) {
      setMsg(`Test failed: ${e?.message ?? e}`);
    }
  }

  async function triggerTestAlarm() {
    try {
      setMsg("Triggering emergency alarm test to your Android phone...");
      if (typeof window !== "undefined" && (window as any).AndroidBridge?.testAlarm) {
        (window as any).AndroidBridge.testAlarm();
      }
      if (typeof window !== "undefined" && (window as any).AndroidBridge?.getFcmToken) {
        const t = (window as any).AndroidBridge.getFcmToken();
        if (t) {
          await fetch("/api/fcm", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: t, platform: "android" }),
          }).catch(() => {});
        }
      }
      // Trigger Web Red SOS Overlay as well
      if (typeof window !== "undefined" && (window as any).triggerTestSos) {
        (window as any).triggerTestSos({
          title: "🚨 Emergency Siren Test",
          message: "Testing emergency red alert overlay with Nigerian 112 emergency dialer.",
          cause: "gas",
        });
      }

      const res = await fetch("/api/fcm/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ podId: "settings-test" }),
      });
      const j = await res.json();
      if (j.ok) {
        setMsg(`🚨 Emergency alarm dispatched! (${j.sent} phone(s) notified with siren & 112 overlay)`);
      } else {
        setMsg(`Alarm test: ${j.error || "Failed"}`);
      }
    } catch (e: any) {
      setMsg(`Alarm test error: ${e?.message ?? e}`);
    }
  }

  async function deleteAccountAndData() {
    if (!confirm("Delete your account, chat history, and notification logs, and unclaim your pods?")) return;
    const res = await fetch("/api/user", { method: "DELETE" });
    const j = await res.json();
    setMsg(j.message || "Deleted.");
    load();
  }

  return (
    <div className="wrap">
      <header className="top">
        <span className="brand">Settings, Voice &amp; Notifications</span>
        <span className="crumb">Account, Nigerian languages, quiet hours, and data privacy</span>
      </header>

      {msg && <div className="banner info" role="status">{msg}</div>}

      {/* Prominent Phone Alerts & Lock-Screen Siren Card */}
      <section
        style={{
          margin: "16px 0 24px",
          padding: "18px 22px",
          borderRadius: 14,
          background: isAndroidApp
            ? "linear-gradient(135deg, rgba(16, 185, 129, 0.14), rgba(5, 150, 105, 0.08))"
            : "linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(245, 158, 11, 0.08))",
          border: isAndroidApp ? "2px solid #10b981" : "2px solid rgba(59, 130, 246, 0.35)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 14 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 22 }}>{isAndroidApp ? "🟢" : "📱"}</span>
              <h2 style={{ fontSize: 18, margin: 0, fontWeight: 700 }}>
                {isAndroidApp ? "Phone Alarm: Active (Android Companion App)" : "Emergency Phone Alarm & Siren"}
              </h2>
            </div>
            <p style={{ margin: "2px 0 8px", fontSize: 14, color: "var(--ink2)", maxWidth: 660, lineHeight: 1.5 }}>
              {isAndroidApp
                ? "Your phone is connected to the native Android shell. In the event of dangerous gas or smoke, your phone will bypass silent mode, play a continuous ambulance siren over your lock screen, and display a 1-tap dialer for Nigerian emergency services (112)."
                : "Want non-stop ambulance sirens that ring over your phone's lock screen and 1-tap 112 emergency calling during smoke or gas hazards? Install the EcoVital Android app or enable browser push notifications."}
            </p>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink2)", marginTop: 4 }}>
              Status: <span style={{ color: "var(--good)" }}>{pushStatus}</span>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {isAndroidApp ? (
              <>
                <button type="button" className="btn small primary" onClick={syncAndroidToken} style={{ fontWeight: 700 }}>
                  🔄 Sync Phone Alerts
                </button>
                <button type="button" className="btn small danger" onClick={triggerTestAlarm} style={{ fontWeight: 700 }}>
                  🚨 Test Alarm Siren (112 Screen)
                </button>
              </>
            ) : (
              <>
                <Link href="/download" className="btn small primary" style={{ fontWeight: 700 }}>
                  📥 Download Android App
                </Link>
                <button type="button" className="btn small" onClick={requestBrowserNotifications} style={{ fontWeight: 600 }}>
                  🔔 Enable Browser Push
                </button>
                <button type="button" className="btn small danger" onClick={triggerTestAlarm} style={{ fontWeight: 700 }}>
                  🚨 Preview SOS Alert Screen
                </button>
              </>
            )}
          </div>
        </div>
      </section>

      <div className="cols">
        <main>
          <form className="card" onSubmit={save}>
            <h2>Account, Voice &amp; Local Languages</h2>
            <div className="grid-2">
              <div className="form-row">
                <label htmlFor="u-name">Owner Name</label>
                <input id="u-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="form-row">
                <label htmlFor="u-email">Email Address</label>
                <input id="u-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            </div>

            <div className="grid-2">
              <div className="form-row">
                <label htmlFor="u-lang">Spoken &amp; Text Language</label>
                <select
                  id="u-lang"
                  className="select"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as any)}
                >
                  <option value="en-NG">English (Nigeria)</option>
                  <option value="pcm">Naija Pidgin (pod speaks Pidgin)</option>
                  <option value="ig">Igbo (pod speaks Igbo)</option>
                  <option value="yo">Yoruba (pod speaks Yoruba)</option>
                  <option value="ha">Hausa (pod speaks Hausa)</option>
                </select>
                <span className="note">
                  This is the default for all your pods. You can choose a different language for one pod on its page. Pidgin, Igbo, Yoruba and Hausa are <b>machine-written</b> and may have mistakes.
                </span>
              </div>

              <div className="form-row">
                <label htmlFor="u-voice">Gemini TTS Voice &amp; Speed</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <select id="u-voice" className="select" value={voice} onChange={(e) => setVoice(e.target.value)}>
                    <option value="Kore">Kore (Clear, calm)</option>
                    <option value="Puck">Puck (Warm)</option>
                    <option value="Aoede">Aoede (Crisp)</option>
                  </select>
                  <select
                    aria-label="Voice speed"
                    className="select"
                    value={voiceSpeed}
                    onChange={(e) => setVoiceSpeed(e.target.value as any)}
                  >
                    <option value="slow">Slow</option>
                    <option value="normal">Normal</option>
                    <option value="fast">Fast</option>
                  </select>
                </div>
              </div>
            </div>

            <h3 style={{ marginTop: 18 }}>Notifications &amp; Quiet Hours</h3>
            <p className="note" style={{ marginTop: 0 }}>
              Every notification includes the room name, metric, value, and one concrete action. Duplicate alerts for the same metric are suppressed for 15 minutes.
            </p>

            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
              {METRIC_KEYS.map((k) => (
                <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(notifyMetrics[k])}
                    onChange={(e) => setNotifyMetrics({ ...notifyMetrics, [k]: e.target.checked })}
                  />
                  {METRICS[k].label}
                </label>
              ))}
            </div>

            <div className="grid-2">
              <div className="form-row">
                <label htmlFor="q-start">Quiet Hours Start (24h clock, e.g. 22 = 10 PM)</label>
                <input
                  id="q-start"
                  type="number"
                  min={0}
                  max={23}
                  className="input"
                  value={quietStart}
                  onChange={(e) => setQuietStart(Number(e.target.value))}
                />
              </div>
              <div className="form-row">
                <label htmlFor="q-end">Quiet Hours End (24h clock, e.g. 7 = 7 AM)</label>
                <input
                  id="q-end"
                  type="number"
                  min={0}
                  max={23}
                  className="input"
                  value={quietEnd}
                  onChange={(e) => setQuietEnd(Number(e.target.value))}
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
              <button type="submit" className="btn primary">
                Save Preferences
              </button>
              <button type="button" className="btn small" onClick={testPushNotification}>
                📲 Send Test Phone Alert
              </button>
            </div>
          </form>

          <section className="card">
            <h2>Data Export &amp; Account Privacy</h2>
            <p className="note">
              Export a pod’s readings as CSV from its page or from the home screen. You can also delete your account and personal data here, which unlinks all your pods.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" className="btn small danger" onClick={deleteAccountAndData}>
                Delete Account &amp; Personal Data
              </button>
            </div>
          </section>
        </main>

        <aside className="side">
          <section className="card">
            <h2>Recent Notification Log</h2>
            {notifications.length === 0 ? (
              <p className="note">No alerts logged yet. Trigger a scenario on the Demo Pod to see deduplicated notifications here.</p>
            ) : (
              <ul className="events">
                {notifications.map((n) => (
                  <li key={n.id} className="alert">
                    <div className="when">
                      <span>{new Date(n.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      <span className="chip">{n.podId}</span>
                      <span className={`chip ${n.delivered ? "good" : ""}`}>
                        {n.delivered ? "Delivered" : "Suppressed (Quiet hours)"}
                      </span>
                    </div>
                    <div className="txt">
                      <b>{n.title}:</b> {n.body}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
