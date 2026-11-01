// Pod management: claim by 6-char pair code, unclaim, rename, room profile, volume, mute,
// custom thresholds, OTA firmware targets, and Anomaly + Pattern detection.

import { randomBytes } from "node:crypto";
import { db, iso } from "./db.ts";
import {
  METRIC_KEYS, METRICS, effectiveMetricCfg, fmt,
  type MetricKey, type ThresholdOverride,
} from "./config.ts";
import { generateInsightText, type InsightStats } from "./ai.ts";

const num = (x: any): number | null => (x === null || x === undefined ? null : Number(x));

export const DEFAULT_USER = {
  id: "owner-shamaryah",
  email: "shamaryah@futo.edu.ng",
  name: "Shamaryah (FUTO)",
};

export async function ensureDefaultUser(userId = DEFAULT_USER.id, email = DEFAULT_USER.email, name = DEFAULT_USER.name) {
  const sql = await db();
  await sql`
    INSERT INTO users (id, email, name, role, prefs)
    VALUES (${userId}, ${email}, ${name}, 'owner', '{"language":"en-NG","voice":"Kore","speed":1.0,"quietEnabled":false,"quietStart":"22:00","quietEnd":"06:30","metrics":{"air":true,"dust":true,"temp":true,"hum":true}}'::jsonb)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
  `;
  const rows = await sql`SELECT id, email, name, role, prefs, (extract(epoch from created_at) * 1000)::float8 AS created_at FROM users WHERE id = ${userId}`;
  return rows[0];
}

export async function signInOrCreateUser(email: string, name: string) {
  const sql = await db();
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name.trim() || cleanEmail.split("@")[0];
  const id = cleanEmail === DEFAULT_USER.email ? DEFAULT_USER.id : "usr-" + Buffer.from(cleanEmail).toString("hex").slice(0, 16);
  await sql`
    INSERT INTO users (id, email, name, role, prefs)
    VALUES (${id}, ${cleanEmail}, ${cleanName}, 'owner', '{"language":"en-NG","voice":"Kore","speed":1.0,"quietEnabled":false,"quietStart":"22:00","quietEnd":"06:30","metrics":{"air":true,"dust":true,"temp":true,"hum":true}}'::jsonb)
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
  `;
  const rows = await sql`SELECT id, email, name, role, prefs FROM users WHERE email = ${cleanEmail}`;
  return rows[0];
}

/** Remember that a pod knocked on the door, even when it was turned away (so pairing can explain why). */
export async function noteContact(deviceId: string, claim: string | null, result: "ok" | "bad-key", fw: string | null) {
  try {
    const sql = await db();
    await sql`
      INSERT INTO pod_contact (device_id, claim, result, fw, last_at)
      VALUES (${deviceId}, ${claim ? claim.toUpperCase() : null}, ${result}, ${fw}, now())
      ON CONFLICT (device_id) DO UPDATE SET claim = COALESCE(EXCLUDED.claim, pod_contact.claim), result = EXCLUDED.result,
        fw = COALESCE(EXCLUDED.fw, pod_contact.fw), last_at = now()`;
  } catch { /* diagnostics only */ }
}

/**
 * Authenticate a pod check-in against its private device_token (once delivered) or the shared DEVICE_KEY.
 * Records every contact (ok or bad-key) in pod_contact.
 */
export async function verifyPodIngestKey(args: {
  deviceId: string;
  providedKey: string;
  claim: string | null;
  fw: string | null;
}): Promise<{ authorized: boolean; status?: number; error?: string }> {
  const { deviceId, providedKey, claim, fw } = args;
  const expected = process.env.DEVICE_KEY || "evk_6450a3caa5e01e24638ef4e6";
  let authorized = false;
  try {
    const sql = await db();
    const rows = await sql`SELECT device_token, token_delivered FROM pods WHERE device_id = ${deviceId}`;
    const tok = rows.length ? (rows[0].device_token as string | null) : null;
    if (tok && providedKey === tok) {
      authorized = true;
      if (!rows[0].token_delivered) {
        await sql`UPDATE pods SET token_delivered = true WHERE device_id = ${deviceId}`;
      }
    } else if (!!expected && providedKey === expected) {
      // The shared key only works until the pod has confirmed its own private token.
      authorized = !(tok && rows[0].token_delivered);
    }
  } catch {
    authorized = !!expected && providedKey === expected;
  }
  if (!authorized) {
    await noteContact(deviceId, claim, "bad-key", fw);
    if (!expected) {
      return { authorized: false, status: 500, error: "DEVICE_KEY is not configured on the server" };
    }
    return { authorized: false, status: 401, error: "Bad device key" };
  }
  await noteContact(deviceId, claim, "ok", fw);
  return { authorized: true };
}

