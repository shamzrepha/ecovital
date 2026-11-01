"use client";
import { useCallback, useEffect, useState } from "react";
import { METRIC_KEYS, statusRank, type MetricKey } from "@/lib/config";

interface Props {
  podId: string;
  onSpeak?: (eventId: number, text: string) => void;
}

const tone = (status: string) => (statusRank(status as any) === 0 ? "good" : statusRank(status as any) === 1 ? "watch" : "bad");
const arrow = (perHour: number, step: number) => (Math.abs(perHour) < step * 0.6 ? "→" : perHour > 0 ? "↗" : "↘");
const STEP: Record<MetricKey, number> = { dust: 3, air: 3, temp: 0.5, hum: 2 };

export default function AiPredictorPanel({ podId, onSpeak }: Props) {
  const [r, setR] = useState<any>(null);
  const [failed, setFailed] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [locMsg, setLocMsg] = useState("");

  const load = useCallback(async () => {
    if (!podId) return;
    try {
      const res = await fetch(`/api/predict/${encodeURIComponent(podId)}`, { cache: "no-store" });
      if (!res.ok) { setFailed(true); return; }
      setR(await res.json());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [podId]);

  useEffect(() => {
    setR(null);
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 20000);
    return () => clearInterval(t);
  }, [load]);

  async function speakOutLoud() {
    if (speaking) return;
    setSpeaking(true);
    try {
      const res = await fetch(`/api/predict/${encodeURIComponent(podId)}`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) return;
      setR(j);
      if (onSpeak && j.eventId && j.spokenForecast) onSpeak(j.eventId, j.spokenForecast);
      else if ("speechSynthesis" in window && j.spokenForecast) {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(j.spokenForecast));
      }
    } finally {
      setSpeaking(false);
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) { setLocMsg("This browser cannot share a location. Try your phone."); return; }
    setLocMsg("Asking for your location…");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const res = await fetch(`/api/pods/${encodeURIComponent(podId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lat: +pos.coords.latitude.toFixed(3), lng: +pos.coords.longitude.toFixed(3) }),
        });
        setLocMsg(res.ok ? "Location saved. Loading the outside weather…" : "Could not save the location.");
        if (res.ok) load();
      },
      () => setLocMsg("Location was not shared. Allow location access and try again."),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  }

  if (failed && !r) return null;
  if (!r) return <section className="card fc" aria-label="Forecast"><div className="skeleton">Working out what happens next…</div></section>;

  const risk = r.riskLevel as "low" | "medium" | "high";
  return (
    <section className={`card fc fc-${risk}`} aria-label="Forecast for the next hour">
      <div className="fc-head">
        <h2>What is likely to happen next</h2>
        <span className="tag-estimated" title="Forecasts are estimates, not measurements">Estimate</span>
      </div>

      <p className="fc-headline">{r.headline}</p>
      <p className="fc-story">{r.aiNarrative}</p>
      <p className="note fc-how">{r.learning.note}</p>

      {!r.stale && (
        <div className="fc-grid">
          {METRIC_KEYS.map((k) => {
            const m = r.metrics[k];
            const p30 = m.predictions.find((p: any) => p.horizon === 30);
            const p60 = m.predictions.find((p: any) => p.horizon === 60);
            return (
              <div key={k} className="fc-metric">
                <div className="fc-m-top">
                  <b>{m.label}</b>
                  <span className="note">{arrow(m.perHour, STEP[k])} {m.trendWord}</span>
                </div>
                <div className="fc-now">Now <b>{m.current ?? "--"}</b><small>{m.unit}</small> <span className="tag-measured">Measured</span></div>
                {[["In 30 minutes", p30], ["In 1 hour", p60]].map(([label, p]: any) => (
                  <div key={label} className="fc-row">
                    <span>{label}</span>
                    {p ? (
                      <span className={`fc-val ${tone(p.status)}`}>
                        <span className={`dot ${tone(p.status)}`} /> <b>{p.value}</b><small>{m.unit}</small>
                        <span className="fc-range">({p.low}–{p.high})</span> <em>{p.statusWord}</em>
                      </span>
                    ) : <span className="note">not enough data</span>}
                  </div>
                ))}
                {m.reaches && <div className={`fc-reach ${m.reaches.level}`}>May become {m.reaches.word.toLowerCase()} in about {m.reaches.minutes} min</div>}
              </div>
            );
          })}
        </div>
      )}

      {r.roomScore?.now != null && r.roomScore.in60 != null && (
        <p className="note">Room score: <b>{r.roomScore.now}</b> now{r.roomScore.in30 != null && <> → <b>{r.roomScore.in30}</b> in 30 minutes</>} → <b>{r.roomScore.in60}</b> in 1 hour (estimate).</p>
      )}

      {r.flags.length > 0 && (
        <div className="fc-flags">
          {r.flags.map((f: any) => (
            <div key={f.id} className={`fc-flag ${f.level}`}>
              <b>{f.level === "flag" ? "⚠ Red flag: " : f.level === "watch" ? "Keep an eye on this: " : ""}{f.title}</b>
              <p>{f.text}</p>
              <ul>{f.evidence.map((e: string) => <li key={e}>{e}</li>)}</ul>
            </div>
          ))}
        </div>
      )}

      <div className="fc-outside">
        {r.outside ? (
          <>
            <b>Outside right now</b> <span className="tag-estimated">Outside data</span>
            <p>
              {r.outside.temp}°C, {r.outside.hum}% humidity, {r.outside.sky}. In 3 hours: about {r.outside.in3h.temp}°C, rain chance {r.outside.in3h.rainChance}%.
              <span className="note"> Weather from {r.outside.source}.</span>
            </p>
          </>
        ) : (
          <>
            <b>Add the pod's location for weather-aware forecasts</b>
            <p className="note" style={{ margin: "4px 0 8px" }}>
              With a location, EcoVital can see rain and outside temperature coming and tell you when the room is behaving oddly for the weather.
            </p>
          </>
        )}
        <button type="button" className="btn small" onClick={useMyLocation}>
          📍 {r.outside ? "Update location" : "Use my location"}
        </button>
        {locMsg && <span className="note" role="status" style={{ marginLeft: 8 }}>{locMsg}</span>}
      </div>

      <div className="fc-actions">
        <button type="button" className="btn small primary" onClick={speakOutLoud} disabled={speaking || r.stale}>
          {speaking ? "Preparing…" : "🔊 Say this out loud"}
        </button>
        <span className="note">{r.aiSource === "gemini" ? "Explained by Gemini from the numbers above." : "Explained from the numbers above."}</span>
      </div>
    </section>
  );
}
