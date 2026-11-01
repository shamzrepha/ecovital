// Room forecast report: what each reading is likely to do over the next hour, why, and what to do about it.
// Numbers come from lib/forecast-ml.ts (trained on this pod's own history, plus outside weather when the pod has a location).
// Gemini only writes the friendly explanation from those numbers; it never makes up its own.

import { db, iso } from "./db.ts";
import {
  METRICS, METRIC_KEYS, classify, computeRoomScore, effectiveMetricCfg, statusRank, statusWord,
  type MetricCfg, type MetricKey, type Status, type ThresholdOverride,
} from "./config.ts";
import {
  HORIZONS, buildMinuteSeries, predictNext, trainMetric, weatherFlags,
  type Flag, type Horizon, type Method, type MinuteRow, type TrainedMetric,
} from "./forecast-ml.ts";
import { at_, describeWeather, getOutside, maxRainChance, type Outside } from "./weather.ts";
import { geminiText } from "./ai.ts";

export interface MetricPredictionPoint {
  horizon: Horizon;
  value: number;
  low: number;
  high: number;
  status: Status;
  statusWord: string;
  method: Method;
  skillPct: number;
}

export interface MetricForecast {
  metric: MetricKey;
  label: string;
  unit: string;
  current: number | null;
  perHour: number;
  trendWord: string;
  predictions: MetricPredictionPoint[];
  reaches: { minutes: number; level: "watch" | "bad"; word: string; side: "high" | "low" } | null;
}

export interface AiPredictionReport {
  podId: string;
  podName: string;
  profile: string;
  generatedAt: string;
  stale: boolean;
  learning: { state: "learning" | "ready"; trainedOnHours: number; usesWeather: boolean; note: string };
  location: { set: boolean };
  outside: null | {
    source: string;
    temp: number; hum: number; raining: boolean; sky: string;
    in3h: { temp: number; rainChance: number };
  };
  metrics: Record<MetricKey, MetricForecast>;
  roomScore: { now: number | null; in30: number | null; in60: number | null };
  flags: Flag[];
  riskLevel: "low" | "medium" | "high";
  headline: string;
  spokenForecast: string;
  aiNarrative: string;
  aiSource: "gemini" | "template";
  preventiveAction: string;
}

const num = (x: any): number | null => (x === null || x === undefined ? null : Number(x));
const DAYS = 7;

function trendWord(k: MetricKey, perHour: number): string {
  const a = Math.abs(perHour), step = METRICS[k].minDelta;
  if (a < step * 0.6) return "holding steady";
  const speed = a < step * 2.5 ? "slowly" : a < step * 6 ? "steadily" : "quickly";
  return `${perHour > 0 ? "rising" : "falling"} ${speed}`;
}

function adviceFor(k: MetricKey, side: "high" | "low"): string {
  switch (k) {
    case "hum": return side === "high" ? "Open a window or switch on a fan to let the damp air out." : "Drink some water, and a damp cloth or a bowl of water in the room may help.";
    case "temp": return side === "high" ? "Open windows on opposite sides, or switch on a fan or the AC." : "Close the windows and doors to keep the warmth in.";
    case "dust": return "Close windows facing the road and wipe surfaces with a damp cloth.";
    default: return "Open windows on opposite sides so fresh air can move through.";
  }
}

// Models are trained per pod and reused for a few minutes; the report itself is reused for 30 seconds.
const modelCache = new Map<string, { at: number; trained: Record<string, TrainedMetric>; weather: boolean }>();
const reportCache = new Map<string, { at: number; report: AiPredictionReport }>();
const narrativeCache = new Map<string, { at: number; sig: string; text: string }>();

export function clearPredictionCaches() { modelCache.clear(); reportCache.clear(); narrativeCache.clear(); }

