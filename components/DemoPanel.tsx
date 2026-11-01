"use client";
import { useState } from "react";

const SCENARIOS: { id: string; label: string; hint: string }[] = [
  { id: "normal", label: "Hold steady", hint: "Keep current values" },
  { id: "warning", label: "Humidity sliding", hint: "Early warning, before the limit" },
  { id: "dry", label: "Dry air", hint: "Humidity drops below 30%" },
  { id: "dusty", label: "Dusty room", hint: "Dust index jumps" },
  { id: "stuffy", label: "Stuffy and humid", hint: "Air index falls, humidity rises" },
  { id: "recover", label: "Recover", hint: "Everything back to normal" },
];

export default function DemoPanel({
  onDone,
}: {
  onDone: (speak: { eventId: number; text: string } | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  async function run(id: string) {
    setBusy(id);
    setMsg("");
    try {
      const res = await fetch("/api/demo", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: id }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Request failed");
      setMsg(j.message + (j.speak ? "" : id === "recover" ? " (no active alert to clear)" : ""));
      onDone(j.speak ?? null);
    } catch (e: any) {
      setMsg(`Could not run: ${e.message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="demo">
      <h2>Simulated node controls</h2>
      <p>Sends fake readings for the &ldquo;Demo node&rdquo; through the same pipeline a real pod uses. Everything here is labelled simulated.</p>
      <div className="row">
        {SCENARIOS.map((s) => (
          <button key={s.id} className="btn small" title={s.hint} disabled={!!busy} onClick={() => run(s.id)}>
            {busy === s.id ? "Working..." : s.label}
          </button>
        ))}
        <button className="btn small" disabled={!!busy} onClick={() => run("reset")}>Clear demo node</button>
      </div>
      {msg && <p style={{ margin: "10px 0 0" }} role="status">{msg}</p>}
    </div>
  );
}
