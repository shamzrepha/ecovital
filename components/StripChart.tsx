"use client";
import {
  ComposedChart, Line, XAxis, YAxis, ReferenceArea, ReferenceLine, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { METRICS, bands, fmt, type MetricCfg, type MetricKey } from "@/lib/config";

interface Props {
  metric: MetricKey;
  series: { t: number; v: number | null }[];
  now: number;
  rangeMs: number;
  forecast?: { ok: boolean; current: number; predicted: number; horizonMin: number } | null;
  events: { id: number; t: number; kind: string; metric: string | null }[];
  cfgOverride?: MetricCfg;
}

const Y_DOMAIN: Record<MetricKey, [number, number]> = { air: [0, 100], dust: [0, 100], hum: [0, 100], temp: [10, 45] };

function tick(rangeMs: number) {
  return (t: number) => {
    const d = new Date(t);
    if (rangeMs > 24 * 3600_000) return d.toLocaleDateString([], { weekday: "short", hour: "2-digit" });
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
}

export default function StripChart({ metric, series, now, rangeMs, forecast, events, cfgOverride }: Props) {
  const cfg = cfgOverride ?? METRICS[metric];
  const [y0, y1] = Y_DOMAIN[metric];
  const showForecast = !!forecast?.ok && rangeMs <= 6 * 3600_000;
  const horizonMs = (forecast?.horizonMin ?? 10) * 60_000;

  const rows: { t: number; v?: number | null; f?: number }[] = series.filter((p) => p.v !== null).map((p) => ({ t: p.t, v: p.v }));
  if (showForecast && rows.length) {
    const last = rows[rows.length - 1];
    last.f = forecast!.current; // dashed line starts from the smoothed current value
    rows.push({ t: last.t + horizonMs, f: forecast!.predicted });
  }
  const xMax = showForecast ? now + horizonMs : now;
  const xMin = now - rangeMs;
  const flags = events.filter((e) => e.metric === metric && e.t >= xMin && e.t <= now);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 10, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="var(--grid)" vertical={true} horizontal={true} />
        {bands(metric, cfg).map((b, i) => (
          <ReferenceArea key={i} y1={b.from} y2={b.to} fill={b.level === "bad" ? "var(--band-bad)" : "var(--band-watch)"} fillOpacity={1} stroke="none" ifOverflow="hidden" />
        ))}
        {flags.map((e) => (
          <ReferenceLine key={e.id} x={e.t} stroke={e.kind === "alert" ? "var(--bad)" : e.kind === "recovered" ? "var(--good)" : "var(--fc)"} strokeDasharray="2 3" />
        ))}
        <XAxis dataKey="t" type="number" domain={[xMin, xMax]} tickFormatter={tick(rangeMs)} tickCount={5} stroke="var(--ink2)" fontSize={12} tickLine={false} axisLine={{ stroke: "var(--rule)" }} />
        <YAxis domain={[y0, y1]} width={34} stroke="var(--ink2)" fontSize={12} tickLine={false} axisLine={false} tickCount={4} />
        <Tooltip
          cursor={{ stroke: "var(--ink2)", strokeDasharray: "2 3" }}
          contentStyle={{ background: "var(--panel)", border: "1px solid var(--rule)", borderRadius: 6, fontSize: 13, color: "var(--ink)" }}
          labelFormatter={(t) => new Date(Number(t)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          formatter={(val: any, name: any) => [`${fmt(metric, Number(val))} ${cfg.unit}`, name === "f" ? "Estimate" : "Measured"]}
        />
        <Line type="monotone" dataKey="v" stroke="var(--ink)" strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls={false} />
        {showForecast && (
          <Line type="linear" dataKey="f" stroke="var(--fc)" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
