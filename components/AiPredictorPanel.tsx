"use client";
import { useCallback, useEffect, useState } from "react";
import { METRIC_KEYS, type MetricKey } from "@/lib/config";

interface Props {
  podId: string;
  onSpeak?: (eventId: number, text: string) => void;
}

export default function AiPredictorPanel({ podId, onSpeak }: Props) {
  const [pred, setPred] = useState<any>(null);
  const [selectedWhatIf, setSelectedWhatIf] = useState<string>("open_window");
  const [speaking, setSpeaking] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!podId) return;
    try {
      const res = await fetch(`/api/predict/${encodeURIComponent(podId)}`, { cache: "no-store" });
      if (res.ok) {
        const j = await res.json();
        setPred(j);
      }
    } finally {
      setLoading(false);
    }
  }, [podId]);

  useEffect(() => {
    setLoading(true);
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 10000);
    return () => clearInterval(t);
  }, [load]);

  async function speakPredictionOutLoud() {
    if (!podId || speaking) return;
    setSpeaking(true);
    try {
      const res = await fetch(`/api/predict/${encodeURIComponent(podId)}`, { method: "POST" });
      const j = await res.json();
      setPred(j);
      if (onSpeak && j.eventId && j.spokenForecast) {
        onSpeak(j.eventId, j.spokenForecast);
      } else if (typeof window !== "undefined" && "speechSynthesis" in window && j.spokenForecast) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(j.spokenForecast);
        window.speechSynthesis.speak(u);
      }
    } finally {
      setSpeaking(false);
    }
  }

  if (loading && !pred) {
    return (
      <section className="card" aria-label="AI Predictive Engine">
        <h2>🔮 AI Predictive Engine (+10m / +30m / +60m)</h2>
        <p className="note">Calculating multi-horizon sensor trends and What-If scenarios...</p>
      </section>
    );
  }

  if (!pred) return null;

  const activeWhatIf =
    (pred.whatIfs || []).find((w: any) => w.id === selectedWhatIf) || (pred.whatIfs || [])[0];

  const riskBadgeClass =
    pred.riskLevel === "high" ? "bad" : pred.riskLevel === "medium" ? "" : "good";

  return (
    <section
      className="card"
      aria-label="AI Predictive Engine and What-If Simulator"
      style={{
        borderLeft: `5px solid ${
          pred.riskLevel === "high"
            ? "var(--bad)"
            : pred.riskLevel === "medium"
              ? "var(--watch)"
              : "var(--fc)"
        }`,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
          marginBottom: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>
            🔮 AI Predictive Engine — What Will Happen Next in {pred.podName}
          </h2>
          <span className="tag-estimated">
            Estimated · {pred.aiSource === "gemini" ? "Gemini Predictive AI" : "Linear Trend + Diurnal Rhythm"}
          </span>
          <span className={`chip ${riskBadgeClass}`}>
            {pred.riskLevel === "high"
              ? "⚠️ High Early-Warning Risk"
              : pred.riskLevel === "medium"
                ? "⚡ Watch Trend"
                : "✓ Steady Trajectory"}
          </span>
        </div>

        <button
          type="button"
          className="btn primary small"
          disabled={speaking}
          onClick={speakPredictionOutLoud}
        >
          {speaking ? "Speaking..." : "🔊 Speak AI Prediction Out Loud"}
        </button>
      </div>

      {/* Main AI Narrative & Recommended Preventive Action */}
      <div
        style={{
          background: "var(--panel-alt)",
          border: "1px solid var(--rule)",
          borderRadius: 10,
          padding: "12px 14px",
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 15.5, fontWeight: 550, lineHeight: 1.45, marginBottom: 6 }}>
          {pred.aiNarrative || pred.headline}
        </div>
        <div style={{ fontSize: 13.5, color: "var(--brand-deep)", fontWeight: 600 }}>
          💡 Preventive Action Before Threshold Crosses: {pred.preventiveAction}
        </div>
      </div>

      {/* Multi-Horizon Trajectory (+10m, +30m, +60m) */}
      <div className="grid-2" style={{ alignItems: "start" }}>
        <div>
          <h3 style={{ fontSize: 14, marginBottom: 6 }}>
            Multi-Horizon Sensor &amp; Room Score Forecast
          </h3>
          <table className="kv">
            <thead>
              <tr>
                <th>Metric</th>
                <td>Now (Measured)</td>
                <td>+10 min</td>
                <td>+30 min</td>
                <td>+60 min</td>
                <td>Trend</td>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>Room Score</th>
                <td>
                  <b>{pred.horizons?.[0]?.roomScore ?? "--"}/100</b>
                </td>
                <td>
                  <b>{pred.horizons?.[0]?.roomScore ?? "--"}</b> ({pred.horizons?.[0]?.scoreWord})
                </td>
                <td>
                  <b>{pred.horizons?.[1]?.roomScore ?? "--"}</b> ({pred.horizons?.[1]?.scoreWord})
                </td>
                <td>
                  <b>{pred.horizons?.[2]?.roomScore ?? "--"}</b> ({pred.horizons?.[2]?.scoreWord})
                </td>
                <td>
                  <span className="tag-estimated">Estimated</span>
                </td>
              </tr>
              {METRIC_KEYS.map((k: MetricKey) => {
                const m = pred.metrics?.[k];
                if (!m) return null;
                return (
                  <tr key={k}>
                    <th>{m.label}</th>
                    <td>
                      {m.current}
                      {m.unit}
                    </td>
                    <td>
                      <b>
                        {m.pred10m}
                        {m.unit}
                      </b>
                    </td>
                    <td>
                      {m.pred30m}
                      {m.unit}
                    </td>
                    <td>
                      {m.pred60m}
                      {m.unit}
                    </td>
                    <td>
                      {m.crossing ? (
                        <span className="chip bad">
                          Crosses {m.crossing.threshold}
                          {m.unit} in ~{m.crossing.inMinutes}m
                        </span>
                      ) : (
                        <span className="note">
                          {m.trend} ({m.slopePerMin >= 0 ? "+" : ""}
                          {m.slopePerMin}/m)
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Interactive "What-If" Intervention Simulator */}
        <div>
          <h3 style={{ fontSize: 14, marginBottom: 6 }}>
            Interactive &ldquo;What-If&rdquo; Action Predictor (Simulate Intervention)
          </h3>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {(pred.whatIfs || []).map((w: any) => (
              <button
                key={w.id}
                type="button"
                className="btn small"
                aria-pressed={selectedWhatIf === w.id}
                onClick={() => setSelectedWhatIf(w.id)}
              >
                {w.label}
              </button>
            ))}
          </div>

          {activeWhatIf && (
            <div className="sensor-tile">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <b>{activeWhatIf.label}</b>
                <span className="tag-estimated">Simulated outcome</span>
              </div>
              <p className="note" style={{ margin: "4px 0 8px" }}>
                {activeWhatIf.description}
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
                  gap: 6,
                  textAlign: "center",
                  background: "var(--panel)",
                  padding: 8,
                  borderRadius: 8,
                  border: "1px solid var(--rule)",
                }}
              >
                <div>
                  <div className="note">Score (30m)</div>
                  <b style={{ fontSize: 17, color: "var(--brand-leaf)" }}>{activeWhatIf.in30m.roomScore}/100</b>
                </div>
                <div>
                  <div className="note">Dust</div>
                  <b>{activeWhatIf.in30m.dust}%</b>
                </div>
                <div>
                  <div className="note">Air</div>
                  <b>{activeWhatIf.in30m.air}%</b>
                </div>
                <div>
                  <div className="note">Temp</div>
                  <b>{activeWhatIf.in30m.temp}°C</b>
                </div>
                <div>
                  <div className="note">Hum</div>
                  <b>{activeWhatIf.in30m.hum}%</b>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