export interface ClaimResult {
  ok: boolean;
  locked?: boolean;
  error?: string;
  deviceId?: string;
  podId?: string;
  name?: string;
  deviceToken?: string;
  latest?: Record<string, number | null> | null;
}

/**
 * Claim a pod by its 6-character pair code (section 3.1 & section 9 rate-limiting).
 * Locks attempts after 5 wrong tries from one user for 10 minutes.
 */
export async function claimPodByCode(args: {
  code: string;
  userId?: string;
  nickname?: string;
  roomName?: string;
  roomType?: string;
  roomProfile?: string;
  location?: string;
}): Promise<ClaimResult> {
  const sql = await db();
  const userId = args.userId || DEFAULT_USER.id;
  await ensureDefaultUser(userId, `${userId}@ecovital.local`, userId);

  const code = args.code.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return { ok: false, error: "Pair code must be 6 alphanumeric characters." };
  }

  // Check rate-limit lockout (5 wrong tries from this user)
  const lockRows = await sql`
    SELECT fails, (extract(epoch from locked_until) * 1000)::float8 AS locked_until
    FROM claim_attempts WHERE user_id = ${userId} AND code = '__global__'`;
  const now = Date.now();
  if (lockRows.length && lockRows[0].locked_until && Number(lockRows[0].locked_until) > now) {
    const mins = Math.ceil((Number(lockRows[0].locked_until) - now) / 60_000);
    return {
      ok: false,
      locked: true,
      error: `Too many wrong pair code attempts. Please wait ${mins} minute${mins === 1 ? "" : "s"} and try again.`,
    };
  }

  // Find device whose meta->>'claim' matches code
  const devRows = await sql`
    SELECT d.id, d.name, d.location, d.meta, p.claimed_by
    FROM devices d
    LEFT JOIN pods p ON p.device_id = d.id
    WHERE upper(d.meta->>'claim') = ${code}
    ORDER BY d.last_seen DESC NULLS LAST LIMIT 1`;

  if (!devRows.length) {
    // Did a pod with this code reach the server but get turned away? Then say exactly that.
    const seen = await sql`SELECT device_id, result, (extract(epoch from last_at) * 1000)::float8 AS t FROM pod_contact
                           WHERE upper(claim) = ${code} ORDER BY last_at DESC LIMIT 1`;
    if (seen.length && seen[0].result === "bad-key") {
      return {
        ok: false,
        error: `This pod (${seen[0].device_id}) is reaching the server, but the server rejected its key. Set DEVICE_KEY on Vercel to the key inside the pod firmware (DEFAULT_KEY), redeploy, or enter that key on the pod's own Settings page. Then try again.`,
      };
    }
    const curFails = Number(lockRows[0]?.fails ?? 0) + 1;
    const lockUntil = curFails >= 5 ? iso(now + 10 * 60_000) : null;
    await sql`
      INSERT INTO claim_attempts (user_id, code, fails, locked_until)
      VALUES (${userId}, '__global__', ${curFails}, ${lockUntil}::timestamptz)
      ON CONFLICT (user_id, code) DO UPDATE SET fails = ${curFails}, locked_until = ${lockUntil}::timestamptz`;
    return {
      ok: false,
      locked: curFails >= 5,
      error: "We have not heard from a pod with that code yet. Check that the pod shows its Wi-Fi bars in green (top right of its screen) and that its app address is this site, then try again in 15 seconds. The code is the 6 characters on the pod, not its ID.",
    };
  }

  const dev = devRows[0];
  if (dev.claimed_by && dev.claimed_by !== userId) {
    return { ok: false, error: "This pod is already claimed by another account. Ask the owner to remove it first." };
  }

  // Reset failed attempt counter on success
  await sql`DELETE FROM claim_attempts WHERE user_id = ${userId} AND code = '__global__'`;

  const deviceId = dev.id as string;
  const nickname = args.nickname?.trim() || (dev.name as string) || deviceId;
  const reqProf = args.roomProfile || args.roomType;
  const profile = reqProf && ["classroom", "bedroom", "nursery", "lab", "office", "asthma"].includes(reqProf)
    ? reqProf
    : "classroom";

  let roomId: string | null = null;
  if (args.roomName?.trim()) {
    roomId = "room-" + randomBytes(4).toString("hex");
    await sql`INSERT INTO rooms (id, owner_id, name, type) VALUES (${roomId}, ${userId}, ${args.roomName.trim()}, ${profile})`;
  }

  const deviceToken = "evtok_" + randomBytes(16).toString("hex");
  const shareToken = "share_" + randomBytes(10).toString("hex");

  await sql`
    INSERT INTO pods (device_id, claimed_by, claimed_at, room_id, profile, nickname, device_token, token_delivered, share_token)
    VALUES (${deviceId}, ${userId}, now(), ${roomId}, ${profile}, ${nickname}, ${deviceToken}, false, ${shareToken})
    ON CONFLICT (device_id) DO UPDATE SET
      claimed_by = ${userId},
      claimed_at = now(),
      room_id = COALESCE(${roomId}, pods.room_id),
      profile = ${profile},
      nickname = ${nickname},
      device_token = ${deviceToken},
      token_delivered = false,
      share_token = COALESCE(pods.share_token, ${shareToken})
  `;

  if (args.nickname?.trim() || args.location?.trim()) {
    await sql`
      UPDATE devices SET
        name = COALESCE(${args.nickname?.trim() || null}, name),
        location = COALESCE(${args.location?.trim() || null}, location)
      WHERE id = ${deviceId}
    `;
  }

  const latestRow = await sql`
    SELECT dust, air, temp, hum, (extract(epoch from ts) * 1000)::float8 AS t
    FROM readings WHERE device_id = ${deviceId} ORDER BY ts DESC LIMIT 1`;

  return {
    ok: true,
    deviceId,
    podId: deviceId,
    name: nickname,
    deviceToken,
    latest: latestRow.length ? {
      t: Number(latestRow[0].t),
      dust: num(latestRow[0].dust),
      air: num(latestRow[0].air),
      temp: num(latestRow[0].temp),
      hum: num(latestRow[0].hum),
    } : null,
  };
}