export async function generateAiPredictions(podId: string, opts: { now?: number; fresh?: boolean } = {}): Promise<AiPredictionReport> {
  const now = opts.now ?? Date.now();
  const hit = reportCache.get(podId);
  if (!opts.fresh && !opts.now && hit && now - hit.at < 30_000) return hit.report;

  const sql = await db();
  const devRows = await sql`
    SELECT d.id, d.name, p.nickname, p.profile, p.weights, p.lat AS plat, p.lng AS plng
    FROM devices d LEFT JOIN pods p ON p.device_id = d.id WHERE d.id = ${podId}`;
  const dev = devRows[0] ?? { id: podId, name: podId, profile: "classroom" };
  const podName = (dev.nickname as string) || (dev.name as string) || podId;
  const profile = (dev.profile as string) || "classroom";
  const lat = num(dev.plat), lng = num(dev.plng);

  const ovRows = await sql`SELECT metric, watch_high, bad_high, watch_low, bad_low FROM thresholds_override WHERE pod = ${podId}`;
  const custom: Partial<Record<MetricKey, ThresholdOverride>> = {};
  for (const r of ovRows) {
    const k = r.metric as MetricKey;
    if (METRIC_KEYS.includes(k)) custom[k] = { watchHigh: num(r.watch_high), badHigh: num(r.bad_high), watchLow: num(r.watch_low), badLow: num(r.bad_low) };
  }
  const cfgs = {} as Record<MetricKey, MetricCfg>;
  for (const k of METRIC_KEYS) cfgs[k] = effectiveMetricCfg(k, profile, custom);

  // Minute-by-minute history for the last week
  const n = DAYS * 1440 + 1;
  const nowMin = Math.floor(now / 60_000) * 60_000;
  const t0 = nowMin - (n - 1) * 60_000;
  const raw = await sql`
    SELECT (extract(epoch from date_trunc('minute', ts)) * 1000)::float8 AS t,
           avg(dust)::float8 AS dust, avg(air)::float8 AS air, avg(temp)::float8 AS temp, avg(hum)::float8 AS hum
    FROM readings WHERE device_id = ${podId} AND ts > ${iso(t0)}::timestamptz AND ts <= ${iso(now)}::timestamptz
    GROUP BY 1 ORDER BY 1`;
  const rows: MinuteRow[] = raw.map((r: any) => ({ t: Number(r.t), dust: num(r.dust), air: num(r.air), temp: num(r.temp), hum: num(r.hum) }));
  const S = buildMinuteSeries(rows, t0, n);
  const lastRowT = rows.length ? rows[rows.length - 1].t : 0;
  const iNow = lastRowT ? Math.round((lastRowT - t0) / 60_000) : -1;
  const stale = iNow < 0 || now - lastRowT > 10 * 60_000;
  const firstT = rows.length ? rows[0].t : now;
  const trainedOnHours = Math.round(((lastRowT || now) - firstT) / 360_000) / 10;

  const outside: Outside | null = await getOutside(lat, lng, now);

  // Train (or reuse) one small model per reading and horizon
  let cached = modelCache.get(podId);
  if (!cached || now - cached.at > 5 * 60_000 || cached.weather !== !!outside) {
    const trained: Record<string, TrainedMetric> = {};
    if (iNow >= 0) for (const k of METRIC_KEYS) for (const H of HORIZONS) trained[`${k}:${H}`] = trainMetric(S, k, H, outside);
    cached = { at: now, trained, weather: !!outside };
    if (!opts.now) modelCache.set(podId, cached);
  }

  const cur = {} as Record<MetricKey, number | null>;
  const perHour = {} as Record<MetricKey, number>;
  const metrics = {} as Record<MetricKey, MetricForecast>;
  const predVals: Record<number, Partial<Record<MetricKey, number>>> = { 30: {}, 60: {} };
  let learnedAny = false, weatherUsed = false;

  for (const k of METRIC_KEYS) {
    let c: number | null = null;
    if (iNow >= 0) for (let j = 0; j <= 3; j++) { const x = S.v[k][iNow - j]; if (Number.isFinite(x)) { c = x; break; } }
    cur[k] = c;
    const back = iNow >= 30 ? S.v[k][iNow - 30] : NaN;
    perHour[k] = c !== null && Number.isFinite(back) ? (c - back) * 2 : 0;

    const preds: MetricPredictionPoint[] = [];
    if (!stale && c !== null) {
      for (const H of HORIZONS) {
        const t = cached.trained[`${k}:${H}`];
        const p = t ? predictNext(S, k, t, iNow, outside) : null;
        if (!p) continue;
        if (t.method === "learned") learnedAny = true;
        if (t.usesWeather) weatherUsed = true;
        const st = classify(k, p.value, "ok", cfgs[k]);
        preds.push({
          horizon: H, value: +p.value.toFixed(METRICS[k].decimals), low: +p.low.toFixed(METRICS[k].decimals), high: +p.high.toFixed(METRICS[k].decimals),
          status: st, statusWord: statusWord(k, st), method: p.method, skillPct: p.skillPct,
        });
        if (H === 30 || H === 60) predVals[H][k] = p.value;
      }
    }

    // When will it first leave the comfortable range? Walk the predicted path: now, +10, +30, +60 minutes.
    let reaches: MetricForecast["reaches"] = null;
    const curSt = c !== null ? classify(k, c, "ok", cfgs[k]) : "ok";
    if (c !== null && preds.length) {
      let prevT = 0, prevV = c;
      for (const p of preds) {
        if (statusRank(p.status) > statusRank(curSt)) {
          const high = p.status.endsWith("high"), bad = p.status.startsWith("bad");
          const target = high ? (bad ? cfgs[k].badHigh : cfgs[k].watchHigh) : (bad ? cfgs[k].badLow : cfgs[k].watchLow);
          let minutes: number = p.horizon;
          if (target != null && p.value !== prevV) minutes = prevT + ((target - prevV) / (p.value - prevV)) * (p.horizon - prevT);
          minutes = Math.max(2, Math.min(p.horizon, Math.round(minutes)));
          reaches = { minutes, level: bad ? "bad" : "watch", word: p.statusWord, side: high ? "high" : "low" };
          break;
        }
        prevT = p.horizon; prevV = p.value;
      }
    }

    metrics[k] = {
      metric: k, label: METRICS[k].label, unit: METRICS[k].unit,
      current: c !== null ? +c.toFixed(METRICS[k].decimals) : null,
      perHour: +perHour[k].toFixed(2), trendWord: c !== null ? trendWord(k, perHour[k]) : "no reading",
      predictions: preds, reaches,
    };
  }

  const weights = dev.weights ?? undefined;
  const scoreOf = (v: Partial<Record<MetricKey, number | null>>) => (Object.keys(v).length ? computeRoomScore(v, weights, profile, custom).score : null);
  const roomScore = {
    now: stale ? null : scoreOf(cur as any),
    in30: Object.keys(predVals[30]).length === 4 ? scoreOf(predVals[30]) : null,
    in60: Object.keys(predVals[60]).length === 4 ? scoreOf(predVals[60]) : null,
  };

  const flags = stale ? [] : weatherFlags({ now, room: cur, perHour, outside });

  // Overall risk, headline and advice
  const coming = METRIC_KEYS.map((k) => metrics[k]).filter((m) => m.reaches)
    .sort((a, b) => (b.reaches!.level === "bad" ? 1 : 0) - (a.reaches!.level === "bad" ? 1 : 0) || a.reaches!.minutes - b.reaches!.minutes);
  const worst = coming[0];
  const flagged = flags.find((f) => f.level === "flag") ?? flags.find((f) => f.level === "watch");
  const riskLevel: AiPredictionReport["riskLevel"] =
    worst?.reaches?.level === "bad" || flags.some((f) => f.level === "flag") ? "high"
      : worst || flags.some((f) => f.level === "watch") ? "medium" : "low";

  let headline: string, preventiveAction: string;
  if (stale) {
    headline = "No recent readings, so there is nothing to forecast yet.";
    preventiveAction = "Check that the pod is powered and shows green Wi-Fi bars.";
  } else if (worst) {
    const m = worst.reaches!;
    headline = `${worst.label} may become ${m.word.toLowerCase()} in about ${m.minutes} minutes.`;
    preventiveAction = adviceFor(worst.metric, m.side);
  } else if (flagged) {
    headline = flagged.title + ".";
    preventiveAction = flagged.text.split(". ").slice(-1)[0].replace(/\.?$/, ".");
  } else {
    headline = "The room should stay comfortable for the next hour.";
    preventiveAction = "No action needed right now.";
  }

  const learning: AiPredictionReport["learning"] = {
    state: learnedAny ? "ready" : "learning",
    trainedOnHours,
    usesWeather: weatherUsed,
    note: learnedAny
      ? `Learned from this pod's last ${trainedOnHours < 48 ? `${Math.round(trainedOnHours)} hours` : `${Math.round(trainedOnHours / 24)} days`} of readings${weatherUsed ? " and the outside weather" : ""}.`
      : trainedOnHours < 4
        ? "Still learning this room. Until it has about 4 hours of readings, forecasts follow the recent trend only."
        : "Using the recent trend. The learned model did not beat a simple trend on this pod's history yet.",
  };

  const outsideOut = outside
    ? {
        source: outside.source,
        temp: +outside.now.temp.toFixed(1), hum: Math.round(outside.now.hum), raining: outside.now.rainMm > 0.1,
        sky: describeWeather(outside.now.code, outside.now.rainMm),
        in3h: { temp: +(at_(outside.hours, now + 3 * 3600_000, "temp")).toFixed(1), rainChance: Math.round(maxRainChance(outside.hours, now, 3 * 3600_000)) },
      }
    : null;

  const base: AiPredictionReport = {
    podId, podName, profile, generatedAt: iso(now), stale, learning, location: { set: lat !== null && lng !== null },
    outside: outsideOut, metrics, roomScore, flags, riskLevel, headline,
    spokenForecast: "", aiNarrative: "", aiSource: "template", preventiveAction,
  };
  base.spokenForecast = spokenLine(base);
  const nar = await narrative(base, now);
  base.aiNarrative = nar.text;
  base.aiSource = nar.source;

  if (!opts.now) reportCache.set(podId, { at: Date.now(), report: base });
  return base;
}

