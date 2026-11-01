// Demo / pitch helpers. Everything created here is flagged `simulated` and labelled as such in the UI.
// The demo node pushes synthetic readings through the SAME ingest pipeline a real device uses.

import { db, iso } from "./db.ts";
import { ingest, type IngestResult } from "./ingest.ts";
import { METRIC_KEYS, type MetricKey } from "./config.ts";

export const DEMO_ID = "demo-node";
const BASE: Record<MetricKey, number> = { air: 90, dust: 8, temp: 27.5, hum: 46 };
const STEP_S = 5;
const SEG_DEFAULT_S = 100;
const SEG_WARNING_S = 240; // a longer, steady slide so the trend fit can see it

export type Scenario = "normal" | "dry" | "warning" | "dusty" | "stuffy" | "recover" | "reset";

const TARGETS: Record<Exclude<Scenario, "reset">, Partial<Record<MetricKey, number>>> = {
  normal: {},
  dry: { hum: 24 },
  warning: { hum: 35 }, // a steady slide that has not crossed yet: shows the early-warning path
  dusty: { dust: 74 },
  stuffy: { air: 36, hum: 70 },
  recover: { ...BASE },
};

// deterministic wobble so charts look like real sensors, not straight lines
const wob = (i: number, k: number, amp: number) => Math.sin(i * 1.7 + k * 3.1) * amp + Math.sin(i * 0.37 + k) * amp * 0.6;
const AMP: Record<MetricKey, number> = { air: 0.8, dust: 1.2, temp: 0.08, hum: 0.35 };

export async function runScenario(s: Scenario): Promise<{ message: string; result?: IngestResult }> {
  const sql = await db();
  const now = Date.now();

  if (s === "reset") {
    await sql`DELETE FROM readings WHERE device_id = ${DEMO_ID}`;
    await sql`DELETE FROM events WHERE device_id = ${DEMO_ID}`;
    await sql`DELETE FROM forecasts WHERE device_id = ${DEMO_ID}`;
    await sql`DELETE FROM devices WHERE id = ${DEMO_ID}`;
    return { message: "Demo node cleared." };
  }

  // Each scenario continues from where the last data ended. A scenario clicked soon after another
  // only covers the time since then (min 15 s), so earlier segments are never overwritten.
  const lastAny = await sql`SELECT dust, air, temp, hum, (extract(epoch from ts) * 1000)::float8 AS t FROM readings
                            WHERE device_id = ${DEMO_ID} ORDER BY ts DESC LIMIT 1`;
  let SEG_S = SEG_DEFAULT_S;
  let fromRow: Record<string, any> | undefined = lastAny[0];
  if (s === "warning") {
    // a longer, steady slide so the trend fit can see it; it replaces the last 4 minutes
    SEG_S = SEG_WARNING_S;
    const before = await sql`SELECT dust, air, temp, hum FROM readings
                             WHERE device_id = ${DEMO_ID} AND ts < ${iso(now - SEG_S * 1000)}::timestamptz ORDER BY ts DESC LIMIT 1`;
    fromRow = before[0];
  } else if (lastAny.length) {
    const gapS = (now - Number(lastAny[0].t)) / 1000;
    SEG_S = Math.min(SEG_DEFAULT_S, Math.max(15, Math.round(gapS / STEP_S) * STEP_S));
  }
  const from = {} as Record<MetricKey, number>;
  for (const k of METRIC_KEYS) from[k] = fromRow && fromRow[k] !== null && fromRow[k] !== undefined ? Number(fromRow[k]) : BASE[k];

  const recent = await sql`SELECT count(*) AS n FROM readings WHERE device_id = ${DEMO_ID}
                           AND ts BETWEEN ${iso(now - 6 * 60_000)}::timestamptz AND ${iso(now - SEG_S * 1000)}::timestamptz`;
  const needBackfill = Number(recent[0]?.n ?? 0) < 36;

  const target = { ...from, ...TARGETS[s as Exclude<Scenario, "reset">] } as Record<MetricKey, number>;
  if (s === "normal") for (const k of METRIC_KEYS) target[k] = from[k];

  // replace anything in the segment window so repeated clicks do not interleave
  await sql`DELETE FROM readings WHERE device_id = ${DEMO_ID} AND ts >= ${iso(now - SEG_S * 1000)}::timestamptz`;

  const readings: Record<string, number>[] = [];
  if (needBackfill) {
    // 5 minutes of calm baseline before the segment so the trend fit has history
    for (let age = (6 * 60 + SEG_S); age > SEG_S; age -= STEP_S) {
      const i = age / STEP_S;
      const r: Record<string, number> = { ageMs: age * 1000 };
      for (const k of METRIC_KEYS) r[k] = +(from[k] + wob(i, METRIC_KEYS.indexOf(k), AMP[k])).toFixed(2);
      readings.push(r);
    }
  }
  const n = SEG_S / STEP_S;
  for (let j = 0; j < n; j++) {
    const age = (n - 1 - j) * STEP_S;
    const frac = (j + 1) / n;
    const r: Record<string, number> = { ageMs: age * 1000 };
    for (const k of METRIC_KEYS) {
      r[k] = +(from[k] + (target[k] - from[k]) * frac + wob(j, METRIC_KEYS.indexOf(k), AMP[k])).toFixed(2);
    }
    readings.push(r);
  }

  const result = await ingest(
    { id: DEMO_ID, name: "Demo node (simulated)", location: "FUTO Pitch Demo", simulated: true, meta: { fw: "1.1", claim: "DEMO26", mac: "AA:BB:CC:DE:M0:26", rssi: -54, mqReady: true, uptimeS: 1420 } },
    readings, { now },
  );
  return { message: `Scenario "${s}" sent through the live pipeline.`, result };
}