export async function unclaimPod(deviceId: string, userId = DEFAULT_USER.id) {
  const sql = await db();
  await sql`
    UPDATE pods SET
      claimed_by = NULL,
      claimed_at = NULL,
      device_token = NULL,
      token_delivered = false
    WHERE device_id = ${deviceId}
  `;
  return { ok: true, deviceId };
}

export async function updatePodSettings(
  deviceId: string,
  patch: {
    name?: string;
    nickname?: string;
    location?: string;
    profile?: string;
    roomProfile?: string;
    volume?: number;
    muted?: boolean;
    mute?: boolean;
    weights?: Partial<Record<MetricKey, number>>;
    scoreWeights?: Partial<Record<MetricKey, number>>;
    thresholds?: Partial<Record<MetricKey, ThresholdOverride>>;
    customThresholds?: Partial<Record<MetricKey, any>>;
    resetThresholds?: boolean;
  },
) {
  const sql = await db();
  await sql`INSERT INTO pods (device_id) VALUES (${deviceId}) ON CONFLICT (device_id) DO NOTHING`;

  const effName = patch.name ?? patch.nickname;
  const effProfile = patch.profile ?? patch.roomProfile;
  const effMuted = patch.muted !== undefined ? patch.muted : patch.mute;
  const effWeights = patch.weights ?? patch.scoreWeights;
  const effThresholds = patch.thresholds ?? patch.customThresholds;

  if (effName !== undefined || patch.location !== undefined) {
    await sql`
      UPDATE devices SET
        name = COALESCE(${effName?.trim() || null}, name),
        location = COALESCE(${patch.location?.trim() || null}, location)
      WHERE id = ${deviceId}
    `;
  }
  if (effName !== undefined) {
    await sql`UPDATE pods SET nickname = ${effName.trim()} WHERE device_id = ${deviceId}`;
  }
  if (effProfile !== undefined) {
    await sql`UPDATE pods SET profile = ${effProfile} WHERE device_id = ${deviceId}`;
  }
  if (patch.volume !== undefined) {
    const v = Math.max(0, Math.min(100, Math.round(Number(patch.volume))));
    await sql`UPDATE pods SET volume = ${v} WHERE device_id = ${deviceId}`;
  }
  if (effMuted !== undefined) {
    await sql`UPDATE pods SET muted = ${!!effMuted} WHERE device_id = ${deviceId}`;
  }
  if (effWeights !== undefined) {
    await sql`UPDATE pods SET weights = ${JSON.stringify(effWeights)}::jsonb WHERE device_id = ${deviceId}`;
  }
  if (patch.resetThresholds) {
    await sql`DELETE FROM thresholds_override WHERE pod = ${deviceId}`;
  } else if (effThresholds) {
    for (const k of METRIC_KEYS) {
      const ov = effThresholds[k];
      if (!ov) continue;
      const wHigh = ov.watchHigh ?? (ov.direction === "above" ? ov.watch : undefined) ?? null;
      const bHigh = ov.badHigh ?? (ov.direction === "above" ? ov.bad : undefined) ?? null;
      const wLow = ov.watchLow ?? (ov.direction === "below" ? ov.watch : undefined) ?? null;
      const bLow = ov.badLow ?? (ov.direction === "below" ? ov.bad : undefined) ?? null;
      await sql`
        INSERT INTO thresholds_override (pod, metric, watch_high, bad_high, watch_low, bad_low)
        VALUES (${deviceId}, ${k}, ${wHigh}, ${bHigh}, ${wLow}, ${bLow})
        ON CONFLICT (pod, metric) DO UPDATE SET
          watch_high = EXCLUDED.watch_high,
          bad_high = EXCLUDED.bad_high,
          watch_low = EXCLUDED.watch_low,
          bad_low = EXCLUDED.bad_low
      `;
    }
  }
  return { ok: true };
}

