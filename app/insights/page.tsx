"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { METRICS, METRIC_KEYS, type MetricKey } from "@/lib/config";

const CAP: Record<MetricKey, string> = { dust: "Dust", air: "Air", temp: "Temp", hum: "Hum" };

function InsightsInner() {
  const searchParams = useSearchParams();
  const initialPod = searchParams.get("pod") || "demo-node";

  const [nodes, setNodes] = useState<any[]>([]);
  const [podId, setPodId] = useState(initialPod);
  const [data, setData] = useState<any>(null);
  const [metric, setMetric] = useState<MetricKey>("dust");
  const [overlayB, setOverlayB] = useState<MetricKey>("hum");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const [nRes, iRes] = await Promise.all([
        fetch("/api/nodes", { cache: "no-store" }),
        fetch(`/api/insights/${encodeURIComponent(id)}`, { cache: "no-store" }),
      ]);
      const nJson = await nRes.json();
      const iJson = await iRes.json();
      if (nJson.nodes) setNodes(nJson.nodes);
      setData(iJson);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(podId);
  }, [podId, load]);

  const hourly = data?.comparison ?? [];
  const patternHours = data?.patterns?.hours ?? [];
  const patternNotes: string[] = data?.patterns?.notes ?? [];
  const todayKey = `today${CAP[metric]}`;
  const yestKey = `yesterday${CAP[metric]}`;
  const overlayKey = `today${CAP[overlayB]}`;

  return (
    <div className="wrap">
      <header className="top">
        <span className="brand">Insights, Patterns &amp; &ldquo;What Changed?&rdquo;</span>
        <span className="crumb">Daily/weekly AI digests, today vs yesterday, and hour-of-day rhythms</span>
        <span className="spacer" />
        {nodes.length > 0 && (
          <select
            aria-label="Select pod for insights"
            className="select"
            style={{ width: "auto", fontWeight: 600 }}
            value={podId}
            onChange={(e) => setPodId(e.target.value)}
          >
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} ({n.id})
              </option>
            ))}
          </select>
        )}
        <a className="btn small" href={`/api/export/${encodeURIComponent(podId)}?range=7d`} download>
          ⬇ Download 7d CSV
        </a>
      </header>

      {loading && !data ? (
        <div className="skeleton">Calculating insights and patterns...</div>
      ) : (
        <>
          {/* Daily & Pattern Summary Cards */}
          <div className="grid-2" style={{ marginBottom: 18 }}>
            <section className="card" style={{ marginBottom: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <h2 style={{ margin: 0 }}>Daily Insight (Last 24 Hours vs Yesterday)</h2>
                <span className="tag-estimated">Estimated · {data?.daily?.source === "gemini" ? "Gemini" : "Template"}</span>
              </div>
              <p style={{ margin: "6px 0 10px", fontSize: 15, lineHeight: 1.5 }}>
                {data?.daily?.text || "Collecting readings to summarize the last 24 hours."}
              </p>
              <div className="note">
                Best hour: <b>{data?.daily?.stats?.bestHour ?? "--"}</b> · Busiest/worst hour:{" "}
                <b>{data?.daily?.stats?.worstHour ?? "--"}</b> · {data?.daily?.stats?.comparedToPrev}
              </div>
            </section>

            <section className="card" style={{ marginBottom: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <h2 style={{ margin: 0 }}>7-Day Recurring Rhythms &amp; Digest</h2>
                <span className="tag-estimated">Estimated pattern from Measured history</span>
              </div>
              <ul style={{ margin: "6px 0 10px", paddingLeft: 18, fontSize: 14.5, lineHeight: 1.5 }}>
                {patternNotes.map((n, idx) => (
                  <li key={idx}>{n}</li>
                ))}
              </ul>
              <div className="note">
                All sensor values used in this digest are <b>Measured</b>; narrative synthesis is <b>Estimated</b>.
              </div>
            </section>
          </div>

          {/* Metric Selector */}
          <div className="tabs" style={{ marginBottom: 14 }}>
            <span className="note" style={{ alignSelf: "center", marginRight: 6 }}>Primary metric:</span>
            {METRIC_KEYS.map((k) => (
              <button
                key={k}
                className="btn small"
                aria-pressed={metric === k}
                onClick={() => setMetric(k)}
              >
                {METRICS[k].label} ({METRICS[k].unit})
              </button>
            ))}
          </div>

          {/* Today vs Yesterday Comparison & Multi-Metric Correlation Overlay */}
          <div className="grid-2">
            <section className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h2 style={{ margin: 0 }}>What Changed? Today vs Yesterday ({METRICS[metric].label})</h2>
                <span className="tag-measured">Measured hourly avg</span>
              </div>
              <p className="note" style={{ marginTop: 0 }}>
                Compares each hour of the last 24 hours against the prior 24-hour window so you can spot whether a change came from morning sweeping, afternoon heat, or closed windows.
              </p>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={hourly}>
                    <CartesianGrid stroke="var(--grid)" />
                    <XAxis dataKey="hour" fontSize={12} stroke="var(--ink2)" />
                    <YAxis fontSize={12} stroke="var(--ink2)" width={36} />
                    <Tooltip
                      contentStyle={{ background: "var(--panel)", border: "1px solid var(--rule)", borderRadius: 6 }}
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey={todayKey}
                      name={`Today (${METRICS[metric].label})`}
                      stroke="var(--brand-deep)"
                      strokeWidth={2.2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey={yestKey}
                      name={`Yesterday (${METRICS[metric].label})`}
                      stroke="var(--ink2)"
                      strokeWidth={1.6}
                      strokeDasharray="4 4"
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h2 style={{ margin: 0 }}>Sensor Correlation Overlay (Today)</h2>
                <select
                  aria-label="Select second metric to overlay"
                  className="select"
                  style={{ width: "auto", padding: "3px 8px", fontSize: 12.5 }}
                  value={overlayB}
                  onChange={(e) => setOverlayB(e.target.value as MetricKey)}
                >
                  {METRIC_KEYS.filter((k) => k !== metric).map((k) => (
                    <option key={k} value={k}>
                      Overlay with {METRICS[k].label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="note" style={{ marginTop: 0 }}>
                Overlays <b>{METRICS[metric].label}</b> and <b>{METRICS[overlayB].label}</b> on the same timeline to see how temperature, humidity, dust index, and air index move together.
              </p>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={hourly}>
                    <CartesianGrid stroke="var(--grid)" />
                    <XAxis dataKey="hour" fontSize={12} stroke="var(--ink2)" />
                    <YAxis yAxisId="left" fontSize={12} stroke="var(--brand-deep)" width={34} />
                    <YAxis yAxisId="right" orientation="right" fontSize={12} stroke="var(--fc)" width={34} />
                    <Tooltip
                      contentStyle={{ background: "var(--panel)", border: "1px solid var(--rule)", borderRadius: 6 }}
                    />
                    <Legend />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey={todayKey}
                      name={METRICS[metric].label}
                      stroke="var(--brand-deep)"
                      strokeWidth={2.2}
                      dot={false}
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey={overlayKey}
                      name={METRICS[overlayB].label}
                      stroke="var(--fc)"
                      strokeWidth={2}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>

          {/* Typical Hour-of-Day Pattern */}
          <section className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <h2 style={{ margin: 0 }}>Typical Hour-of-Day Pattern ({METRICS[metric].label})</h2>
              <span className="tag-estimated">Estimated pattern from Measured history</span>
            </div>
            <div style={{ height: 210 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={patternHours}>
                  <CartesianGrid stroke="var(--grid)" />
                  <XAxis dataKey="label" fontSize={12} stroke="var(--ink2)" />
                  <YAxis fontSize={12} stroke="var(--ink2)" width={36} />
                  <Tooltip
                    contentStyle={{ background: "var(--panel)", border: "1px solid var(--rule)", borderRadius: 6 }}
                  />
                  <Bar dataKey={metric} name={`Typical ${METRICS[metric].label}`} fill="var(--brand-leaf)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{ marginTop: 10 }}>
              <Link className="btn small" href={`/node/${encodeURIComponent(podId)}`}>
                ← Back to live pod strip charts
              </Link>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default function InsightsPage() {
  return (
    <Suspense fallback={<div className="wrap"><div className="skeleton">Loading insights...</div></div>}>
      <InsightsInner />
    </Suspense>
  );
}