const CITIES = [
  { id: "sim-lagos", name: "Lagos classroom", location: "Lagos, Nigeria", lat: 6.52, lng: 3.38, hum: 72, temp: 30, dust: 30, air: 66, claim: "LAGS26" },
  { id: "sim-nairobi", name: "Nairobi lab", location: "Nairobi, Kenya", lat: -1.29, lng: 36.82, hum: 52, temp: 22, dust: 14, air: 88, claim: "NAIR26" },
  { id: "sim-accra", name: "Accra school", location: "Accra, Ghana", lat: 5.6, lng: -0.19, hum: 66, temp: 29, dust: 22, air: 78, claim: "ACCR26" },
  { id: "sim-delhi", name: "Delhi office", location: "Delhi, India", lat: 28.61, lng: 77.21, hum: 38, temp: 31, dust: 58, air: 52, claim: "DELH26" },
];

/** Fills the network view with a day of plausible history for a few simulated nodes. */
export async function seedGlobal(): Promise<string> {
  const sql = await db();
  const now = Date.now();
  for (const c of CITIES) {
    const ts: string[] = [], dust: number[] = [], air: number[] = [], temp: number[] = [], hum: number[] = [];
    for (let age = 24 * 3600; age >= 0; age -= 300) {
      const t = now - age * 1000;
      const hour = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
      const day = Math.sin(((hour - 8) / 24) * 2 * Math.PI); // warmer / busier in the afternoon
      const i = age / 300;
      ts.push(iso(t));
      temp.push(+(c.temp + day * 3 + wob(i, 1, 0.2)).toFixed(2));
      hum.push(+(Math.min(95, Math.max(8, c.hum - day * 8 + wob(i, 2, 1))).toFixed(2)));
      dust.push(+(Math.min(100, Math.max(0, c.dust + (day > 0 ? day * 10 : 0) + wob(i, 3, 2))).toFixed(2)));
      air.push(+(Math.min(100, Math.max(0, c.air - (day > 0 ? day * 6 : 0) + wob(i, 4, 1.5))).toFixed(2)));
    }
    const metaJson = JSON.stringify({ fw: "1.1", claim: c.claim, mac: `AA:BB:CC:00:00:${c.claim.slice(0, 2)}`, rssi: -58, mqReady: true });
    await sql`INSERT INTO devices (id, name, location, lat, lng, simulated, last_seen, meta)
              VALUES (${c.id}, ${c.name}, ${c.location}, ${c.lat}, ${c.lng}, true, now(), ${metaJson}::jsonb)
              ON CONFLICT (id) DO UPDATE SET last_seen = now(), simulated = true, meta = devices.meta || ${metaJson}::jsonb`;
    await sql`DELETE FROM readings WHERE device_id = ${c.id}`;
    await sql`INSERT INTO readings (device_id, ts, dust, air, temp, hum)
              SELECT ${c.id}::text, x.ts, x.dust, x.air, x.temp, x.hum
              FROM unnest(${ts}::timestamptz[], ${dust}::real[], ${air}::real[], ${temp}::real[], ${hum}::real[])
                AS x(ts, dust, air, temp, hum)`;

    // Seed resolved forecast comparisons so the early-warning scoreboard is populated
    const f = await sql`SELECT count(*)::int AS n FROM forecasts WHERE device_id = ${c.id} AND actual IS NOT NULL`;
    if (Number(f[0]?.n ?? 0) < 4) {
      const sampleSamples = [
        { m: "dust", pred: c.dust + 8.2, base: c.dust + 1.0, act: c.dust + 7.6, trend: "rising", ageMin: 45 },
        { m: "hum", pred: c.hum - 5.4, base: c.hum - 0.5, act: c.hum - 4.9, trend: "falling", ageMin: 90 },
        { m: "air", pred: c.air - 6.8, base: c.air - 1.2, act: c.air - 6.1, trend: "falling", ageMin: 135 },
        { m: "temp", pred: c.temp + 1.4, base: c.temp + 0.2, act: c.temp + 1.3, trend: "rising", ageMin: 180 },
      ];
      for (const s of sampleSamples) {
        const cTs = iso(now - s.ageMin * 60_000);
        const tTs = iso(now - (s.ageMin - 15) * 60_000);
        await sql`INSERT INTO forecasts (device_id, metric, made_at, target_at, predicted, baseline, actual, confidence, trend, resolved, void)
                  VALUES (${c.id}, ${s.m}, ${cTs}::timestamptz, ${tTs}::timestamptz, ${s.pred}, ${s.base}, ${s.act}, 'high', ${s.trend}, true, false)`;
      }
    }
  }
  return `Seeded ${CITIES.length} simulated nodes with 24 hours of history.`;
}
