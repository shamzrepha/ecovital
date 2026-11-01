// AI Predictive Engine: Multi-horizon (+10m, +30m, +60m) sensor & Room Score predictions,
// time-to-threshold countdowns, "What-If" intervention simulations, and Gemini spoken forecast synthesis.

import { db, iso } from "./db.ts";
import {
  METRICS,
  METRIC_KEYS,
  classify,
  computeRoomScore,
  effectiveMetricCfg,
  fmt,
  statusWord,
  type MetricCfg,
  type MetricKey,
} from "./config.ts";
import { forecast, type Pt } from "./predict.ts";

export interface HorizonPoint {
  horizonMin: 10 | 30 | 60;
  dust: number;
  air: number;
  temp: number;
  hum: number;
  roomScore: number;
  scoreWord: "Good" | "Fair" | "Poor" | "No data";
}

export interface MetricPrediction {
  metric: MetricKey;
  label: string;
  unit: string;
  current: number | null;
  pred10m: number | null;
  pred30m: number | null;
  pred60m: number | null;
  slopePerMin: number;
  trend: "rising" | "falling" | "steady";
  confidence: "high" | "medium" | "low";
  r2: number;
  PredictedStatus10m: string;
  PredictedStatus30m: string;
  crossing: {
    threshold: number;
    level: "watch" | "bad";
    side: "high" | "low";
    inMinutes: number;
  } | null;
}

export interface WhatIfScenario {
  id: "do_nothing" | "open_window" | "turn_on_fan" | "close_window_wipe";
  label: string;
  description: string;
  in15m: { dust: number; air: number; temp: number; hum: number; roomScore: number };
  in30m: { dust: number; air: number; temp: number; hum: number; roomScore: number };
  summary: string;
}

export interface AiPredictionReport {
  podId: string;
  podName: string;
  profile: string;
  generatedAt: string;
  riskLevel: "low" | "medium" | "high";
  headline: string;
  spokenForecast: string;
  aiNarrative: string;
  aiSource: "gemini" | "predictive-engine";
  horizons: HorizonPoint[];
  metrics: Record<MetricKey, MetricPrediction>;
  whatIfs: WhatIfScenario[];
  preventiveAction: string;
}

function clampMetric(k: MetricKey, v: number): number {
  const cfg = METRICS[k];
  return +Math.max(cfg.min, Math.min(cfg.max, v)).toFixed(cfg.decimals === 0 ? 0 : 1);
}

