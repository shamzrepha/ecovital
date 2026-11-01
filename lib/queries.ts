// Read-side queries for the dashboard.

import { db, iso, type Row } from "./db.ts";
import {
  METRIC_KEYS, METRICS, HORIZON_MIN, classify, computeRoomScore, effectiveMetricCfg,
  type MetricKey, type ThresholdOverride, type MetricCfg,
} from "./config.ts";
import { forecast, type Pt } from "./predict.ts";
import { detectAnomalies } from "./pods.ts";

const num = (x: any): number | null => (x === null || x === undefined ? null : Number(x));
const ONLINE_MS = 2 * 60_000;

export const RANGES: Record<string, { ms: number; bucketS: number; label: string }> = {
  "1h": { ms: 3600_000, bucketS: 15, label: "last hour" },
  "6h": { ms: 6 * 3600_000, bucketS: 90, label: "last 6 hours" },
  "24h": { ms: 24 * 3600_000, bucketS: 360, label: "last 24 hours" },
  "7d": { ms: 7 * 24 * 3600_000, bucketS: 2400, label: "last 7 days" },
};

export function podStateLabel(online: boolean, lastSeen: number | null, now: number, simulated: boolean): {
  code: "online" | "offline" | "waiting" | "simulated";
  label: string;
  offlineVoiceNote?: string;
} {
  if (simulated) return { code: "simulated", label: "Simulated" };
  if (lastSeen === null) return { code: "waiting", label: "Waiting for cloud" };
  if (online) return { code: "online", label: "Online" };
  const mins = Math.max(1, Math.round((now - lastSeen) / 60_000));
  return {
    code: "offline",
    label: mins < 60 ? `Offline (last seen ${mins} min ago)` : `Offline (last seen ${Math.round(mins / 60)} h ago)`,
    offlineVoiceNote: "This pod is offline but still giving spoken advice.",
  };
}

export async function getNodes() {
  const sql = await db();
  const now = Date.now();
  const rows = await sql`
    SELECT d.id, d.name, d.location, d.lat, d.lng, d.simulated, d.state, d.meta,
           p.claimed_by, p.profile, p.volume, p.muted, p.nickname, p.weights, p.share_token,
           t.version AS target_fw,
           (extract(epoch from d.last_seen) * 1000)::float8 AS last_seen,
           (SELECT row_to_json(r) FROM (
              SELECT dust, air, temp, hum, (extract(epoch from ts) * 1000)::float8 AS t
              FROM readings WHERE device_id = d.id ORDER BY ts DESC LIMIT 1) r) AS latest,
           (SELECT row_to_json(ev) FROM (
              SELECT id, (extract(epoch from ts) * 1000)::float8 AS t, kind, metric, spoken, source, data
              FROM events WHERE device_id = d.id AND spoken_flag AND spoken IS NOT NULL ORDER BY ts DESC LIMIT 1) ev) AS last_spoken,
           (SELECT count(*) FROM events e WHERE e.device_id = d.id AND e.kind = 'alert'
              AND e.ts > now() - interval '24 hours') AS alerts24
    FROM devices d
    LEFT JOIN pods p ON p.device_id = d.id
    LEFT JOIN pod_firmware_target t ON t.device_id = d.id
    ORDER BY d.simulated, d.last_seen DESC NULLS LAST`;
  const tot = await sql`SELECT count(*) AS n FROM readings WHERE ts > now() - interval '24 hours'`;
  const nodes = rows.map((r) => {
    const lastSeen = num(r.last_seen);
    const online = lastSeen !== null && now - lastSeen < ONLINE_MS;
    const latest = r.latest ? {
      t: Number(r.latest.t), dust: num(r.latest.dust), air: num(r.latest.air), temp: num(r.latest.temp), hum: num(r.latest.hum),
    } : null;
    const profile = (r.profile as string) ?? "classroom";
    const roomScore = computeRoomScore(latest ?? {}, r.weights ?? undefined, profile);
    const pState = podStateLabel(online, lastSeen, now, !!r.simulated);
    return {
      id: r.id as string,
      name: (r.nickname as string) || (r.name as string),
      location: (r.location as string) ?? null,
      lat: num(r.lat), lng: num(r.lng), simulated: !!r.simulated,
      lastSeen, online,
      podState: pState,
      claimedBy: (r.claimed_by as string) ?? null,
      profile,
      volume: Number(r.volume ?? 100),
      muted: !!r.muted,
      shareToken: (r.share_token as string) ?? null,
      fw: (r.meta as any)?.fw ?? null,
      targetFw: (r.target_fw as string) ?? null,
      claimCode: (r.meta as any)?.claim ?? null,
      latest,
      roomScore,
      lastSpoken: r.last_spoken ? {
        id: Number(r.last_spoken.id),
        t: Number(r.last_spoken.t),
        kind: r.last_spoken.kind as string,
        metric: r.last_spoken.metric as string,
        spoken: r.last_spoken.spoken as string,
        source: r.last_spoken.source as string,
        action: r.last_spoken.data?.action ?? "none",
        tags: r.last_spoken.data?.tags ?? ["measured"],
        translatedText: r.last_spoken.data?.translatedText ?? null,
      } : null,
      status: (r.state?.status ?? {}) as Record<string, string>,
      alerts24: Number(r.alerts24),
    };
  });
  return { now, nodes, readings24h: Number(tot[0]?.n ?? 0) };
}