function spokenLine(r: AiPredictionReport): string {
  if (r.stale) return "I have no recent readings from this room, so I cannot forecast yet.";
  const w = r.flags.find((f) => f.level === "flag");
  const first = w ? `Heads up: ${w.title.toLowerCase()}.` : `Looking ahead, it looks like ${r.headline.charAt(0).toLowerCase()}${r.headline.slice(1)}`;
  return `${first} ${r.preventiveAction}`.replace(/\s+/g, " ").trim();
}

function templateNarrative(r: AiPredictionReport): string {
  if (r.stale) return `${r.headline} ${r.preventiveAction}`;
  const parts: string[] = [`Looking ahead, it looks like ${r.headline.charAt(0).toLowerCase()}${r.headline.slice(1)} This is an estimate based on how the readings have been changing.`];
  if (r.outside) parts.push(`Outside it is ${r.outside.temp}°C and ${r.outside.sky}, with ${r.outside.hum}% humidity.`);
  const f = r.flags[0];
  if (f) parts.push(`${f.title}. ${f.text}`);
  if (r.preventiveAction && r.preventiveAction !== "No action needed right now.") parts.push(r.preventiveAction);
  return parts.join(" ");
}

const NARRATIVE_SYSTEM = `You are EcoVital, explaining a room forecast to someone who knows nothing about sensors. Write 3 to 4 short, friendly sentences in plain everyday words.
Rules: use ONLY the numbers in the JSON; every future number is an estimate, so say "looks like" or "may". Say what is likely to happen in the next hour and why (for example the way the numbers have been moving, or the weather outside). If a red flag is in the JSON, explain it simply and say what to check. End with one thing the person can do. Dust and air are simple 0 to 100 scores, never give them units like µg/m³ or ppm. No health claims, no markdown, no lists, no emojis. The pod cannot switch fans or windows on by itself.`;

