"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ago } from "./useVoice";
import AiPredictorPanel from "./AiPredictorPanel";
import { METRIC_KEYS, METRICS, ROOM_PROFILES, fmt, statusRank, statusWord, type MetricKey, type RoomProfileKey } from "@/lib/config";

const DEMO = process.env.NEXT_PUBLIC_DEMO !== "0";

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

export default function NetworkView() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  const autoSeededRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/nodes", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (j.nodes?.length === 0 && !autoSeededRef.current) {
        autoSeededRef.current = true;
        await fetch("/api/demo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scenario: "normal" }),
        });
        await fetch("/api/demo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scenario: "seed" }),
        });
        const res2 = await fetch("/api/nodes", { cache: "no-store" });
        const j2 = await res2.json();
        setData(j2);
        if (j2.nodes?.length) {
          const preferred = j2.nodes.find((n: any) => n.id === "demo-node") ?? j2.nodes[0];
          setSelectedId(preferred.id);
        }
        return;
      }
      setData(j);
      setError(null);
      if (!selectedId && j.nodes?.length) {
        const preferred = j.nodes.find((n: any) => n.id === "demo-node") ?? j.nodes[0];
        setSelectedId(preferred.id);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [selectedId]);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 8000);
    return () => clearInterval(t);
  }, [load]);

  async function seed() {
    setMsg("Creating simulated nodes...");
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: "seed" }),
      });
      const j = await res.json();
      setMsg(res.ok ? j.message : j.error);
      load();
    } catch (e: any) {
      setMsg(e.message);
    }
  }

  async function startDemoNode() {
    setMsg("Starting demo pod scenario...");
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: "normal" }),
      });
      const j = await res.json();
      setMsg(res.ok ? j.message : j.error);
      setSelectedId("demo-node");
      load();
    } catch (e: any) {
      setMsg(e.message);
    }
  }

  const nodes: any[] = data?.nodes ?? [];
  const live = nodes.filter((n) => !n.simulated);
  const online = live.filter((n) => n.online).length;
  const alerts = nodes.reduce((a, n) => a + n.alerts24, 0);
  const activePod = nodes.find((n) => n.id === selectedId) ?? nodes[0] ?? null;

  return (
    <div className="wrap">
      <header className="top">
        <span className="brand">Home &amp; Air Quality Network</span>
        <span className="crumb">Live pods, AI predictions, Room Score &amp; spoken guidance</span>
        <span className="spacer" />
        <Link className="btn primary" href="/add">＋ Add a pod</Link>
        <Link className="btn" href="/download">📲 Download App &amp; Firmware</Link>
        {DEMO && (
          <>
            <button className="btn" onClick={startDemoNode}>Start Demo Pod</button>
            <button className="btn" onClick={seed}>Add simulated cities</button>
          </>
        )}
      </header>

      {error && <div className="banner">Could not load nodes: {error}</div>}
      {msg && <div className="banner info" role="status">{msg}</div>}

      {/* Main Active Room Hero Card (Screen 1) */}
      {activePod && (
        <section className="room-hero" aria-label="Active room overview">
          <div
            className={`score-ring ${
              activePod.roomScore?.level === "poor"
                ? "poor"
                : activePod.roomScore?.level === "fair"
                  ? "fair"
                  : ""
            }`}
          >
            <span className="score-num">{activePod.roomScore?.score ?? "--"}</span>
            <span className="score-word">{activePod.roomScore?.word ?? "Room Score"}</span>
            <span style={{ fontSize: 10.5, color: "var(--ink2)" }}>0–100 index</span>
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
              {nodes.length > 1 && (
                <select
                  aria-label="Select active room or pod"
                  className="select"
                  style={{ width: "auto", fontWeight: 600 }}
                  value={activePod.id}
                  onChange={(e) => setSelectedId(e.target.value)}
                >
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name} {n.location ? `(${n.location})` : ""}
                    </option>
                  ))}
                </select>
              )}
              <span className="chip">
                <span className={`dot ${activePod.online || activePod.simulated ? "good pulse" : "bad"}`} />
                {activePod.simulated
                  ? "Simulated pod · online"
                  : activePod.online
                    ? `Online · ${ago(data.now, activePod.lastSeen)}`
                    : `Offline · last seen ${ago(data.now, activePod.lastSeen)}`}
              </span>
              {activePod.simulated && <span className="chip sim">Simulated</span>}
              {activePod.roomProfile && (
                <span className="chip">
                  Profile: {ROOM_PROFILES[activePod.roomProfile as RoomProfileKey]?.label ?? activePod.roomProfile}
                </span>
              )}
              {activePod.claimCode && (
                <span className="chip" title="Pod 6-character pair code">
                  Code: <b>{activePod.claimCode}</b>
                </span>
              )}
            </div>

            {!activePod.online && !activePod.simulated && (
              <p className="note" style={{ color: "var(--watch)", margin: "0 0 6px", fontWeight: 550 }}>
                This pod is offline from Wi-Fi, but still giving spoken advice in the room from its built-in voice clips.
              </p>
            )}

            <h2 style={{ fontSize: 24, margin: "2px 0 6px", fontWeight: 650 }}>
              {summaryWord(activePod.status, activePod.name)}
            </h2>

            {activePod.roomScore?.reasons && (
              <p style={{ margin: "0 0 12px", color: "var(--ink2)", fontSize: 13.5 }}>
                <b>Why this Room Score:</b> {activePod.roomScore.reasons.join(" · ")}
              </p>
            )}

            <div className="grid-4" style={{ marginBottom: 12 }}>
              {METRIC_KEYS.map((k) => {
                const st = activePod.status?.[k] ?? "ok";
                const rank = statusRank(st);
                const dotCls = rank === 0 ? "good" : rank === 1 ? "watch" : "bad";
                return (
                  <div key={k} className="sensor-tile">
                    <div className="st-top">
                      <span>{METRICS[k].label}</span>
                      <span className="tag-measured">Measured</span>
                    </div>
                    <div className="st-val">
                      {activePod.latest ? fmt(k, activePod.latest[k]) : "--"}
                      <small>{METRICS[k].unit}</small>
                    </div>
                    <div style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}>
                      <span className={`dot ${dotCls}`} />
                      <span>{statusWord(k, st)}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Link className="btn primary small" href={`/node/${encodeURIComponent(activePod.id)}`}>
                Open live charts, voice &amp; settings →
              </Link>
              <Link className="btn small" href={`/insights?pod=${encodeURIComponent(activePod.id)}`}>
                Daily insights &amp; What changed
              </Link>
              <Link className="btn small" href={`/ask?pod=${encodeURIComponent(activePod.id)}`}>
                Ask EcoVital about this room
              </Link>
              <a className="btn small" href={`/api/export/${encodeURIComponent(activePod.id)}?range=24h`} download>
                Export 24h CSV
              </a>
              <Link className="btn small" href="/download">
                📲 Download Companion App
              </Link>
            </div>
          </div>
        </section>
      )}

      {/* AI Predictive Engine Panel right on the Home screen */}
      {activePod && <AiPredictorPanel podId={activePod.id} />}

      <div className="hero">
        <h1>
          {nodes.length === 0
            ? "No pods connected yet"
            : live.length === 0
              ? `${nodes.length} simulated node${nodes.length === 1 ? "" : "s"}`
              : `${online} of ${live.length} pod${live.length === 1 ? "" : "s"} reporting`}
        </h1>
        <p>
          {nodes.length === 0
            ? "Pods send dust index (0–100%), air index (0–100%), temperature and humidity every few seconds."
            : `${data.readings24h.toLocaleString()} readings in the last 24 hours, ${alerts} spoken alert${alerts === 1 ? "" : "s"}. Open a node to see its charts, estimates and what it said.`}
        </p>
      </div>

      {data && nodes.length === 0 && (
        <div className="empty">
          <p style={{ marginTop: 0 }}>
            <b>Connect a physical EcoVital pod</b> with your 6-character pair code on the{" "}
            <Link href="/add">Add a pod wizard</Link>, or test immediately without hardware:
          </p>
          <p><code>node scripts/simulate.mjs https://your-site.vercel.app YOUR_DEVICE_KEY</code></p>
          {DEMO && (
            <p style={{ marginBottom: 0 }}>
              Or click <button className="btn small primary" onClick={startDemoNode}>Start Demo Pod</button> or open the{" "}
              <Link href="/node/demo-node">demo node</Link> and use the simulator buttons.
            </p>
          )}
        </div>
      )}

      {nodes.some((n) => n.lat !== null) && <NodeMap nodes={nodes} />}

      {nodes.length > 0 && (
        <table className="nodes">
          <thead>
            <tr>
              <th>Node</th>
              <th>Score</th>
              {METRIC_KEYS.map((k) => <th key={k} className="n hide-sm">{METRICS[k].label}</th>)}
              <th>Now</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => {
              const cls = worst(n.status);
              return (
                <tr key={n.id}>
                  <td>
                    <Link className="nm" href={`/node/${encodeURIComponent(n.id)}`}>{n.name}</Link>{" "}
                    {n.simulated && <span className="chip sim">Simulated</span>}
                    {n.claimedBy && <span className="chip good">Paired</span>}
                    <div className="sub">
                      {n.location ?? "No location set"} ·{" "}
                      {n.simulated
                        ? "synthetic data"
                        : n.online
                          ? `updated ${ago(data.now, n.lastSeen)}`
                          : `offline, last seen ${ago(data.now, n.lastSeen)}`}
                    </div>
                  </td>
                  <td>
                    {n.roomScore ? (
                      <span className={`chip ${n.roomScore.level === "good" ? "good" : n.roomScore.level === "poor" ? "bad" : ""}`}>
                        <b>{n.roomScore.score}</b> · {n.roomScore.word}
                      </span>
                    ) : (
                      "--"
                    )}
                  </td>
                  {METRIC_KEYS.map((k) => (
                    <td key={k} className="n hide-sm">
                      {n.latest ? fmt(k as MetricKey, n.latest[k]) : "--"}
                      <span className="sub"> {METRICS[k].unit}</span>
                    </td>
                  ))}
                  <td><span className={`dot ${cls}`} /> {summaryWord(n.status)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {!data && !error && <div className="skeleton">Loading network...</div>}
    </div>
  );
}

// A plain longitude/latitude plot, zoomed to fit the nodes. Dots are coloured by the worst current reading.
function NodeMap({ nodes }: { nodes: any[] }) {
  const placed = nodes.filter((n) => n.lat !== null && n.lng !== null);
  const W = 1000, H = 280, PAD = 90;
  const lngs = placed.map((n) => n.lng as number), lats = placed.map((n) => n.lat as number);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs), minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const spanX = Math.max(30, maxLng - minLng), spanY = Math.max(15, maxLat - minLat);
  const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY); // pixels per degree, same both ways
  const cx = (minLng + maxLng) / 2, cy = (minLat + maxLat) / 2;
  const x = (lng: number) => W / 2 + (lng - cx) * scale;
  const y = (lat: number) => H / 2 - (lat - cy) * scale;
  // graticule every 10 degrees inside the view
  const gl: number[] = [], gt: number[] = [];
  for (let g = Math.ceil((cx - W / 2 / scale) / 10) * 10; g <= cx + W / 2 / scale; g += 10) gl.push(g);
  for (let g = Math.ceil((cy - H / 2 / scale) / 10) * 10; g <= cy + H / 2 / scale; g += 10) gt.push(g);
  return (
    <svg className="map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Where the pods are, by longitude and latitude">
      {gl.map((g) => <line key={`x${g}`} x1={x(g)} x2={x(g)} y1={0} y2={H} stroke="var(--grid)" />)}
      {gt.map((g) => <line key={`y${g}`} x1={0} x2={W} y1={y(g)} y2={y(g)} stroke={g === 0 ? "var(--rule)" : "var(--grid)"} />)}
      {placed.map((n) => {
        const cls = worst(n.status);
        const col = cls === "good" ? "var(--good)" : cls === "watch" ? "var(--watch)" : "var(--bad)";
        const px = x(n.lng), py = y(n.lat);
        const crowdedRight = placed.some((o) => o !== n && x(o.lng) > px && x(o.lng) - px < 130 && Math.abs(y(o.lat) - py) < 26);
        return (
          <Link key={n.id} href={`/node/${encodeURIComponent(n.id)}`}>
            <circle cx={px} cy={py} r={7} fill={col} fillOpacity={n.simulated ? 0.3 : 1} stroke={col} strokeWidth={2} />
            <text x={crowdedRight ? px - 13 : px + 13} y={py + 5} fontSize={14} textAnchor={crowdedRight ? "end" : "start"} fill="var(--ink)">{n.name}</text>
          </Link>
        );
      })}
      <text x={8} y={H - 8} fontSize={12} fill="var(--ink2)">Grid lines every 10 degrees. Faded dots are simulated nodes.</text>
    </svg>
  );
}