// ---------- Firmware OTA Management (section 3.4) ----------
export async function createFirmwareRelease(args: {
  version: string;
  url: string;
  notes?: string;
  channel?: string;
  targetPods?: string[] | "all";
}) {
  const sql = await db();
  const ver = args.version.trim();
  const url = args.url.trim();
  if (!ver || !url) throw new Error("version and url are required");

  await sql`
    INSERT INTO firmware_releases (version, url, notes, channel)
    VALUES (${ver}, ${url}, ${args.notes ?? ""}, ${args.channel ?? "stable"})
    ON CONFLICT (version) DO UPDATE SET url = EXCLUDED.url, notes = EXCLUDED.notes, channel = EXCLUDED.channel
  `;

  if (args.targetPods === "all") {
    const devs = await sql`SELECT id FROM devices WHERE NOT simulated`;
    for (const d of devs) {
      await sql`
        INSERT INTO pod_firmware_target (device_id, version, updated_at)
        VALUES (${d.id}, ${ver}, now())
        ON CONFLICT (device_id) DO UPDATE SET version = ${ver}, updated_at = now()
      `;
    }
  } else if (Array.isArray(args.targetPods)) {
    for (const id of args.targetPods) {
      await sql`
        INSERT INTO pod_firmware_target (device_id, version, updated_at)
        VALUES (${id}, ${ver}, now())
        ON CONFLICT (device_id) DO UPDATE SET version = ${ver}, updated_at = now()
      `;
    }
  }
  return { ok: true, version: ver };
}