async function narrative(r: AiPredictionReport, now: number): Promise<{ text: string; source: "gemini" | "template" }> {
  const tpl = templateNarrative(r);
  if (r.stale || !process.env.GEMINI_API_KEY) return { text: tpl, source: "template" };
  const sig = `${r.riskLevel}|${r.headline}|${r.flags.map((f) => f.id).join(",")}`;
  const hit = narrativeCache.get(r.podId);
  if (hit && hit.sig === sig && now - hit.at < 5 * 60_000) return { text: hit.text, source: "gemini" };
  try {
    const compact = {
      room: r.podName,
      headline: r.headline,
      risk: r.riskLevel,
      readings: Object.fromEntries(METRIC_KEYS.map((k) => [r.metrics[k].label, {
        now: r.metrics[k].current, trend: r.metrics[k].trendWord,
        in30min: r.metrics[k].predictions.find((p) => p.horizon === 30)?.value,
        in60min: r.metrics[k].predictions.find((p) => p.horizon === 60)?.value,
        willBe: r.metrics[k].reaches ? `${r.metrics[k].reaches!.word} in about ${r.metrics[k].reaches!.minutes} minutes` : "comfortable",
      }])),
      roomScore: r.roomScore,
      outside: r.outside,
      redFlags: r.flags.map((f) => ({ title: f.title, why: f.text, evidence: f.evidence })),
      action: r.preventiveAction,
    };
    const text = (await geminiText(`Forecast data (JSON):\n${JSON.stringify(compact)}`, NARRATIVE_SYSTEM, 420)).replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
    if (text.length > 30) {
      narrativeCache.set(r.podId, { at: now, sig, text });
      return { text, source: "gemini" };
    }
  } catch { /* use the template */ }
  return { text: tpl, source: "template" };
}

