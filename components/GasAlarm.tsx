"use client";
import { useEffect, useRef, useState } from "react";

type Alarm = { id: number; podId: string; name: string; message: string; t: number };

// Shows a red banner and sounds a siren when a pod raises a gas/fumes alarm. Works while the app or page is open.
export default function GasAlarm() {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [silenced, setSilenced] = useState<Set<number>>(new Set());
  const [blocked, setBlocked] = useState(false);
  const ctx = useRef<AudioContext | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const notified = useRef<Set<number>>(new Set());

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const r = await fetch("/api/alarms", { cache: "no-store" });
        const j = await r.json();
        if (!stop) setAlarms(j.alarms ?? []);
      } catch { /* offline: try again */ }
    }
    poll();
    const t = setInterval(poll, 4000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  const active = alarms.filter((a) => !silenced.has(a.id));

  useEffect(() => {
    for (const a of active) {
      if (notified.current.has(a.id)) continue;
      notified.current.add(a.id);
      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(`ALARM: ${a.name}`, { body: a.message, tag: `ev-alarm-${a.id}` });
        }
      } catch { /* not supported here */ }
    }
  }, [active]);

  useEffect(() => {
    function stopSiren() { if (timer.current) { clearInterval(timer.current); timer.current = null; } }
    if (!active.length) { stopSiren(); return; }
    if (timer.current) return;
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      ctx.current = ctx.current ?? new AC();
      const beep = (f: number, at: number) => {
        const c = ctx.current!;
        const o = c.createOscillator(); const g = c.createGain();
        o.type = "square"; o.frequency.value = f; g.gain.value = 0.25;
        o.connect(g); g.connect(c.destination);
        o.start(c.currentTime + at); o.stop(c.currentTime + at + 0.22);
      };
      const cycle = () => {
        if (ctx.current!.state === "suspended") ctx.current!.resume().catch(() => {});
        setBlocked(ctx.current!.state !== "running");
        beep(960, 0); beep(1400, 0.25);
      };
      cycle();
      timer.current = setInterval(cycle, 500);
    } catch { setBlocked(true); }
    return stopSiren;
  }, [active.length]);

  if (!active.length) return null;
  const a = active[0];
  return (
    <div
      role="alert"
      onClick={() => { ctx.current?.resume().catch(() => {}); setBlocked(false); }}
      style={{ position: "sticky", top: 0, zIndex: 1000, background: "#b3261e", color: "#fff", padding: "12px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
    >
      <strong style={{ fontSize: 17 }}>ALARM: possible gas or fumes at {a.name}</strong>
      <span style={{ flex: 1, minWidth: 200 }}>
        {a.message} The pod detected a sudden drop in its air index. This is an air-quality sensor, not a certified gas detector.
        {blocked ? " Tap here to turn the siren sound on." : ""}
      </span>
      <a href={`/node/${encodeURIComponent(a.podId)}`} style={{ color: "#fff", textDecoration: "underline" }}>Open pod</a>
      <button
        onClick={(e) => { e.stopPropagation(); setSilenced((s) => new Set(s).add(a.id)); }}
        style={{ background: "#fff", color: "#b3261e", border: 0, borderRadius: 6, padding: "6px 12px", fontWeight: 600, cursor: "pointer" }}
      >
        Silence
      </button>
    </div>
  );
}