export async function uploadFirmwareBlob(args: {
  version: string;
  buf: Buffer;
  origin: string;
  notes?: string;
  channel?: "stable" | "beta";
  target?: string;
}): Promise<{ ok: boolean; status: number; error?: string; size?: number; url?: string; version?: string }> {
  const version = (args.version || "").trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,19}$/.test(version)) {
    return { ok: false, status: 400, error: "Version must be 1-20 letters, digits, dots or dashes, for example 1.4" };
  }
  const buf = args.buf;
  if (buf.length < 100_000 || buf.length > 4_400_000) {
    return { ok: false, status: 400, error: `That file is ${buf.length} bytes. A pod firmware image is about 1-3 MB.` };
  }
  if (buf[0] !== 0xe9) {
    return {
      ok: false,
      status: 400,
      error: "That is not an ESP32 app image (it must start with byte 0xE9). Use the .ino.bin from Export Compiled Binary, not the bootloader or merged file.",
    };
  }
  const sql = await db();
  const b64 = buf.toString("base64");
  await sql`
    INSERT INTO firmware_blobs (version, size, data_b64) VALUES (${version}, ${buf.length}, ${b64})
    ON CONFLICT (version) DO UPDATE SET size = EXCLUDED.size, data_b64 = EXCLUDED.data_b64, created_at = now()`;
  const url = `${args.origin}/api/firmware/${encodeURIComponent(version)}.bin`;
  const target = args.target || "all";
  const res = await createFirmwareRelease({
    version,
    url,
    notes: args.notes || "",
    channel: args.channel === "beta" ? "beta" : "stable",
    targetPods: target === "all" ? "all" : [target],
  });
  return { ...res, status: 200, size: buf.length, url };
}

export async function listFirmwareState() {
  const sql = await db();
  const releases = await sql`
    SELECT id, version, url, notes, channel, (extract(epoch from created_at) * 1000)::float8 AS created_at
    FROM firmware_releases ORDER BY created_at DESC`;
  const targetsRaw = await sql`
    SELECT t.device_id, t.version, d.name, d.meta, (extract(epoch from t.updated_at) * 1000)::float8 AS updated_at
    FROM pod_firmware_target t
    LEFT JOIN devices d ON d.id = t.device_id`;
  const targets = targetsRaw.map((t: any) => ({
    device_id: t.device_id,
    podId: t.device_id,
    name: t.name || t.device_id,
    currentFw: t.meta?.fw || "1.1",
    version: t.version,
    targetVersion: t.version,
    status: t.meta?.fw === t.version ? "Updated" : "Queued for next check-in",
    updated_at: Number(t.updated_at),
  }));
  const pods = await sql`
    SELECT d.id, d.name, d.simulated, d.meta, (extract(epoch from d.last_seen) * 1000)::float8 AS last_seen
    FROM devices d ORDER BY d.simulated, d.last_seen DESC NULLS LAST`;
  return { releases, targets, pods };
}