/** A short, plain summary of the forecast for the Ask assistant. Estimates are marked as such. */
export function forecastForAsk(r: AiPredictionReport) {
  return {
    note: "These are estimates, not measurements.",
    stale: r.stale,
    headline: r.headline,
    risk: r.riskLevel,
    howItWasMade: r.learning.note,
    readings: METRIC_KEYS.map((k) => ({
      name: r.metrics[k].label, now: r.metrics[k].current, unit: r.metrics[k].unit, trend: r.metrics[k].trendWord,
      in30min: r.metrics[k].predictions.find((p) => p.horizon === 30)?.value ?? null,
      in60min: r.metrics[k].predictions.find((p) => p.horizon === 60)?.value ?? null,
      likelyRange60min: (() => { const p = r.metrics[k].predictions.find((x) => x.horizon === 60); return p ? [p.low, p.high] : null; })(),
      willBecome: r.metrics[k].reaches ? `${r.metrics[k].reaches!.word} in about ${r.metrics[k].reaches!.minutes} minutes` : null,
    })),
    roomScore: r.roomScore,
    outsideWeather: r.outside
      ? { temperatureC: r.outside.temp, humidityPct: r.outside.hum, sky: r.outside.sky, next3hTempC: r.outside.in3h.temp, rainChanceNext3hPct: r.outside.in3h.rainChance, source: "Open-Meteo (outside data)" }
      : "not available: the pod has no location set",
    redFlags: r.flags.map((f) => ({ title: f.title, explanation: f.text, evidence: f.evidence })),
    suggestion: r.preventiveAction,
  };
}
