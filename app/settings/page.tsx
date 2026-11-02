"use client";
import { useCallback, useEffect, useState } from "react";
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
  const [pushStatus, setPushStatus] = useState<string>("Not enabled in this browser yet");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
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
    if (typeof window !== "undefined" && "Notification" in window) {
      setPushStatus(`Browser permission: ${Notification.permission}`);
    }
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

  async function requestBrowserNotifications() {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setPushStatus("Browser notifications not supported on this device.");
      return;
    }
    const perm = await Notification.requestPermission();
    setPushStatus(`Browser permission: ${perm}`);
    if (perm === "granted") {
      new Notification("EcoVital Alerts Enabled", {
        body: "Dust is high in Classroom (72%). Open the windows near the corridor.",
      });
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
              <button type="button" className="btn" onClick={requestBrowserNotifications}>
                🔔 Enable Browser Web Push Notifications
              </button>
              <span className="note">{pushStatus}</span>
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
