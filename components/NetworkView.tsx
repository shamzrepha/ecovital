"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ago } from "./useVoice";
import AiPredictorPanel from "./AiPredictorPanel";
import SosButton from "./SosButton";
import { METRIC_KEYS, METRICS, ROOM_PROFILES, fmt, statusRank, statusWord, type MetricKey, type RoomProfileKey } from "@/lib/config";

function worst(status: Record<string, string>): "good" | "watch" | "bad" {
  let r = 0;
  for (const k of METRIC_KEYS) r = Math.max(r, statusRank(status[k]));
  return r === 0 ? "good" : r === 1 ? "watch" : "bad";
}

function summaryWord(status: Record<string, string>, name?: string): string {
  const bad = METRIC_KEYS.filter((k) => statusRank(status[k]) > 0)
    .sort((a, b) => statusRank(status[b]) - statusRank(status[a]))[0];
  if (!bad) return name ? `Air is comfortable in ${name}.` : "All readings fine";
  const w = statusWord(bad, status[bad]).toLowerCase();
  return name ? `${METRICS[bad].label} is ${w} in ${name}.` : `${METRICS[bad].label}: ${w}`;
}

function PodStatus({ pod, now }: { pod: any; now: number }) {
  if (pod.lastSeen === null) return <span className="chip"><span className="dot watch" /> Waiting for first reading</span>;
  return (
    <span className="chip">
      <span className={`dot ${pod.online ? "good pulse" : "watch"}`} />
      {pod.online ? `Online · ${ago(now, pod.lastSeen)}` : `Offline · last reading ${ago(now, pod.lastSeen)}`}
    </span>
  );
}

export default function NetworkView() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/nodes", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setData(j);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 3000);
    return () => clearInterval(t);
  }, [load]);

  const nodes: any[] = data?.nodes ?? [];
  const active = nodes.find((n) => n.id === selectedId) ?? nodes[0] ?? null;
  const onlineCount = nodes.filter((n) => n.online).length;
  const alerts = nodes.reduce((a, n) => a + n.alerts24, 0);

  return (
    <div className="wrap">
      <header className="top">
        <span className="brand">Your rooms</span>
        {data && nodes.length > 0 && (
          <span className="crumb">
            {onlineCount} of {nodes.length} pod{nodes.length === 1 ? "" : "s"} online · {alerts} spoken alert{alerts === 1 ? "" : "s"} in 24 h
          </span>
        )}
        <span className="spacer" />
        <Link className="btn primary" href="/add">＋ Add a pod</Link>
      </header>

      {error && <div className="banner">Could not load your pods: {error}</div>}
      {!data && !error && <div className="skeleton">Loading your rooms…</div>}

      {data && nodes.length === 0 && (
        <div className="empty">
          <h2 style={{ marginTop: 0 }}>No pods yet</h2>
          <p>Plug in a pod and add it with the 6-character code on its screen. It takes about two minutes.</p>
          <Link className="btn primary" href="/add">Add your first pod</Link>
        </div>
      )}

      {nodes.length > 1 && (
        <div className="pod-cards">
          {nodes.map((n) => {
            const cls = worst(n.status);
            return (
              <button key={n.id} type="button" className={`pod-card ${active?.id === n.id ? "sel" : ""}`} onClick={() => setSelectedId(n.id)} aria-pressed={active?.id === n.id}>
                <span className="nm">{n.name}</span>
                <span style={{ fontSize: 13, color: "var(--ink2)" }}>{n.location ?? "No place set"}</span>
                <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span className={`dot ${cls}`} />
                  <span style={{ fontSize: 13 }}>{n.latest ? summaryWord(n.status) : "No reading yet"}</span>
                  {n.roomScore && <span className="chip"><b>{n.roomScore.score}</b> · {n.roomScore.word}</span>}
                </span>
                <PodStatus pod={n} now={data.now} />
              </button>
            );
          })}
        </div>
      )}

      {active && (
        <section className="room-hero" aria-label="Selected room overview">
          <div className={`score-ring ${active.roomScore?.level === "poor" ? "poor" : active.roomScore?.level === "fair" ? "fair" : ""}`}>
            <span className="score-num">{active.roomScore?.score ?? "--"}</span>
            <span className="score-word">{active.roomScore?.word ?? "Room score"}</span>
            <span style={{ fontSize: 10.5, color: "var(--ink2)" }}>0–100 index</span>
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
              <PodStatus pod={active} now={data.now} />
              <span className="chip">Profile: {ROOM_PROFILES[active.profile as RoomProfileKey]?.label ?? active.profile}</span>
              {active.fw && <span className="chip">Firmware v{active.fw}</span>}
            </div>

            {!active.online && active.lastSeen !== null && (
              <p className="note" style={{ color: "var(--watch)", margin: "0 0 6px", fontWeight: 550 }}>
                {active.podState?.label}. {active.podState?.offlineVoiceNote}
              </p>
            )}

            <h2 style={{ fontSize: 24, margin: "2px 0 6px", fontWeight: 650 }}>
              {active.latest ? summaryWord(active.status, active.name) : `Waiting for ${active.name} to send its first reading.`}
            </h2>

            {active.roomScore?.reasons && (
              <p style={{ margin: "0 0 12px", color: "var(--ink2)", fontSize: 13.5 }}>
                <b>Why this score:</b> {active.roomScore.reasons.join(" · ")}
              </p>
            )}

            <div className="grid-4" style={{ marginBottom: 12 }}>
              {METRIC_KEYS.map((k: MetricKey) => {
                const st = active.status?.[k] ?? "ok";
                const rank = statusRank(st);
                return (
                  <div key={k} className="sensor-tile">
                    <div className="st-top">
                      <span>{METRICS[k].label}</span>
                      <span className="tag-measured">Measured</span>
                    </div>
                    <div className="st-val">
                      {active.latest ? fmt(k, active.latest[k]) : "--"}
                      <small>{METRICS[k].unit}</small>
                    </div>
                    <div style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}>
                      <span className={`dot ${rank === 0 ? "good" : rank === 1 ? "watch" : "bad"}`} />
                      <span>{statusWord(k, st)}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {active.lastSpoken && (
              <p className="note" style={{ margin: "0 0 12px" }}>
                <b>Last thing the pod said</b> ({ago(data.now, active.lastSpoken.t)}):{" "}
                <q>{active.lastSpoken.translatedText || active.lastSpoken.spoken}</q>
              </p>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Link className="btn primary small" href={`/node/${encodeURIComponent(active.id)}`}>Live charts, voice and settings →</Link>
              <Link className="btn small" href={`/insights?pod=${encodeURIComponent(active.id)}`}>Insights</Link>
              <Link className="btn small" href={`/ask?pod=${encodeURIComponent(active.id)}`}>Ask EcoVital</Link>
              <a className="btn small" href={`/api/export/${encodeURIComponent(active.id)}?range=24h`} download>Export 24 h CSV</a>
              <SosButton podId={active.id} podName={active.name} />
            </div>
          </div>
        </section>
      )}

      {active && <AiPredictorPanel podId={active.id} />}
    </div>
  );
}
