"use client";
import { useState } from "react";

export default function SosButton({ podId, podName }: { podId: string; podName?: string }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!confirm(`Sound the SOS alarm on ${podName || "this pod"} now?`)) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/api/pods/${encodeURIComponent(podId)}/sos`, { method: "POST" });
      const j = await res.json();
      setMsg(j.message || j.error || "Could not send the alarm.");
    } catch {
      setMsg("Could not reach EcoVital. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <button type="button" className="btn small danger" onClick={send} disabled={busy} title="Sound a loud alarm on the pod">
        🚨 SOS alarm
      </button>
      {msg && <span className="note" role="status">{msg}</span>}
    </span>
  );
}
