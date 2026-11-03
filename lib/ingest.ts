// Ingest pipeline: validate -> store -> evaluate rules -> forecast -> AI voice line -> event.

import { db, iso, type Sql } from "./db.ts";
import {
  METRICS, METRIC_KEYS, AI_CONTEXT_MIN, HORIZON_MIN, classify, effectiveMetricCfg,
  type MetricKey, type Status, type ThresholdOverride, type MetricCfg,
} from "./config.ts";
import { forecast, summarise, type Forecast, type Pt, type Summary } from "./predict.ts";
import { evaluateRules, describeTrigger, emptyState, type DeviceState, type Trigger } from "./rules.ts";
import { validateReading, type RawReading } from "./validate.ts";
import { generateLine, compactContext } from "./ai.ts";
import { sendPushToUser } from "./push.ts";

export interface DeviceInfo {
  id: string;
  name?: string | null;
  location?: string | null;
  lat?: number | null;
  lng?: number | null;
  simulated?: boolean;
  alarm?: boolean;   // the pod itself says it sees possible gas or fumes
  meta?: Record<string, unknown>;
}

export interface IngestResult {
  ok: true;
  accepted: number;
  rejected: number;
  invalidFields: number;
  serverTime: number;
  speak?: { eventId: number; text: string; source: string; action?: string; tags?: string[] };
  events: number[];
  volume?: number;
  mute?: boolean;
  otaVersion?: string;
  otaUrl?: string;
  deviceToken?: string;
  name?: string;
  lim?: (number | null)[];
  sos?: boolean;
  cmd?: "identify" | "calibrate" | "restart";
}

const FRESH_MS = 90_000;