export async function generateAiPredictions(podId: string): Promise<AiPredictionReport> {
  const sql = await db();
  const now = Date.now();

  const devRows = await sql`
    SELECT d.id, d.name, p.nickname, p.profile, p.weights
    FROM devices d LEFT JOIN pods p ON p.device_id = d.id
    WHERE d.id = ${podId}
  `;
  const dev = devRows[0] || { id: podId, name: podId, profile: "classroom" };
  const podName = dev.nickname || dev.name || podId;
  const profile = dev.profile || "classroom";
  const weights = dev.weights || { air: 25, dust: 25, temp: 25, hum: 25 };

  // Load last 15 minutes of readings for trend + last 7 days for diurnal hour-of-day baseline
  const recentRows = await sql`
    SELECT (extract(epoch from ts) * 1000)::float8 AS t, dust, air, temp, hum
    FROM readings
    WHERE device_id = ${podId} AND ts > ${iso(now - 15 * 60_000)}::timestamptz
    ORDER BY ts ASC
  `;

  const hourlyRows = await sql`
    SELECT extract(hour from ts)::int AS hr,
           avg(dust)::float8 AS dust, avg(air)::float8 AS air,
           avg(temp)::float8 AS temp, avg(hum)::float8 AS hum
    FROM readings
    WHERE device_id = ${podId} AND ts > now() - interval '7 days'
    GROUP BY 1
  `;
  const diurnalMap = new Map<number, Record<MetricKey, number | null>>();
  for (const r of hourlyRows) {
    diurnalMap.set(Number(r.hr), {
      dust: r.dust != null ? Number(r.dust) : null,
      air: r.air != null ? Number(r.air) : null,
      temp: r.temp != null ? Number(r.temp) : null,
      hum: r.hum != null ? Number(r.hum) : null,
    });
  }

  const cfgs: Record<MetricKey, MetricCfg> = {} as any;
  for (const k of METRIC_KEYS) cfgs[k] = effectiveMetricCfg(k, profile);

  const curHour = new Date(now).getUTCHours();
  const nextHourD = diurnalMap.get((curHour + 1) % 24);

  const metricsOut = {} as Record<MetricKey, MetricPrediction>;
  const currentVals: Record<MetricKey, number> = { dust: 12, air: 88, temp: 27.5, hum: 48 };

  for (const k of METRIC_KEYS) {
    const pts: Pt[] = [];
    for (const r of recentRows) {
      if (r[k] !== null && r[k] !== undefined) {
        pts.push({ t: Number(r.t), v: Number(r[k]) });
      }
    }
    const f10 = forecast(k, pts, 10, cfgs[k]);
    const cur = pts.length ? pts[pts.length - 1].v : currentVals[k];
    currentVals[k] = cur;

    const slope = f10.ok ? f10.slopePerMin : 0;
    const r2 = f10.ok ? f10.r2 : 0;
    const conf = f10.ok ? f10.confidence : "low";
    const trend = f10.ok ? f10.trend : "steady";

    // Blend linear velocity with damped inertia + diurnal pull for 30m and 60m horizons
    const p10 = clampMetric(k, f10.ok ? f10.predicted : cur);
    const damped30 = cur + slope * 22; // velocity damps over longer windows
    const diurnalTarget = nextHourD?.[k] ?? cur;
    const p30 = clampMetric(k, damped30 * 0.8 + diurnalTarget * 0.2);
    const p60 = clampMetric(k, (cur + slope * 34) * 0.65 + diurnalTarget * 0.35);

    const st10 = classify(k, p10, "ok", cfgs[k]);
    const st30 = classify(k, p30, st10, cfgs[k]);

    let crossing: MetricPrediction["crossing"] = null;
    if (f10.ok && f10.crossing) {
      crossing = {
        threshold: f10.crossing.threshold,
        level: f10.crossing.level === "bad" ? "bad" : "watch",
        side: f10.crossing.side,
        inMinutes: Math.max(1, Math.round(f10.crossing.minutes)),
      };
    } else if (st30 !== "ok" && classify(k, cur, "ok", cfgs[k]) === "ok" && Math.abs(slope) > 0.02) {
      const cfg = cfgs[k];
      const th = slope > 0 ? (cfg.watchHigh ?? 35) : (cfg.watchLow ?? 30);
      const mins = Math.max(10, Math.min(45, Math.round(Math.abs((th - cur) / slope))));
      crossing = {
        threshold: th,
        level: "watch",
        side: slope > 0 ? "high" : "low",
        inMinutes: mins,
      };
    }

    metricsOut[k] = {
      metric: k,
      label: cfgs[k].label,
      unit: cfgs[k].unit,
      current: +cur.toFixed(cfgs[k].decimals),
      pred10m: p10,
      pred30m: p30,
      pred60m: p60,
      slopePerMin: +slope.toFixed(3),
      trend,
      confidence: conf,
      r2: +r2.toFixed(2),
      PredictedStatus10m: statusWord(k, st10),
      PredictedStatus30m: statusWord(k, st30),
      crossing,
    };
  }

  const horizons: HorizonPoint[] = ([10, 30, 60] as const).map((h) => {
    const key = h === 10 ? "pred10m" : h === 30 ? "pred30m" : "pred60m";
    const vals = {
      dust: metricsOut.dust[key] ?? currentVals.dust,
      air: metricsOut.air[key] ?? currentVals.air,
      temp: metricsOut.temp[key] ?? currentVals.temp,
      hum: metricsOut.hum[key] ?? currentVals.hum,
    };
    const rs = computeRoomScore(vals, weights, profile);
    return {
      horizonMin: h,
      ...vals,
      roomScore: rs.score ?? 80,
      scoreWord: rs.word,
    };
  });

  // Compute "What-If" Intervention Simulations
  const p15Nothing = {
    dust: clampMetric("dust", (metricsOut.dust.pred10m! + metricsOut.dust.pred30m!) / 2),
    air: clampMetric("air", (metricsOut.air.pred10m! + metricsOut.air.pred30m!) / 2),
    temp: clampMetric("temp", (metricsOut.temp.pred10m! + metricsOut.temp.pred30m!) / 2),
    hum: clampMetric("hum", (metricsOut.hum.pred10m! + metricsOut.hum.pred30m!) / 2),
  };
  const p30Nothing = {
    dust: metricsOut.dust.pred30m!,
    air: metricsOut.air.pred30m!,
    temp: metricsOut.temp.pred30m!,
    hum: metricsOut.hum.pred30m!,
  };

  const makeWhatIf = (
    id: WhatIfScenario["id"],
    label: string,
    description: string,
    adj15: Partial<Record<MetricKey, number>>,
    adj30: Partial<Record<MetricKey, number>>,
  ): WhatIfScenario => {
    const v15 = {
      dust: clampMetric("dust", p15Nothing.dust + (adj15.dust ?? 0)),
      air: clampMetric("air", p15Nothing.air + (adj15.air ?? 0)),
      temp: clampMetric("temp", p15Nothing.temp + (adj15.temp ?? 0)),
      hum: clampMetric("hum", p15Nothing.hum + (adj15.hum ?? 0)),
    };
    const v30 = {
      dust: clampMetric("dust", p30Nothing.dust + (adj30.dust ?? 0)),
      air: clampMetric("air", p30Nothing.air + (adj30.air ?? 0)),
      temp: clampMetric("temp", p30Nothing.temp + (adj30.temp ?? 0)),
      hum: clampMetric("hum", p30Nothing.hum + (adj30.hum ?? 0)),
    };
    const s15 = computeRoomScore(v15, weights, profile).score ?? 80;
    const s30 = computeRoomScore(v30, weights, profile).score ?? 80;
    return {
      id,
      label,
      description,
      in15m: { ...v15, roomScore: s15 },
      in30m: { ...v30, roomScore: s30 },
      summary: `Projected Room Score in 30 min: ${s30}/100 (Air ${v30.air}%, Dust ${v30.dust}%, Temp ${v30.temp}°C, Hum ${v30.hum}%).`,
    };
  };

  const whatIfs: WhatIfScenario[] = [
    makeWhatIf(
      "do_nothing",
      "If no action is taken",
      "Follows the current 10-minute sensor slope and room rhythm.",
      {},
      {},
    ),
    makeWhatIf(
      "open_window",
      "Open opposite windows now",
      "Cross-ventilation clears stale air (+14% air index) and moderates indoor heat and dampness.",
      { air: 9, temp: -0.7, hum: currentVals.hum > 60 ? -5 : 3, dust: -4 },
      { air: 15, temp: -1.3, hum: currentVals.hum > 60 ? -9 : 6, dust: -7 },
    ),
    makeWhatIf(
      "turn_on_fan",
      "Switch on ceiling / standing fan",
      "Improves air mixing, lowers heat buildup, and helps disperse pockets of damp or stuffy air.",
      { temp: -0.9, hum: -4, air: 5 },
      { temp: -1.6, hum: -7, air: 8 },
    ),
    makeWhatIf(
      "close_window_wipe",
      "Close road-facing windows & damp-wipe",
      "Blocks outdoor harmattan/road dust spikes (-18% dust index) and lets airborne particles settle.",
      { dust: -11, hum: 2 },
      { dust: -19, hum: 4 },
    ),
  ];

  // Determine overall risk level, headline, and preventive action
  const crossings = METRIC_KEYS.map((k) => metricsOut[k]).filter((m) => m.crossing !== null);
  const scoreNow = computeRoomScore(currentVals, weights, profile).score ?? 85;
  const score30 = horizons[1].roomScore;

  let riskLevel: "low" | "medium" | "high" = "low";
  let headline = `Air in ${podName} is predicted to stay comfortable over the next 30 minutes (projected Room Score ${score30}/100).`;
  let preventiveAction = "Keep current ventilation steady; no immediate intervention needed.";
  let spokenForecast = `AI forecast for ${podName}. Readings look steady. Room score is projected to stay around ${score30} out of 100 over the next 30 minutes.`;

  if (crossings.length > 0) {
    const first = crossings.sort((a, b) => a.crossing!.inMinutes - b.crossing!.inMinutes)[0];
    const c = first.crossing!;
    riskLevel = c.level === "bad" || c.inMinutes <= 6 ? "high" : "medium";
    const dirWord = c.side === "high" ? "rise above" : "drop below";
    headline = `Early Warning: ${first.label} is projected to ${dirWord} ${c.threshold}${first.unit} in ~${c.inMinutes} minutes (${first.current}${first.unit} → ${first.pred10m}${first.unit}).`;

    if (first.metric === "dust") {
      preventiveAction = "Close road-facing windows now and damp-wipe desks before dust reaches the watch zone.";
    } else if (first.metric === "air") {
      preventiveAction = "Open two windows for cross-ventilation now to prevent the air from turning stuffy.";
    } else if (first.metric === "hum" && c.side === "low") {
      preventiveAction = "Drink water and place a bowl of water in the room before humidity drops further.";
    } else {
      preventiveAction = "Turn on a fan or open windows now to keep temperature and humidity inside the comfort band.";
    }

    spokenForecast = `Early warning for ${podName}. At the current trend, ${first.label.toLowerCase()} is estimated to ${dirWord} ${c.threshold} ${first.unit} in about ${c.inMinutes} minutes. ${preventiveAction}`;
  } else if (score30 < 65 || score30 < scoreNow - 8) {
    riskLevel = "medium";
    headline = `Room Score in ${podName} is projected to drift from ${scoreNow} to ${score30} over the next 30 minutes.`;
    preventiveAction = "Open a window or switch on a fan now to keep the Room Score in the Good range.";
    spokenForecast = `AI forecast for ${podName}. Room score is estimated to slide from ${scoreNow} to ${score30} over the next 30 minutes. ${preventiveAction}`;
  }

  let aiNarrative = `${headline} In 10 minutes: Dust index ${horizons[0].dust}%, Air index ${horizons[0].air}%, Temperature ${horizons[0].temp}°C, Humidity ${horizons[0].hum}%. Recommended action: ${preventiveAction}`;
  let aiSource: "gemini" | "predictive-engine" = "predictive-engine";

  if (process.env.GEMINI_API_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash"}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: "You are EcoVital's AI Predictive Engine. Given current sensor readings and 10m/30m/60m trend projections, write a clear 2-sentence prediction explaining what the room air will do over the next 30 minutes and one concrete preventive action. Never use ug/m3 or ppm for dust or air index (they are 0-100% indexes). Never make medical claims.",
                },
              ],
            },
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: JSON.stringify({
                      podName,
                      profile,
                      currentVals,
                      horizons,
                      crossings: crossings.map((x) => ({ metric: x.metric, crossing: x.crossing })),
                    }),
                  },
                ],
              },
            ],
          }),
        },
      );
      if (res.ok) {
        const j: any = await res.json();
        const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (txt && txt.length > 15 && !/\b(ppm|ug\/m3|µg\/m3)\b/i.test(txt)) {
          aiNarrative = txt.replace(/[*#`]/g, "");
          spokenForecast = aiNarrative;
          aiSource = "gemini";
        }
      }
    } catch {
      // Fallback to deterministic predictive narrative
    }
  }

  const report: AiPredictionReport = {
    podId,
    podName,
    profile,
    generatedAt: iso(now),
    riskLevel,
    headline,
    spokenForecast,
    aiNarrative,
    aiSource,
    horizons,
    metrics: metricsOut,
    whatIfs,
    preventiveAction,
  };

  // Optional Firebase Realtime Database sync if FIREBASE_DATABASE_URL is configured
  const fbUrl = process.env.FIREBASE_DATABASE_URL || process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL;
  if (fbUrl && fbUrl.startsWith("https://")) {
    const cleanBase = fbUrl.replace(/\/+$/, "");
    fetch(`${cleanBase}/ecovital/predictions/${encodeURIComponent(podId)}.json`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    }).catch(() => {});
  }

  return report;
}
