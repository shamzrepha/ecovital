// Room forecasting that learns from the pod's own history.
//
// For each reading (dust, air, temperature, humidity) and each horizon (+10, +30, +60 min) we train a small ridge
// regression on the pod's last 7 days. The inputs are how fast the value is changing right now (over 5, 15 and 60 min),
// how far it is from its usual level, the time of day, and, when the pod has a location, the outside weather (outside
// temperature gap, how much it is about to change, and the chance of rain). The model is only used if it beats two simple
// guesses on data it has not seen ("no change" and "keep drifting a little"). Otherwise the forecast falls back to the better
// of those guesses and says so. Nothing here is a medical or safety claim: all outputs are estimates.

import { METRIC_KEYS, METRICS, type MetricKey } from "./config.ts";
import { at_, maxRainChance, type Outside } from "./weather.ts";

export const HORIZONS = [10, 30, 60] as const;
export type Horizon = (typeof HORIZONS)[number];

export interface MinuteRow { t: number; dust: number | null; air: number | null; temp: number | null; hum: number | null }

export interface MinuteSeries {
  t0: number;      // ms of minute 0
  n: number;       // number of minutes
  v: Record<MetricKey, Float64Array>;   // NaN where there is no reading
  sum: Record<MetricKey, Float64Array>; // prefix sums for rolling means
  cnt: Record<MetricKey, Int32Array>;
}

export function buildMinuteSeries(rows: MinuteRow[], t0: number, n: number): MinuteSeries {
  const v = {} as MinuteSeries["v"], sum = {} as MinuteSeries["sum"], cnt = {} as MinuteSeries["cnt"];
  for (const k of METRIC_KEYS) { v[k] = new Float64Array(n).fill(NaN); sum[k] = new Float64Array(n + 1); cnt[k] = new Int32Array(n + 1); }
  for (const r of rows) {
    const i = Math.round((r.t - t0) / 60_000);
    if (i < 0 || i >= n) continue;
    for (const k of METRIC_KEYS) { const x = r[k]; if (x !== null && x !== undefined && Number.isFinite(x)) v[k][i] = x; }
  }
  for (const k of METRIC_KEYS) {
    for (let i = 0; i < n; i++) {
      const x = v[k][i];
      sum[k][i + 1] = sum[k][i] + (Number.isFinite(x) ? x : 0);
      cnt[k][i + 1] = cnt[k][i] + (Number.isFinite(x) ? 1 : 0);
    }
  }
  return { t0, n, v, sum, cnt };
}

/** Value at minute i, borrowing the nearest earlier reading up to `gap` minutes back. */
function val(S: MinuteSeries, k: MetricKey, i: number, gap = 3): number {
  for (let j = 0; j <= gap; j++) { const x = S.v[k][i - j]; if (i - j >= 0 && Number.isFinite(x)) return x; }
  return NaN;
}

const FEATURES_BASE = 6;
const FEATURES_EXO = 4;

function features(S: MinuteSeries, k: MetricKey, i: number, H: number, outside: Outside | null, strict = true): number[] | null {
  const cur = val(S, k, i);
  let v5 = val(S, k, i - 5), v15 = val(S, k, i - 15), v60 = val(S, k, i - 60);
  if (!Number.isFinite(cur)) return null;
  if (strict) {
    if (![v5, v15, v60].every(Number.isFinite)) return null;
  } else {
    // A new pod has little history: measure the slope over the longest look-back it does have (never zero-padded).
    const slopeOver = (L: number) => {
      for (const lag of [L, 30, 15, 10, 5, 3, 2, 1]) {
        if (lag > L) continue;
        const x = val(S, k, i - lag, 0);
        if (Number.isFinite(x)) return (cur - x) / lag;
      }
      return 0;
    };
    const s5 = slopeOver(5), s15 = slopeOver(15), s60 = slopeOver(60);
    v5 = cur - s5 * 5; v15 = cur - s15 * 15; v60 = cur - s60 * 60;
  }
  const from = Math.max(0, i - 1440);
  const c = S.cnt[k][i + 1] - S.cnt[k][from];
  const mean = c >= 60 ? (S.sum[k][i + 1] - S.sum[k][from]) / c : cur;
  const tNow = S.t0 + i * 60_000;
  const d = new Date(tNow);
  const hr = d.getUTCHours() + d.getUTCMinutes() / 60;
  const f = [(cur - v5) / 5, (cur - v15) / 15, (cur - v60) / 60, cur - mean, Math.sin((2 * Math.PI * hr) / 24), Math.cos((2 * Math.PI * hr) / 24)];
  if (outside) {
    const oT = at_(outside.hours, tNow, "temp");
    const roomT = k === "temp" ? cur : val(S, "temp", i);
    const oT2 = at_(outside.hours, tNow + H * 60_000, "temp");
    const oH = at_(outside.hours, tNow, "hum"), oH2 = at_(outside.hours, tNow + H * 60_000, "hum");
    f.push(Number.isFinite(roomT) ? oT - roomT : 0, oT2 - oT, oH2 - oH, maxRainChance(outside.hours, tNow, H * 60_000) / 100);
  }
  return f.map((x) => (Number.isFinite(x) ? x : 0));
}