// ---------- Anomaly Detection (rolling median & MAD, step detection, section 5.2 #12) ----------
export interface AnomalyFlag {
  metric: MetricKey;
  label: string;
  kind: "spike" | "step";
  current: number;
  typicalMedian: number;
  mad: number;
  ratio: number;
  explanation: string;
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function detectAnomalies(rows6h: { t: number; dust: number | null; air: number | null; temp: number | null; hum: number | null }[]): AnomalyFlag[] {
  const out: AnomalyFlag[] = [];
  if (rows6h.length < 10) return out;

  for (const k of METRIC_KEYS) {
    const vals = rows6h.map((r) => r[k]).filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
    if (vals.length < 10) continue;
    const current = vals[vals.length - 1];
    const baselineVals = vals.slice(0, -2);
    const med = median(baselineVals);
    const absDevs = baselineVals.map((v) => Math.abs(v - med));
    const mad = Math.max(METRICS[k].minDelta / 2, median(absDevs));
    const diff = current - med;
    const zMad = Math.abs(diff) / (1.4826 * mad);

    if (zMad >= 3.2 && Math.abs(diff) >= METRICS[k].minDelta * 2) {
      const ratio = med > 1 ? +(current / med).toFixed(1) : +(Math.abs(diff)).toFixed(1);
      const dir = diff > 0 ? "above" : "below";
      const multText = med > 5 && ratio >= 1.5
        ? `${ratio}x ${dir} the last 6 hours' typical level (${fmt(k, med)}${METRICS[k].unit})`
        : `${Math.abs(diff).toFixed(METRICS[k].decimals)}${METRICS[k].unit} ${dir} the 6-hour median (${fmt(k, med)}${METRICS[k].unit})`;
      out.push({
        metric: k,
        label: METRICS[k].label,
        kind: "spike",
        current,
        typicalMedian: +med.toFixed(1),
        mad: +mad.toFixed(2),
        ratio,
        explanation: `${METRICS[k].label} (${fmt(k, current)}${METRICS[k].unit}) is ${multText} (rolling median & MAD check).`,
      });
    } else if (vals.length >= 6) {
      // Step detection: compare mean of last 3 points to previous 5 points
      const recent3 = vals.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const prev5 = vals.slice(-8, -3);
      if (prev5.length >= 3) {
        const prevAvg = prev5.reduce((a, b) => a + b, 0) / prev5.length;
        const step = recent3 - prevAvg;
        if (Math.abs(step) >= METRICS[k].minDelta * 3.5) {
          out.push({
            metric: k,
            label: METRICS[k].label,
            kind: "step",
            current,
            typicalMedian: +prevAvg.toFixed(1),
            mad: +mad.toFixed(2),
            ratio: +(Math.abs(step)).toFixed(1),
            explanation: `${METRICS[k].label} shifted by ${step > 0 ? "+" : ""}${step.toFixed(METRICS[k].decimals)}${METRICS[k].unit} in the last few minutes compared to just before (${fmt(k, prevAvg)}${METRICS[k].unit}).`,
          });
        }
      }
    }
  }
  return out;
}

// ---------- Hour-of-Day Typical Pattern Baselines (section 5.2 #13) ----------
export interface HourlyPattern {
  hour: number;
  label: string;
  dust: number | null;
  air: number | null;
  temp: number | null;
  hum: number | null;
  n: number;
}

export async function getTypicalPatterns(deviceId: string): Promise<{
  hours: HourlyPattern[];
  notes: string[];
}> {
  const sql = await db();
  const rows = await sql`
    SELECT extract(hour from ts)::int AS hr,
           count(*) AS n,
           avg(dust)::float8 AS dust,
           avg(air)::float8 AS air,
           avg(temp)::float8 AS temp,
           avg(hum)::float8 AS hum
    FROM readings
    WHERE device_id = ${deviceId} AND ts > now() - interval '7 days'
    GROUP BY 1 ORDER BY 1`;

  const byHour = new Map<number, any>();
  for (const r of rows) byHour.set(Number(r.hr), r);

  const hours: HourlyPattern[] = [];
  for (let h = 0; h < 24; h++) {
    const r = byHour.get(h);
    hours.push({
      hour: h,
      label: `${String(h).padStart(2, "0")}:00`,
      dust: r ? num(r.dust) : null,
      air: r ? num(r.air) : null,
      temp: r ? num(r.temp) : null,
      hum: r ? num(r.hum) : null,
      n: r ? Number(r.n) : 0,
    });
  }

  const notes: string[] = [];
  const withData = hours.filter((h) => h.n > 0);
  if (withData.length >= 3) {
    const peakDust = [...withData].filter((h) => h.dust !== null).sort((a, b) => (b.dust ?? 0) - (a.dust ?? 0))[0];
    if (peakDust && peakDust.dust !== null) {
      notes.push(`Typical pattern: highest dust index usually occurs around ${peakDust.label} (avg ${peakDust.dust.toFixed(0)}%).`);
    }
    const peakTemp = [...withData].filter((h) => h.temp !== null).sort((a, b) => (b.temp ?? 0) - (a.temp ?? 0))[0];
    if (peakTemp && peakTemp.temp !== null) {
      notes.push(`Typical pattern: warmest hour is usually around ${peakTemp.label} (avg ${peakTemp.temp.toFixed(1)} °C).`);
    }
    const lowAir = [...withData].filter((h) => h.air !== null).sort((a, b) => (a.air ?? 100) - (b.air ?? 100))[0];
    if (lowAir && lowAir.air !== null) {
      notes.push(`Typical pattern: air index is lowest around ${lowAir.label} (avg ${lowAir.air.toFixed(0)}%).`);
    }
  } else {
    notes.push("Typical hour-of-day patterns appear once the pod has collected several hours of readings.");
  }

  return { hours, notes };
}

// ---------- Daily & Weekly AI Insight Cards + Compare Yesterday vs Today (section 5.2 #8 & #9) ----------
export async function getInsightsAndComparison(deviceId: string) {
  const sql = await db();
  const now = Date.now();
  const devRows = await sql`SELECT name FROM devices WHERE id = ${deviceId}`;
  const devName = (devRows[0]?.name as string) ?? deviceId;

  // Hourly series for Today (last 24h) vs Yesterday (24h to 48h ago)
  const todayRows = await sql`
    SELECT extract(hour from ts)::int AS hr,
           avg(dust)::float8 AS dust, avg(air)::float8 AS air, avg(temp)::float8 AS temp, avg(hum)::float8 AS hum
    FROM readings WHERE device_id = ${deviceId} AND ts > ${iso(now - 24 * 3600_000)}::timestamptz
    GROUP BY 1 ORDER BY 1`;
  const yestRows = await sql`
    SELECT extract(hour from ts)::int AS hr,
           avg(dust)::float8 AS dust, avg(air)::float8 AS air, avg(temp)::float8 AS temp, avg(hum)::float8 AS hum
    FROM readings WHERE device_id = ${deviceId}
      AND ts BETWEEN ${iso(now - 48 * 3600_000)}::timestamptz AND ${iso(now - 24 * 3600_000)}::timestamptz
    GROUP BY 1 ORDER BY 1`;

  const tMap = new Map<number, any>();
  const yMap = new Map<number, any>();
  for (const r of todayRows) tMap.set(Number(r.hr), r);
  for (const r of yestRows) yMap.set(Number(r.hr), r);

  const comparison = Array.from({ length: 24 }, (_, h) => {
    const t = tMap.get(h);
    const y = yMap.get(h);
    return {
      hour: `${String(h).padStart(2, "0")}:00`,
      todayDust: t ? num(t.dust) : null,
      yesterdayDust: y ? num(y.dust) : null,
      todayAir: t ? num(t.air) : null,
      yesterdayAir: y ? num(y.air) : null,
      todayTemp: t ? num(t.temp) : null,
      yesterdayTemp: y ? num(y.temp) : null,
      todayHum: t ? num(t.hum) : null,
      yesterdayHum: y ? num(y.hum) : null,
    };
  });

  // Compute statistics for Daily Insight
  let bestHour = "08:00";
  let worstHour = "14:00";
  let bestScore = -1;
  let worstScore = 999;
  for (const r of todayRows) {
    const h = `${String(r.hr).padStart(2, "0")}:00`;
    const score = (num(r.air) ?? 85) - (num(r.dust) ?? 15) * 0.6;
    if (score > bestScore) { bestScore = score; bestHour = h; }
    if (score < worstScore) { worstScore = score; worstHour = h; }
  }

  const evCounts = await sql`
    SELECT kind, metric, count(*) AS n FROM events
    WHERE device_id = ${deviceId} AND ts > ${iso(now - 24 * 3600_000)}::timestamptz
    GROUP BY kind, metric`;
  const alertsCount = evCounts.filter((e) => e.kind === "alert").reduce((a, b) => a + Number(b.n), 0);
  const earlyWarningsCount = evCounts.filter((e) => e.kind === "predictive").reduce((a, b) => a + Number(b.n), 0);

  const avgTodayDust = todayRows.length
    ? todayRows.reduce((a, r) => a + (num(r.dust) ?? 0), 0) / todayRows.length
    : null;
  const avgYestDust = yestRows.length
    ? yestRows.reduce((a, r) => a + (num(r.dust) ?? 0), 0) / yestRows.length
    : null;

  let comparedToPrev = "first full day of readings";
  if (avgTodayDust !== null && avgYestDust !== null) {
    const d = avgTodayDust - avgYestDust;
    comparedToPrev = Math.abs(d) < 2
      ? "dust index similar to yesterday"
      : d > 0
        ? `dust index ${d.toFixed(0)} points higher than yesterday`
        : `dust index ${Math.abs(d).toFixed(0)} points cleaner than yesterday`;
  }

  const dailyStats: InsightStats = {
    deviceName: devName,
    period: "daily",
    bestHour,
    worstHour,
    worstMetric: "Dust & Air index",
    alertsCount,
    earlyWarningsCount,
    comparedToPrev,
    suggestion: `Ventilate the room before ${worstHour} and keep windows closed if outdoor dust rises.`,
  };

  const dailyInsight = await generateInsightText(dailyStats);
  const patterns = await getTypicalPatterns(deviceId);

  return {
    deviceId,
    deviceName: devName,
    daily: {
      stats: dailyStats,
      text: dailyInsight.text,
      source: dailyInsight.source,
    },
    comparison,
    patterns,
  };
}
