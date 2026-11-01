// Baseline forecasting: least-squares linear trend over the last few minutes.
// Honest by design: it is a trend extrapolation, not a trained model. It reports its own
// fit quality and says "steady" or "not enough data" instead of guessing.

import { METRICS, type MetricKey, type Side, type Level, HORIZON_MIN, WINDOW_MIN } from "./config.ts";

export interface Pt { t: number; v: number } // t in ms since epoch

export interface Crossing {
  threshold: number;
  side: Side;
  level: Level;
  minutes: number; // minutes from the last reading until the trend line reaches the threshold
}

export interface Forecast {
  metric: MetricKey;
  ok: boolean;
  reason?: string;
  horizonMin: number;
  trend: "rising" | "falling" | "steady";
  current: number; // fitted value at the last reading (smoothed)
  predicted: number;
  low: number; // ~90% interval
  high: number;
  slopePerMin: number;
  confidence: "low" | "medium" | "high";
  r2: number;
  n: number;
  spanMin: number;
  factors: string[];
  crossing?: Crossing;
}

interface Fit { n: number; spanMin: number; slope: number; end: number; r2: number; sd: number; seSlope: number }

export function linearFit(points: Pt[]): Fit | null {
  const n = points.length;
  if (n < 3) return null;
  const tLast = points[n - 1].t;
  const xs = points.map((p) => (p.t - tLast) / 60000); // minutes, <= 0
  const ys = points.map((p) => p.v);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx; // value at x = 0 (the last reading time)
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (intercept + slope * xs[i])) ** 2;
  const sd = Math.sqrt(sse / Math.max(1, n - 2));
  const r2 = syy === 0 ? 0 : Math.max(0, 1 - sse / syy);
  const seSlope = sd / Math.sqrt(sxx);
  return { n, spanMin: -xs[0], slope, end: intercept, r2, sd, seSlope };
}

export function forecast(metric: MetricKey, points: Pt[], horizonMin = HORIZON_MIN, cfgOverride?: import("./config.ts").MetricCfg): Forecast {
  const cfg = cfgOverride ?? METRICS[metric];
  const base: Forecast = {
    metric, ok: false, horizonMin, trend: "steady", current: NaN, predicted: NaN, low: NaN, high: NaN,
    slopePerMin: 0, confidence: "low", r2: 0, n: points.length, spanMin: 0, factors: [],
  };
  if (!points.length) return { ...base, reason: "No readings yet." };
  const tLast = points[points.length - 1].t;
  const win = points.filter((p) => tLast - p.t <= WINDOW_MIN * 60000);
  const f = linearFit(win);
  if (!f || f.n < 8 || f.spanMin < 3) {
    return {
      ...base, n: win.length, spanMin: f?.spanMin ?? 0,
      reason: "Not enough recent data. The estimate needs at least 8 readings spread over 3 minutes.",
    };
  }

  const clamp = (x: number) => Math.min(cfg.max, Math.max(cfg.min, x));
  const delta = f.slope * horizonMin;
  const predicted = clamp(f.end + delta);
  const half = 1.64 * Math.sqrt(f.sd ** 2 + (horizonMin * f.seSlope) ** 2);
  const tStat = f.seSlope > 0 ? Math.abs(f.slope) / f.seSlope : Infinity;
  const significant = tStat >= 3 && Math.abs(delta) >= cfg.minDelta;
  const trend: Forecast["trend"] = !significant ? "steady" : f.slope > 0 ? "rising" : "falling";

  let confidence: Forecast["confidence"];
  if (trend === "steady") confidence = f.n >= 20 && f.spanMin >= 6 ? "high" : "medium";
  else if (tStat >= 8 && f.r2 >= 0.7 && f.n >= 15 && f.spanMin >= 5) confidence = "high";
  else if (tStat >= 4 && f.r2 >= 0.4) confidence = "medium";
  else confidence = "low";

  const dp = cfg.decimals + 1;
  const factors = [
    `Fitted a straight line to ${f.n} readings over ${f.spanMin.toFixed(1)} min.`,
    `Slope ${f.slope >= 0 ? "+" : ""}${f.slope.toFixed(dp)} ${cfg.unit}/min, fit quality R² = ${f.r2.toFixed(2)}.`,
    `Reading noise about ±${f.sd.toFixed(cfg.decimals + 1)} ${cfg.unit}.`,
    trend === "steady"
      ? "The change over the next " + horizonMin + " min is within noise, so it is called steady."
      : `The trend is ${tStat.toFixed(1)}x larger than its uncertainty, so it is treated as real.`,
  ];

  // Will the trend line reach an alert threshold inside the horizon?
  let crossing: Crossing | undefined;
  if (trend !== "steady") {
    const cands: { thr: number; side: Side; level: Level }[] = [];
    if (cfg.watchHigh !== undefined) cands.push({ thr: cfg.watchHigh, side: "high", level: "watch" });
    if (cfg.badHigh !== undefined) cands.push({ thr: cfg.badHigh, side: "high", level: "bad" });
    if (cfg.watchLow !== undefined) cands.push({ thr: cfg.watchLow, side: "low", level: "watch" });
    if (cfg.badLow !== undefined) cands.push({ thr: cfg.badLow, side: "low", level: "bad" });
    for (const c of cands) {
      const towards = c.side === "high" ? f.slope > 0 && f.end < c.thr : f.slope < 0 && f.end > c.thr;
      if (!towards) continue;
      const minutes = (c.thr - f.end) / f.slope;
      if (minutes > 0 && minutes <= horizonMin && (!crossing || minutes < crossing.minutes)) {
        crossing = { threshold: c.thr, side: c.side, level: c.level, minutes };
      }
    }
    if (crossing) {
      factors.push(`At this rate it reaches ${crossing.threshold}${cfg.unit} in about ${Math.max(1, Math.round(crossing.minutes))} min.`);
    }
  }

  return {
    metric, ok: true, horizonMin, trend, current: f.end, predicted,
    low: clamp(predicted - half), high: clamp(predicted + half),
    slopePerMin: f.slope, confidence, r2: f.r2, n: f.n, spanMin: f.spanMin, factors, crossing,
  };
}

/** Compact summary of a short window, used for the AI context and the dashboard. */
export interface Summary { n: number; first: number; last: number; min: number; max: number; avg: number; change: number }
export function summarise(points: Pt[]): Summary | null {
  if (!points.length) return null;
  const vs = points.map((p) => p.v);
  const first = vs[0], last = vs[vs.length - 1];
  return {
    n: vs.length, first, last, min: Math.min(...vs), max: Math.max(...vs),
    avg: vs.reduce((a, b) => a + b, 0) / vs.length, change: last - first,
  };
}
