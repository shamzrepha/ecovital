"use client";
import { useEffect, useState } from "react";

function b64(s: string) {
  const p = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Turns on phone alerts: the browser/phone shows an alarm-style notification even when the app is closed.
export default function PushToggle() {
  const [state, setState] = useState<"checking" | "unsupported" | "off" | "on" | "denied">("checking");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return setState("unsupported");
      if (Notification.permission === "denied") return setState("denied");
      try {
        const reg = await navigator.serviceWorker.ready;
        setState((await reg.pushManager.getSubscription()) ? "on" : "off");
      } catch { setState("off"); }
    })();
  }, []);

  async function enable() {
    setMsg("");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setState(perm === "denied" ? "denied" : "off"); return; }
      const reg = await navigator.serviceWorker.ready;
      const { key } = await (await fetch("/api/push/key")).json();
      if (!key) throw new Error("Server has no push key");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
      const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
      if (!r.ok) throw new Error("Could not save this phone");
      setState("on");
      setMsg("Phone alerts are on.");
    } catch (e: any) { setMsg(String(e?.message ?? e)); }
  }

  async function disable() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await fetch("/api/push/subscribe", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
      setState("off"); setMsg("Phone alerts are off.");
    } catch (e: any) { setMsg(String(e?.message ?? e)); }
  }

  async function test() {
    setMsg("Sending a test alarm...");
    try { const j = await (await fetch("/api/push/test", { method: "POST" })).json(); setMsg(j.sent ? "Test sent. It should ring in a few seconds." : "No phone received it. Turn alerts off and on again."); }
    catch { setMsg("Could not reach the server."); }
  }

  return (
    <section className="card">
      <h2>Phone alerts</h2>
      <div className="note" style={{ marginBottom: 8 }}>
        Get an alarm-style notification on this phone when a pod reports bad air or possible gas, even when the app is closed.
        Gas alarms always come through, also during quiet hours. On iPhone, first use Share, then Add to Home Screen, and open EcoVital from there.
      </div>
      {state === "unsupported" && <div className="note">This browser cannot receive background alerts. Use Chrome on Android, or install the app to your iPhone home screen.</div>}
      {state === "denied" && <div className="note" role="alert">Notifications are blocked. Allow them for this site in your browser settings, then reload.</div>}
      {(state === "off" || state === "on") && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {state === "off" ? <button className="btn primary" onClick={enable}>Turn on phone alerts</button> : <>
            <button className="btn" onClick={test}>Send test alarm</button>
            <button className="btn" onClick={disable}>Turn off</button>
          </>}
        </div>
      )}
      {msg && <div className="note" role="status" style={{ marginTop: 8 }}>{msg}</div>}
    </section>
  );
}