export async function getNodeDetail(id: string, rangeKey: string) {
  const sql = await db();
  const now = Date.now();
  const range = RANGES[rangeKey] ?? RANGES["1h"];

  const dev = await sql`
    SELECT d.id, d.name, d.location, d.lat, d.lng, d.simulated, d.meta, d.state,
           p.claimed_by, p.profile, p.volume, p.muted, p.nickname, p.weights, p.share_token,
           t.version AS target_fw,
           (extract(epoch from d.last_seen) * 1000)::float8 AS last_seen,
           (extract(epoch from d.created_at) * 1000)::float8 AS created
    FROM devices d
    LEFT JOIN pods p ON p.device_id = d.id
    LEFT JOIN pod_firmware_target t ON t.device_id = d.id
    WHERE d.id = ${id}`;
  if (!dev.length) return null;
  const d = dev[0];
  const profile = (d.profile as string) ?? "classroom";

  const ovRows = await sql`SELECT metric, watch_high, bad_high, watch_low, bad_low FROM thresholds_override WHERE pod = ${id}`;
  const customThresholds: Partial<Record<MetricKey, ThresholdOverride>> = {};
  for (const r of ovRows) {
    const k = r.metric as MetricKey;
    if (METRIC_KEYS.includes(k)) {
      customThresholds[k] = {
        watchHigh: num(r.watch_high),
        badHigh: num(r.bad_high),
        watchLow: num(r.watch_low),
        badLow: num(r.bad_low),
      };
    }
  }
  const effectiveConfigs: Record<MetricKey, MetricCfg> = {} as any;
  for (const k of METRIC_KEYS) effectiveConfigs[k] = effectiveMetricCfg(k, profile, customThresholds);

  const series = await sql`
    SELECT (floor(extract(epoch from ts) / ${range.bucketS}::int) * ${range.bucketS}::int * 1000)::float8 AS t,
           avg(dust)::float8 AS dust, avg(air)::float8 AS air, avg(temp)::float8 AS temp, avg(hum)::float8 AS hum
    FROM readings WHERE device_id = ${id} AND ts > ${iso(now - range.ms)}::timestamptz
    GROUP BY 1 ORDER BY 1`;

  // forecasts from the raw last 10 minutes
  const recent = await sql`SELECT (extract(epoch from ts) * 1000)::float8 AS t, dust, air, temp, hum
                           FROM readings WHERE device_id = ${id} AND ts > ${iso(now - 10 * 60_000)}::timestamptz ORDER BY ts`;
  const forecasts: Record<string, unknown> = {};
  const latest: Record<string, number | null> = {};
  for (const k of METRIC_KEYS) {
    const pts: Pt[] = [];
    for (const r of recent) { const v = num(r[k]); if (v !== null) pts.push({ t: Number(r.t), v }); }
    forecasts[k] = forecast(k, pts, HORIZON_MIN, effectiveConfigs[k]);
    latest[k] = pts.length ? pts[pts.length - 1].v : null;
  }
  const lastRow = await sql`SELECT dust, air, temp, hum, (extract(epoch from ts) * 1000)::float8 AS t FROM readings WHERE device_id = ${id} ORDER BY ts DESC LIMIT 1`;
  const lastReadingAt = lastRow.length ? Number(lastRow[0].t) : null;
  if (lastRow.length) {
    for (const k of METRIC_KEYS) {
      if (latest[k] === null && lastRow[0][k] !== null && lastRow[0][k] !== undefined) {
        latest[k] = num(lastRow[0][k]);
      }
    }
  }

  const events = await sql`
    SELECT id, (extract(epoch from ts) * 1000)::float8 AS t, kind, metric, status, severity, message, spoken, spoken_flag, source, outcome, data
    FROM events WHERE device_id = ${id} ORDER BY ts DESC LIMIT 40`;

  const acc = await sql`
    SELECT metric, count(*) AS n,
           avg(abs(predicted - actual))::float8 AS mae_model,
           avg(abs(baseline - actual))::float8 AS mae_base,
           sum(CASE WHEN abs(predicted - actual) <= abs(baseline - actual) THEN 1 ELSE 0 END)::int AS wins
    FROM forecasts WHERE device_id = ${id} AND resolved AND NOT void AND actual IS NOT NULL
      AND target_at > now() - interval '7 days' GROUP BY metric`;
  const totalWins = acc.reduce((a, r) => a + Number(r.wins ?? 0), 0);
  const totalChecks = acc.reduce((a, r) => a + Number(r.n ?? 0), 0);

  const pred = await sql`SELECT outcome, count(*) AS n FROM events
                         WHERE device_id = ${id} AND kind = 'predictive' AND ts > now() - interval '7 days' GROUP BY outcome`;
  const predCounts = { hit: 0, miss: 0, pending: 0 };
  for (const p of pred) {
    if (p.outcome === "hit") predCounts.hit = Number(p.n);
    else if (p.outcome === "miss") predCounts.miss = Number(p.n);
    else predCounts.pending += Number(p.n);
  }

  const hour = await sql`SELECT count(*) AS n, count(flags) AS bad FROM readings
                         WHERE device_id = ${id} AND ts > now() - interval '1 hour'`;

  // 6h series for anomaly detection
  const raw6h = await sql`
    SELECT (floor(extract(epoch from ts) / 90) * 90 * 1000)::float8 AS t,
           avg(dust)::float8 AS dust, avg(air)::float8 AS air, avg(temp)::float8 AS temp, avg(hum)::float8 AS hum
    FROM readings WHERE device_id = ${id} AND ts > ${iso(now - 6 * 3600_000)}::timestamptz
    GROUP BY 1 ORDER BY 1`;
  const anomalies = detectAnomalies(raw6h.map((r) => ({
    t: Number(r.t), dust: num(r.dust), air: num(r.air), temp: num(r.temp), hum: num(r.hum),
  })));

  const summaries = {
    day: await summary(id, now, 24 * 3600_000, Number(d.created)),
    week: await summary(id, now, 7 * 24 * 3600_000, Number(d.created)),
  };

  const lastSeen = num(d.last_seen);
  const online = lastSeen !== null && now - lastSeen < ONLINE_MS;
  const pState = podStateLabel(online, lastSeen, now, !!d.simulated);
  const roomScore = computeRoomScore(latest, d.weights ?? undefined, profile, customThresholds);

  return {
    now,
    device: {
      id: d.id as string,
      name: (d.nickname as string) || (d.name as string),
      location: (d.location as string) ?? null,
      lat: num(d.lat), lng: num(d.lng), simulated: !!d.simulated, meta: d.meta ?? {},
      lastSeen, lastReadingAt, online,
      podState: pState,
      claimedBy: (d.claimed_by as string) ?? null,
      profile,
      volume: Number(d.volume ?? 100),
      muted: !!d.muted,
      weights: d.weights ?? { air: 25, dust: 25, temp: 25, hum: 25 },
      shareToken: (d.share_token as string) ?? null,
      targetFw: (d.target_fw as string) ?? null,
      customThresholds,
      effectiveConfigs,
      status: (d.state?.status ?? {}) as Record<string, string>,
    },
    roomScore,
    anomalies,
    effectiveConfigs,
    podState: {
      ...pState,
      roomProfile: profile,
      volume: Number(d.volume ?? 100),
      mute: !!d.muted,
      scoreWeights: d.weights ?? { air: 25, dust: 25, temp: 25, hum: 25 },
      shareToken: (d.share_token as string) ?? null,
      targetFwVersion: (d.target_fw as string) ?? null,
      claimedBy: (d.claimed_by as string) ?? null,
      claimCode: (d.meta as any)?.claim ?? null,
    },
    range: { key: RANGES[rangeKey] ? rangeKey : "1h", ms: range.ms, label: range.label },
    latest,
    series: series.map((r) => ({ t: Number(r.t), dust: num(r.dust), air: num(r.air), temp: num(r.temp), hum: num(r.hum) })),
    forecasts,
    events: events.map((e) => ({
      id: Number(e.id), t: Number(e.t), kind: e.kind, metric: e.metric, status: e.status, severity: Number(e.severity),
      message: e.message, spoken: e.spoken, spokenFlag: !!e.spoken_flag, source: e.source, outcome: e.outcome,
      action: e.data?.action ?? (e.kind === "recovered" ? "none" : "open_window"),
      tags: e.data?.tags ?? (e.kind === "predictive" ? ["measured", "estimate"] : ["measured"]),
      translatedText: e.data?.translatedText ?? null,
      language: e.data?.language ?? "en-NG",
      machineTranslated: !!e.data?.machineTranslated,
    })),
    accuracy: {
      metrics: acc.map((a) => ({
        metric: a.metric, n: Number(a.n), wins: Number(a.wins ?? 0),
        maeModel: num(a.mae_model), maeBase: num(a.mae_base),
      })),
      totalWins,
      totalChecks,
      predictive: predCounts,
    },
    summaries,
    system: {
      readingsLastHour: Number(hour[0]?.n ?? 0), invalidLastHour: Number(hour[0]?.bad ?? 0),
      fw: (d.meta as any)?.fw ?? null, rssi: (d.meta as any)?.rssi ?? null, uptimeS: (d.meta as any)?.uptimeS ?? null,
      mqReady: (d.meta as any)?.mqReady ?? null,
      mac: (d.meta as any)?.mac ?? null,
      claim: (d.meta as any)?.claim ?? null,
    },
  };
}