/** Is it inside this pod's quiet hours? Hours are 0-23 in the owner's local time (tzMin = minutes ahead of UTC). */
export function inQuietHours(nowMs: number, start: number | null | undefined, end: number | null | undefined, tzMin: number | null | undefined): boolean {
  if (start === null || start === undefined || end === null || end === undefined || start === end) return false;
  const local = new Date(nowMs + Number(tzMin ?? 60) * 60_000);
  const h = local.getUTCHours() + local.getUTCMinutes() / 60;
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/** Compare dotted versions such as "1.10" and "1.9". Returns >0 when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-_]/), pb = b.split(/[.\-_]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0", y = pb[i] ?? "0";
    const nx = Number(x), ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) { if (nx !== ny) return nx - ny; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

type Row = Record<string, any>;
const num = (x: any): number | null => (x === null || x === undefined ? null : Number(x));

async function loadSeries(sql: Sql, id: string, fromMs: number): Promise<Row[]> {
  return sql`SELECT (extract(epoch from ts) * 1000)::float8 AS t, dust, air, temp, hum
             FROM readings WHERE device_id = ${id} AND ts > ${iso(fromMs)}::timestamptz ORDER BY ts`;
}

function pointsOf(rows: Row[], k: MetricKey): Pt[] {
  const out: Pt[] = [];
  for (const r of rows) {
    const v = num(r[k]);
    if (v !== null) out.push({ t: Number(r.t), v });
  }
  return out;
}

function isQuietHour(nowMs: number, prefs: any): boolean {
  if (!prefs?.quietEnabled) return false;
  const d = new Date(nowMs);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const start = String(prefs.quietStart ?? "22:00");
  const end = String(prefs.quietEnd ?? "06:30");
  if (start <= end) return hhmm >= start && hhmm <= end;
  return hhmm >= start || hhmm <= end;
}

export async function ingest(
  info: DeviceInfo,
  rawReadings: RawReading[],
  opts: { now?: number } = {},
): Promise<IngestResult> {
  const sql = await db();
  const now = opts.now ?? Date.now();
  const id = info.id;

  // 1. device row + ensure pods row exists
  await sql`INSERT INTO devices (id, name, location, lat, lng, simulated, last_seen, meta)
            VALUES (${id}, ${info.name ?? id}, ${info.location ?? null}, ${info.lat ?? null}, ${info.lng ?? null},
                    ${!!info.simulated}, now(), ${JSON.stringify(info.meta ?? {})}::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              name = COALESCE(devices.name, ${info.name ?? id}),
              location = COALESCE(devices.location, ${info.location ?? null}),
              lat = COALESCE(${info.lat ?? null}, devices.lat),
              lng = COALESCE(${info.lng ?? null}, devices.lng),
              last_seen = now(),
              meta = devices.meta || ${JSON.stringify(info.meta ?? {})}::jsonb`;

  await sql`INSERT INTO pods (device_id, nickname) VALUES (${id}, ${info.name ?? id}) ON CONFLICT (device_id) DO NOTHING`;

  // Load pod settings, firmware target, and threshold overrides
  const podRows = await sql`SELECT claimed_by, profile, volume, muted, nickname, device_token, token_delivered, voice_lang, quiet_start, quiet_end, tz_min, cmd, (extract(epoch from cmd_at) * 1000)::float8 AS cmd_ms, (extract(epoch from sos_at) * 1000)::float8 AS sos_ms FROM pods WHERE device_id = ${id}`;
  const podRow = podRows[0] ?? { profile: "classroom", volume: 100, muted: false };
  const profile: string = podRow.profile ?? "classroom";

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
  const configs: Partial<Record<MetricKey, MetricCfg>> = {};
  for (const k of METRIC_KEYS) configs[k] = effectiveMetricCfg(k, profile, customThresholds);

  // Check OTA target
  const otaRows = await sql`
    SELECT f.version, f.url FROM pod_firmware_target t
    JOIN firmware_releases f ON f.version = t.version
    WHERE t.device_id = ${id} LIMIT 1`;
  const reportedFw = (info.meta?.fw as string | undefined) ?? null;
  let otaVersion: string | undefined;
  let otaUrl: string | undefined;
  if (otaRows.length && otaRows[0].version && reportedFw) {
    const target = String(otaRows[0].version);
    const cmp = compareVersions(target, reportedFw);
    if (cmp > 0) {
      otaVersion = target;                 // only ever move a pod forward
      otaUrl = String(otaRows[0].url);
    } else {
      // The pod is already on this version or a newer one (for example it was flashed over USB): drop the stale order.
      await sql`DELETE FROM pod_firmware_target WHERE device_id = ${id}`;
    }
  } else if (otaRows.length && otaRows[0].version && !reportedFw) {
    otaVersion = String(otaRows[0].version);
    otaUrl = String(otaRows[0].url);
  }

  // One-time device token delivery on first upload after claim
  let deviceToken: string | undefined;
  if (podRow.device_token && !podRow.token_delivered) {
    deviceToken = String(podRow.device_token);   // re-sent until the pod authenticates with it (see /api/ingest)
  }

  // 2. validate + store (idempotent: a re-sent batch cannot create duplicates)
  const clean = rawReadings.map(validateReading);
  const usable = clean.filter((c) => METRIC_KEYS.some((k) => c.values[k] !== null));
  const invalidFields = clean.reduce((n, c) => n + c.flags.length, 0);
  if (usable.length) {
    await sql`INSERT INTO readings (device_id, ts, dust, air, temp, hum, flags)
              SELECT ${id}::text, x.ts, x.dust, x.air, x.temp, x.hum, x.flags
              FROM unnest(
                ${usable.map((c) => iso(now - c.ageMs))}::timestamptz[],
                ${usable.map((c) => c.values.dust)}::real[],
                ${usable.map((c) => c.values.air)}::real[],
                ${usable.map((c) => c.values.temp)}::real[],
                ${usable.map((c) => c.values.hum)}::real[],
                ${usable.map((c) => (c.flags.length ? c.flags.join(",") : null))}::text[]
              ) AS x(ts, dust, air, temp, hum, flags)
              ON CONFLICT DO NOTHING`;
  }

  // Settings and commands from the app that the pod applies on this reply
  const podName = String(podRow.nickname ?? "").replace(/[^ -~]/g, "").replace(/["\\]/g, "").trim().slice(0, 31);
  // pod order: dust, air, temp, hum; each as watchHigh, badHigh, watchLow, badLow (null = no such limit)
  const lim: (number | null)[] = [];
  for (const k of ["dust", "air", "temp", "hum"] as MetricKey[]) {
    const c = configs[k]!;
    lim.push(c.watchHigh ?? null, c.badHigh ?? null, c.watchLow ?? null, c.badLow ?? null);
  }
  let sos = false;
  if (podRow.sos_ms) {
    sos = now - Number(podRow.sos_ms) < 2 * 60_000;   // a stale SOS must not sound minutes later
    await sql`UPDATE pods SET sos_at = NULL WHERE device_id = ${id}`;
  }

  let cmd: IngestResult["cmd"];
  if (podRow.cmd) {
    if (podRow.cmd_ms && now - Number(podRow.cmd_ms) < 3 * 60_000 && ["identify", "calibrate", "restart"].includes(String(podRow.cmd))) cmd = String(podRow.cmd) as IngestResult["cmd"];
    await sql`UPDATE pods SET cmd = NULL, cmd_at = NULL WHERE device_id = ${id}`;
  }
  // Quiet hours silence the pod's voice the same way the mute switch does. SOS still sounds.
  const effMuted = !!podRow.muted || inQuietHours(now, podRow.quiet_start as number | null, podRow.quiet_end as number | null, podRow.tz_min as number | null);

  const result: IngestResult = {
    ok: true, accepted: usable.length, rejected: clean.length - usable.length, invalidFields,
    serverTime: now, events: [],
    volume: Number(podRow.volume ?? 100),
    mute: effMuted,
    ...(podRow.claimed_by && podName ? { name: podName } : {}),
    lim,
    ...(sos ? { sos: true } : {}),
    ...(cmd ? { cmd } : {}),
    ...(otaVersion && otaUrl ? { otaVersion, otaUrl } : {}),
    ...(deviceToken ? { deviceToken } : {}),
  };
  if (!usable.length) return result;

  // 3. current state of the world: last 10 minutes of data
  const rows = await loadSeries(sql, id, now - 10 * 60_000);
  const series = {} as Record<MetricKey, Pt[]>;
  for (const k of METRIC_KEYS) series[k] = pointsOf(rows, k);

  const values: Partial<Record<MetricKey, number>> = {};
  for (const k of METRIC_KEYS) {
    const last = series[k][series[k].length - 1];
    if (last && now - last.t <= FRESH_MS) values[k] = last.v;
  }
  const forecasts: Partial<Record<MetricKey, Forecast>> = {};
  for (const k of METRIC_KEYS) forecasts[k] = forecast(k, series[k], HORIZON_MIN, configs[k]);

  const st = await sql`SELECT state, name FROM devices WHERE id = ${id}`;
  const prev: DeviceState = { ...emptyState(), ...(st[0]?.state ?? {}) };
  const { next, triggers } = evaluateRules({ now, values, prev, forecasts, configs });

  // 4. one voice line per cycle (the most important trigger); the rest are logged silently
  if (triggers.length) {
    const ctxSeries = {} as Record<MetricKey, Pt[]>;
    const summaries: Partial<Record<MetricKey, Summary>> = {};
    for (const k of METRIC_KEYS) {
      ctxSeries[k] = series[k].filter((p) => now - p.t <= AI_CONTEXT_MIN * 60_000);
      const s = summarise(ctxSeries[k]);
      if (s) summaries[k] = s;
    }
    const statuses = next.status as Partial<Record<MetricKey, Status>>;
    const devName = podRow.nickname || st[0]?.name || id;

    // Check owner's language & notification prefs
    let userLang = "en-NG";
    let userPrefs: any = {};
    if (podRow.claimed_by) {
      const uRows = await sql`SELECT prefs FROM users WHERE id = ${podRow.claimed_by}`;
      if (uRows.length) {
        userPrefs = uRows[0].prefs ?? {};
        if (userPrefs.language) userLang = String(userPrefs.language);
      }
    }
    if (podRow.voice_lang) userLang = String(podRow.voice_lang);   // a language chosen for this pod wins

    for (let i = 0; i < triggers.length; i++) {
      const t = triggers[i];
      const speak = i === 0;
      let spoken: string | null = null;
      let source: string | null = null;
      let aiError: string | undefined;
      let action = "none";
      let tags: string[] = t.kind === "predictive" ? ["measured", "estimate"] : ["measured"];
      let translatedText: string | undefined;
      let machineTranslated = false;

      if (speak) {
        const aiCtx = { deviceName: devName, trigger: t, summaries, statuses, forecasts, profile, language: userLang };
        const line = await generateLine(aiCtx);
        spoken = line.text;
        source = line.source;
        aiError = line.error;
        action = line.action;
        tags = line.tags;
        translatedText = line.translatedText;
        machineTranslated = !!line.machineTranslated;

        await sql`INSERT INTO ai_logs (device_id, kind, inputs, output, source)
                  VALUES (${id}, ${t.kind}, ${JSON.stringify(compactContext(aiCtx))}::jsonb,
                          ${JSON.stringify({ text: spoken, action, tags, translatedText, error: aiError })}::jsonb,
                          ${source})`;
      }
      const data = {
        value: t.value, prevStatus: t.prevStatus, crossing: t.crossing ?? null,
        last2min: summaries, forecast: forecasts[t.metric] ?? null, aiError: aiError ?? null,
        action, tags, translatedText: translatedText ?? null, language: userLang, machineTranslated, profile,
        // What the pod actually says out loud: the chosen language when we have it, otherwise English.
        spokenText: userLang !== "en-NG" && translatedText ? translatedText : null,
      };
      const sev = t.kind === "alert" ? (t.status.startsWith("bad") ? 2 : 1) : 0;
      const ins = await sql`INSERT INTO events (device_id, ts, kind, metric, status, severity, message, spoken, spoken_flag, source, data)
                 VALUES (${id}, ${iso(now)}::timestamptz, ${t.kind}, ${t.metric}, ${t.status}, ${sev},
                         ${describeTrigger(t)}, ${spoken}, ${speak}, ${source}, ${JSON.stringify(data)}::jsonb)
                 RETURNING id`;
      const eventId = Number(ins[0].id);
      result.events.push(eventId);
      if (speak && spoken && !effMuted) {
        result.speak = { eventId, text: spoken, source: source ?? "template", action, tags };
      }

      // Gas alarms ALWAYS bypass quiet hours!
      const isGasAlarm = (t.metric === "air" && t.status === "bad-low") || (t.metric === "dust" && t.status === "bad-high");
      const metricEnabled = userPrefs?.metrics?.[t.metric] !== false;
      const canNotify = isGasAlarm || (speak && metricEnabled && !isQuietHour(now, userPrefs));

      if (canNotify) {
        const title = `${devName}: ${isGasAlarm ? "🚨 Gas / Severe Air Alert" : t.kind === "recovered" ? "Back to normal" : t.kind === "predictive" ? "Early warning" : "Room alert"}`;
        const body = spoken ?? describeTrigger(t);
        await sql`INSERT INTO notifications_log (user_id, device_id, event_id, channel, title, body)
                  VALUES (${podRow.claimed_by ?? null}, ${id}, ${eventId}, 'web_push', ${title}, ${body})`;

        {
          await sendPushToUser({
            userId: podRow.claimed_by ?? null,
            title,
            body,
            tag: `pod-${id}`,
            isGasAlarm,
            data: { url: "/dashboard" },
          }).catch(() => {});
        }
      }
    }
  }

  // The pod's own fast gas/fumes alarm: logged once per 2 minutes and always pushed to the phone, even in quiet hours.
  if (info.alarm) {
    const recent = await sql`SELECT id FROM events WHERE device_id = ${id} AND data->>'alarm' = 'gas' AND ts > ${iso(now - 120_000)}::timestamptz LIMIT 1`;
    if (!recent.length) {
      const alarmName = podRow.nickname || info.name || id;
      const msg = "Possible gas or fumes detected. Open the windows, put out any flame and leave the room if you smell gas.";
      const ins = await sql`INSERT INTO events (device_id, ts, kind, metric, status, severity, message, spoken, spoken_flag, source, data)
                 VALUES (${id}, ${iso(now)}::timestamptz, 'alert', 'air', 'bad-low', 2, ${msg}, ${null}, false, 'pod-alarm',
                         ${JSON.stringify({ alarm: "gas", tags: ["measured"], action: "open_window", value: values.air ?? null })}::jsonb)
                 RETURNING id`;
      const eventId = Number(ins[0].id);
      result.events.push(eventId);
      const title = `${alarmName}: 🚨 Possible gas or fumes`;
      await sql`INSERT INTO notifications_log (user_id, device_id, event_id, channel, title, body)
                VALUES (${podRow.claimed_by ?? null}, ${id}, ${eventId}, 'web_push', ${title}, ${msg})`;
      await sendPushToUser({ userId: podRow.claimed_by ?? null, title, body: msg, tag: `gas-${id}`, isGasAlarm: true, data: { url: "/dashboard" } }).catch(() => {});
    }
  }

  await sql`UPDATE devices SET state = ${JSON.stringify(next)}::jsonb WHERE id = ${id}`;

  // 5. record forecasts for later scoring, and score the ones that are now due
  await recordForecasts(sql, id, now, forecasts, values);
  await scoreForecasts(sql, id, now);
  await scorePredictiveEvents(sql, id, now);

  return result;
}

async function recordForecasts(
  sql: Sql, id: string, now: number,
  forecasts: Partial<Record<MetricKey, Forecast>>, values: Partial<Record<MetricKey, number>>,
) {
  const last = await sql`SELECT (extract(epoch from max(made_at)) * 1000)::float8 AS t FROM forecasts WHERE device_id = ${id}`;
  const lastMade = Number(last[0]?.t ?? 0);
  if (now - lastMade < 5 * 60_000) return;
  for (const k of METRIC_KEYS) {
    const f = forecasts[k];
    const cur = values[k];
    if (!f || !f.ok || cur === undefined) continue;
    await sql`INSERT INTO forecasts (device_id, metric, made_at, target_at, predicted, baseline, confidence, trend)
              VALUES (${id}, ${k}, ${iso(now)}::timestamptz, ${iso(now + HORIZON_MIN * 60_000)}::timestamptz,
                      ${f.predicted}, ${cur}, ${f.confidence}, ${f.trend})`;
  }
}

async function scoreForecasts(sql: Sql, id: string, now: number) {
  const due = await sql`SELECT id, metric, (extract(epoch from target_at) * 1000)::float8 AS t
                        FROM forecasts WHERE device_id = ${id} AND NOT resolved AND target_at <= ${iso(now)}::timestamptz
                        ORDER BY target_at LIMIT 50`;
  for (const f of due) {
    const target = Number(f.t);
    const near = await sql`SELECT dust, air, temp, hum, (extract(epoch from ts) * 1000)::float8 AS t FROM readings
                           WHERE device_id = ${id}
                             AND ts BETWEEN ${iso(target - 90_000)}::timestamptz AND ${iso(target + 90_000)}::timestamptz`;
    let best: number | null = null, bestD = Infinity;
    for (const r of near) {
      const v = num(r[f.metric]);
      if (v === null) continue;
      const d = Math.abs(Number(r.t) - target);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best !== null) {
      await sql`UPDATE forecasts SET actual = ${best}, resolved = true WHERE id = ${f.id}`;
    } else if (now - target > 30 * 60_000) {
      await sql`UPDATE forecasts SET resolved = true, void = true WHERE id = ${f.id}`; // device was offline
    }
  }
}

/** A predictive warning is a "hit" if the metric really reached the threshold within 15 minutes, else a false alarm. */
async function scorePredictiveEvents(sql: Sql, id: string, now: number) {
  const open = await sql`SELECT id, metric, data, (extract(epoch from ts) * 1000)::float8 AS t
                         FROM events WHERE device_id = ${id} AND kind = 'predictive' AND outcome IS NULL
                           AND ts <= ${iso(now - 15 * 60_000)}::timestamptz LIMIT 20`;
  for (const e of open) {
    const c = e.data?.crossing;
    if (!c) { await sql`UPDATE events SET outcome = 'miss' WHERE id = ${e.id}`; continue; }
    const rows = await sql`SELECT dust, air, temp, hum FROM readings WHERE device_id = ${id}
                           AND ts > ${iso(Number(e.t))}::timestamptz AND ts <= ${iso(Number(e.t) + 15 * 60_000)}::timestamptz`;
    const hit = rows.some((r) => {
      const v = num(r[e.metric]);
      return v !== null && (c.side === "high" ? v >= c.threshold : v <= c.threshold);
    });
    await sql`UPDATE events SET outcome = ${hit ? "hit" : "miss"} WHERE id = ${e.id}`;
  }
}

export { classify };