// ---------- ridge regression ----------
interface Ridge { mu: number[]; sd: number[]; w: number[]; yMean: number }

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-9;
    for (let r = c + 1; r < n; r++) {
      const m = M[r][c] / piv;
      for (let k = c; k <= n; k++) M[r][k] -= m * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-9);
  }
  return x;
}

function fitRidge(X: number[][], y: number[], lambda = 3): Ridge {
  const n = X.length, p = X[0].length;
  const mu = new Array(p).fill(0), sd = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    let s = 0; for (let i = 0; i < n; i++) s += X[i][j];
    mu[j] = s / n;
    let q = 0; for (let i = 0; i < n; i++) q += (X[i][j] - mu[j]) ** 2;
    sd[j] = Math.sqrt(q / n) || 1;
  }
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  const Z = X.map((row) => row.map((x, j) => (x - mu[j]) / sd[j]));
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      b[j] += Z[i][j] * (y[i] - yMean);
      for (let k = 0; k < p; k++) A[j][k] += Z[i][j] * Z[i][k];
    }
  }
  for (let j = 0; j < p; j++) A[j][j] += lambda;
  return { mu, sd, w: solve(A, b), yMean };
}

const ridgePredict = (m: Ridge, x: number[]) => m.yMean + x.reduce((s, xj, j) => s + (m.w[j] * (xj - m.mu[j])) / m.sd[j], 0);
const trendDelta = (x: number[], H: number) => x[1] * H * 0.6;   // keep drifting at the 15 min rate, fading over time
const mae = (a: number[]) => (a.length ? a.reduce((s, v) => s + Math.abs(v), 0) / a.length : NaN);
const std = (a: number[]) => { if (a.length < 2) return 0; const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

export type Method = "learned" | "trend" | "steady";

export interface TrainedMetric {
  metric: MetricKey;
  horizon: Horizon;
  method: Method;
  samples: number;
  skillPct: number;        // how much smaller the typical error is than "no change", on data the model did not train on
  sigma: number;           // typical error, used for the range
  usesWeather: boolean;
  model: Ridge | null;
}

const MIN_SAMPLES = 48;     // about 4 hours of 5-minute steps

export function trainMetric(S: MinuteSeries, k: MetricKey, H: Horizon, outside: Outside | null): TrainedMetric {
  const X: number[][] = [], y: number[] = [];
  for (let i = 60; i < S.n - H; i += 5) {
    const x = features(S, k, i, H, outside);
    const cur = val(S, k, i), fut = val(S, k, i + H, 2);
    if (!x || !Number.isFinite(fut)) continue;
    X.push(x); y.push(fut - cur);
  }
  const floor = METRICS[k].minDelta / 2;
  if (X.length < MIN_SAMPLES) {
    return { metric: k, horizon: H, method: "trend", samples: X.length, skillPct: 0, sigma: Math.max(floor, METRICS[k].minDelta * (H / 30)), usesWeather: false, model: null };
  }
  const cut = Math.max(MIN_SAMPLES - 12, Math.floor(X.length * 0.75));
  const hold = X.slice(cut), holdY = y.slice(cut);
  const trial = fitRidge(X.slice(0, cut), y.slice(0, cut));
  const eLearn = hold.map((x, i) => holdY[i] - ridgePredict(trial, x));
  const eTrend = hold.map((x, i) => holdY[i] - trendDelta(x, H));
  const eSteady = holdY;
  const mL = mae(eLearn), mT = mae(eTrend), mS = mae(eSteady);

  let method: Method = "steady", errs = eSteady, best = mS;
  if (mT < best) { method = "trend"; errs = eTrend; best = mT; }
  if (mL < best * 0.95) { method = "learned"; errs = eLearn; best = mL; }
  const skill = mS > 1e-9 ? Math.max(0, Math.min(0.99, 1 - best / mS)) : 0;
  return {
    metric: k, horizon: H, method, samples: X.length,
    skillPct: Math.round(skill * 100),
    sigma: Math.max(floor, std(errs) || best || floor),
    usesWeather: !!outside && method === "learned",
    model: method === "learned" ? fitRidge(X, y) : null,
  };
}

export interface Prediction { horizon: Horizon; value: number; low: number; high: number; method: Method; skillPct: number }

export function predictNext(S: MinuteSeries, k: MetricKey, trained: TrainedMetric, i: number, outside: Outside | null): Prediction | null {
  const x = features(S, k, i, trained.horizon, outside, false);
  const cur = val(S, k, i);
  if (!x || !Number.isFinite(cur)) return null;
  let delta = trained.method === "learned" && trained.model ? ridgePredict(trained.model, x) : trained.method === "steady" ? 0 : trendDelta(x, trained.horizon);
  const cfg = METRICS[k];
  const clamp = (v: number) => Math.max(cfg.min, Math.min(cfg.max, v));
  const z = 1.64 * trained.sigma;
  const value = clamp(cur + delta);
  return { horizon: trained.horizon, value, low: clamp(value - z), high: clamp(value + z), method: trained.method, skillPct: trained.skillPct };
}

// ---------- weather-aware red flags, in plain words ----------
export interface Flag { id: string; level: "info" | "watch" | "flag"; title: string; text: string; evidence: string[] }

export function weatherFlags(a: {
  now: number;
  room: Partial<Record<MetricKey, number | null>>;
  perHour: Partial<Record<MetricKey, number>>;   // measured change per hour over the last 30-60 min
  outside: Outside | null;
}): Flag[] {
  const { room, perHour, outside, now } = a;
  const out: Flag[] = [];
  if (!outside) return out;
  const oT = outside.now.temp, oH = outside.now.hum;
  const rainNow = outside.now.rainMm > 0.1;
  const rain3 = maxRainChance(outside.hours, now, 3 * 3600_000);
  const oT3 = at_(outside.hours, now + 3 * 3600_000, "temp") - oT;
  const rT = room.temp ?? null, rH = room.hum ?? null;
  const tTrend = perHour.temp ?? 0, hTrend = perHour.hum ?? 0;
  const f1 = (x: number) => x.toFixed(1);

  if (rT !== null) {
    const coolingOutside = rainNow || oT3 <= -2;
    if (coolingOutside && rT - oT >= 3 && tTrend >= 0.3) {
      out.push({
        id: "warm-inside-cooling-outside", level: "flag",
        title: "The room is getting warmer while it cools down outside",
        text: "When the weather turns cooler, a room normally cools a little too. This one is going the other way, so something inside may be adding heat, or the room is shut up. Opening a window on the shady side or checking what is running may help.",
        evidence: [`Room ${f1(rT)}°C and rising about ${f1(tTrend)}°C per hour (measured)`, `Outside ${f1(oT)}°C${rainNow ? " and raining" : ""}, expected change over 3 hours: ${f1(oT3)}°C (outside data)`],
      });
    } else if ((rainNow || rain3 >= 60) && oT3 <= -1 && rT - oT >= 2) {
      out.push({
        id: "rain-cooler", level: "info",
        title: rainNow ? "It is raining outside, so the room may cool down" : "Rain is likely soon, so the room may cool down",
        text: "Rain and cooler air outside usually bring the room temperature down over the next hour or two. That is normal and does not mean anything is wrong.",
        evidence: [`Outside ${f1(oT)}°C, rain chance up to ${Math.round(rain3)}% in 3 hours (outside data)`, `Room ${f1(rT)}°C now (measured)`],
      });
    }
    if (!rainNow && oT >= rT && tTrend <= -1) {
      out.push({
        id: "cooling-while-warm-outside", level: "watch",
        title: "The room is cooling quickly even though it is warm outside",
        text: "It is not cooler outside, so this drop is coming from inside. An air conditioner turned on, or a fan, would explain it. If nothing like that is running, it is worth a look.",
        evidence: [`Room ${f1(rT)}°C and falling about ${f1(-tTrend)}°C per hour (measured)`, `Outside ${f1(oT)}°C, no rain (outside data)`],
      });
    }
    if (rT >= 30 && rT - oT >= 4 && !rainNow) {
      out.push({
        id: "cooler-outside", level: "info",
        title: "It is cooler outside than inside",
        text: "Opening windows or doors on opposite sides could cool the room faster than waiting.",
        evidence: [`Room ${f1(rT)}°C (measured)`, `Outside ${f1(oT)}°C (outside data)`],
      });
    }
  }
  if (rH !== null) {
    if ((rainNow || oH >= 85) && hTrend >= 2) {
      out.push({
        id: "damp-outside", level: "watch",
        title: "Damp air outside may keep the room humidity rising",
        text: "The air outside is very moist. Keeping windows closed, or using a fan, will help the room stay more comfortable.",
        evidence: [`Room humidity ${Math.round(rH)}% and rising about ${f1(hTrend)} points per hour (measured)`, `Outside humidity ${Math.round(oH)}%${rainNow ? ", raining" : ""} (outside data)`],
      });
    }
    if (oH <= 35 && rH <= 40) {
      out.push({
        id: "dry-outside", level: "info",
        title: "The air outside is very dry",
        text: "Dry outside air, like during harmattan, will not fix a dry room, and it can bring more dust in when windows are open. Drinking water and a damp cloth near the vents may help.",
        evidence: [`Outside humidity ${Math.round(oH)}% (outside data)`, `Room humidity ${Math.round(rH)}% (measured)`],
      });
    }
  }
  return out;
}

export { METRIC_KEYS };