async function summary(id: string, now: number, ms: number, createdMs: number) {
  const sql = await db();
  const from = now - ms;
  const stats = await sql`
    SELECT count(*) AS n,
      min(dust)::float8 AS dust_min, avg(dust)::float8 AS dust_avg, max(dust)::float8 AS dust_max,
      min(air)::float8 AS air_min, avg(air)::float8 AS air_avg, max(air)::float8 AS air_max,
      min(temp)::float8 AS temp_min, avg(temp)::float8 AS temp_avg, max(temp)::float8 AS temp_max,
      min(hum)::float8 AS hum_min, avg(hum)::float8 AS hum_avg, max(hum)::float8 AS hum_max,
      (extract(epoch from min(ts)) * 1000)::float8 AS first_t
    FROM readings WHERE device_id = ${id} AND ts > ${iso(from)}::timestamptz`;
  const buckets = await sql`
    SELECT (floor(extract(epoch from ts) / 300))::int AS b,
           avg(dust)::float8 AS dust, avg(air)::float8 AS air, avg(temp)::float8 AS temp, avg(hum)::float8 AS hum
    FROM readings WHERE device_id = ${id} AND ts > ${iso(from)}::timestamptz GROUP BY 1`;
  const ev = await sql`SELECT kind, outcome, count(*) AS n FROM events
                       WHERE device_id = ${id} AND ts > ${iso(from)}::timestamptz GROUP BY kind, outcome`;
  const s = stats[0] ?? {};
  const firstT = Number(s.first_t ?? now);
  const startT = Math.max(from, Math.min(createdMs, firstT));
  const expected = Math.max(1, Math.ceil((now - startT) / 300_000));
  const per: Record<string, unknown> = {};
  for (const k of METRIC_KEYS) {
    let withData = 0, outside = 0;
    for (const b of buckets) {
      const v = num(b[k]);
      if (v === null) continue;
      withData++;
      if (classify(k as MetricKey, v) !== "ok") outside++;
    }
    per[k] = {
      min: num(s[`${k}_min`]), avg: num(s[`${k}_avg`]), max: num(s[`${k}_max`]),
      pctOutside: withData ? (outside / withData) * 100 : null,
    };
  }
  const evCount = (kind: string) => ev.filter((e) => e.kind === kind).reduce((a, e) => a + Number(e.n), 0);
  return {
    readings: Number(s.n ?? 0),
    coveragePct: Math.min(100, (buckets.length / expected) * 100),
    alerts: evCount("alert"), recoveries: evCount("recovered"), predictive: evCount("predictive"),
    metrics: per,
  };
}

export { METRICS };
