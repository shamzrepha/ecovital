// Metric definitions, thresholds and status classification.
// Pure functions only (no I/O) so they can be unit-tested.

export type MetricKey = "air" | "dust" | "temp" | "hum";
export const METRIC_KEYS: MetricKey[] = ["air", "dust", "temp", "hum"];

export type Side = "high" | "low";
export type Level = "ok" | "watch" | "bad";
// Stored as a string: "ok" | "watch-high" | "bad-high" | "watch-low" | "bad-low"
export type Status = string;

export interface MetricCfg {
  key: MetricKey;
  label: string;
  unit: string;
  min: number; // plausible range of the sensor value we store
  max: number;
  decimals: number;
  minDelta: number; // smallest change we treat as real (sensor resolution / noise)
  hysteresis: number; // how far back inside the safe zone before an alert clears
  watchHigh?: number;
  badHigh?: number;
  watchLow?: number;
  badLow?: number;
  note: string; // honest description of what the number is
  words: { ok: string; watchHigh?: string; badHigh?: string; watchLow?: string; badLow?: string };
}

export const METRICS: Record<MetricKey, MetricCfg> = {
  air: {
    key: "air",
    label: "Air index",
    unit: "%",
    min: 0,
    max: 100,
    decimals: 0,
    minDelta: 3,
    hysteresis: 3,
    watchLow: 70,
    badLow: 45,
    note: "MQ135 voltage mapped to 0-100 (higher is cleaner). Relative and uncalibrated; it is not a gas concentration.",
    words: { ok: "Clean", watchLow: "Fair", badLow: "Poor" },
  },
  dust: {
    key: "dust",
    label: "Dust",
    unit: "%",
    min: 0,
    max: 100,
    decimals: 0,
    minDelta: 3,
    hysteresis: 3,
    watchHigh: 35,
    badHigh: 65,
    note: "GP2Y1010AU0F optical dust index, 0-100 relative to a clean-air baseline. It is not a PM2.5 value in ug/m3.",
    words: { ok: "Low", watchHigh: "Dusty", badHigh: "Very dusty" },
  },
  temp: {
    key: "temp",
    label: "Temperature",
    unit: "°C",
    min: -10,
    max: 60,
    decimals: 1,
    minDelta: 0.5,
    hysteresis: 0.5,
    watchHigh: 30,
    badHigh: 36,
    watchLow: 16,
    note: "DHT22 temperature, about ±0.5 °C.",
    words: { ok: "Comfortable", watchHigh: "Warm", badHigh: "Hot", watchLow: "Cool" },
  },
  hum: {
    key: "hum",
    label: "Humidity",
    unit: "%",
    min: 0,
    max: 100,
    decimals: 0,
    minDelta: 2,
    hysteresis: 2,
    watchHigh: 68,
    badHigh: 82,
    watchLow: 30,
    note: "DHT22 relative humidity, about ±2-5 %.",
    words: { ok: "Comfortable", watchHigh: "Damp", badHigh: "Very humid", watchLow: "Dry" },
  },
};

const RANK: Record<Level, number> = { ok: 0, watch: 1, bad: 2 };

export function parseStatus(s: Status | undefined | null): { level: Level; side: Side | null } {
  if (!s || s === "ok") return { level: "ok", side: null };
  const [level, side] = s.split("-");
  return { level: level as Level, side: side as Side };
}
export function statusRank(s: Status | undefined | null): number {
  return RANK[parseStatus(s).level];
}

// Classify with thresholds loosened by `adj` toward the alarm side.
function classifyRaw(m: MetricCfg, v: number, adj: number): Status {
  if (m.badHigh !== undefined && v >= m.badHigh - adj) return "bad-high";
  if (m.badLow !== undefined && v <= m.badLow + adj) return "bad-low";
  if (m.watchHigh !== undefined && v >= m.watchHigh - adj) return "watch-high";
  if (m.watchLow !== undefined && v <= m.watchLow + adj) return "watch-low";
  return "ok";
}

export interface ThresholdOverride {
  watchHigh?: number | null;
  badHigh?: number | null;
  watchLow?: number | null;
  badLow?: number | null;
}

export type ProfileKey = "classroom" | "bedroom" | "nursery" | "lab" | "office" | "asthma";
export type RoomProfileKey = ProfileKey;

export interface RoomProfileDef {
  key: ProfileKey;
  label: string;
  description: string;
  toneHint: string;
  overrides: Partial<Record<MetricKey, ThresholdOverride>>;
}

export const ROOM_PROFILES: Record<ProfileKey, RoomProfileDef> = {
  classroom: {
    key: "classroom",
    label: "Classroom",
    description: "Default Nigerian classroom limits: accounts for warm afternoons and harmattan dust.",
    toneHint: "Speak clearly to a teacher or students in a classroom.",
    overrides: {},
  },
  bedroom: {
    key: "bedroom",
    label: "Bedroom",
    description: "Cooler temperature comfort and quieter evening thresholds for restful sleep.",
    toneHint: "Calm, gentle tone suited for a home bedroom.",
    overrides: {
      temp: { watchHigh: 28, badHigh: 33, watchLow: 17 },
      air: { watchLow: 75, badLow: 50 },
    },
  },
  nursery: {
    key: "nursery",
    label: "Nursery / Baby",
    description: "Stricter dust, humidity and temperature limits for infants and toddlers (Netatmo-style).",
    toneHint: "Gentle, reassuring advice for a parent caring for a baby or toddler.",
    overrides: {
      dust: { watchHigh: 25, badHigh: 50 },
      temp: { watchHigh: 28, badHigh: 32, watchLow: 18 },
      hum: { watchHigh: 65, badHigh: 78, watchLow: 35 },
      air: { watchLow: 75, badLow: 55 },
    },
  },
  asthma: {
    key: "asthma",
    label: "Sensitive / Dust-aware",
    description: "Tighter dust and air index watch levels for dust-sensitive rooms.",
    toneHint: "Practical, calm advice focused on keeping dust and fumes down; never make medical claims.",
    overrides: {
      dust: { watchHigh: 22, badHigh: 45 },
      air: { watchLow: 78, badLow: 55 },
      hum: { watchHigh: 62, badHigh: 75, watchLow: 35 },
    },
  },
  lab: {
    key: "lab",
    label: "Lab / Workshop",
    description: "Tighter air index and humidity watch levels for equipment and soldering/fumes.",
    toneHint: "Direct, concise advice for a university lab or electronics workshop.",
    overrides: {
      air: { watchLow: 75, badLow: 50 },
      hum: { watchHigh: 62, badHigh: 75, watchLow: 30 },
    },
  },
  office: {
    key: "office",
    label: "Office",
    description: "Balanced daytime comfort limits for focus and fresh air.",
    toneHint: "Concise, helpful advice for a shared workspace.",
    overrides: {
      temp: { watchHigh: 29, badHigh: 34, watchLow: 18 },
      air: { watchLow: 72, badLow: 48 },
    },
  },
};

export function effectiveMetricCfg(
  key: MetricKey,
  profile: string = "classroom",
  custom?: Partial<Record<MetricKey, ThresholdOverride>>,
): MetricCfg {
  const base = METRICS[key];
  const prof = ROOM_PROFILES[(profile as ProfileKey) in ROOM_PROFILES ? (profile as ProfileKey) : "classroom"];
  const pOv = prof?.overrides?.[key] ?? {};
  const cOv = custom?.[key] ?? {};
  const pick = (cVal: number | null | undefined, pVal: number | null | undefined, bVal: number | undefined) => {
    if (cVal !== undefined && cVal !== null && Number.isFinite(Number(cVal))) return Number(cVal);
    if (pVal !== undefined && pVal !== null && Number.isFinite(Number(pVal))) return Number(pVal);
    return bVal;
  };
  return {
    ...base,
    watchHigh: pick(cOv.watchHigh, pOv.watchHigh, base.watchHigh),
    badHigh: pick(cOv.badHigh, pOv.badHigh, base.badHigh),
    watchLow: pick(cOv.watchLow, pOv.watchLow, base.watchLow),
    badLow: pick(cOv.badLow, pOv.badLow, base.badLow),
  };
}

/** Classify a reading. `prev` adds hysteresis so values hovering at a threshold do not flap. */
export function classify(
  key: MetricKey,
  v: number,
  prev: Status = "ok",
  cfgOverride?: MetricCfg,
): Status {
  const m = cfgOverride ?? METRICS[key];
  const s0 = classifyRaw(m, v, 0);
  if (prev === "ok" || statusRank(s0) >= statusRank(prev)) return s0;
  // Moving to a better state: only allowed once the value is clear of the threshold by `hysteresis`.
  const sh = classifyRaw(m, v, m.hysteresis);
  return statusRank(sh) < statusRank(prev) ? sh : prev;
}

export function statusWord(key: MetricKey, s: Status): string {
  const m = METRICS[key];
  switch (s) {
    case "watch-high": return m.words.watchHigh ?? "Elevated";
    case "bad-high": return m.words.badHigh ?? "High";
    case "watch-low": return m.words.watchLow ?? "Low";
    case "bad-low": return m.words.badLow ?? "Very low";
    default: return m.words.ok;
  }
}

export interface Band { from: number; to: number; level: Level }
/** Shaded zones for charts, derived from the same thresholds the alerts use. */
export function bands(key: MetricKey, cfgOverride?: MetricCfg): Band[] {
  const m = cfgOverride ?? METRICS[key];
  const out: Band[] = [];
  if (m.badHigh !== undefined) out.push({ from: m.badHigh, to: m.max, level: "bad" });
  if (m.watchHigh !== undefined) out.push({ from: m.watchHigh, to: m.badHigh ?? m.max, level: "watch" });
  if (m.badLow !== undefined) out.push({ from: m.min, to: m.badLow, level: "bad" });
  if (m.watchLow !== undefined) out.push({ from: m.badLow ?? m.min, to: m.watchLow, level: "watch" });
  return out;
}

export function fmt(key: MetricKey, v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "--";
  return v.toFixed(METRICS[key].decimals);
}

// ---------- Room Score (Awair-style 0-100 with adjustable weights) ----------
export interface RoomScoreResult {
  score: number | null;
  word: "Good" | "Fair" | "Poor" | "No data";
  level: "good" | "watch" | "bad";
  subscores: Partial<Record<MetricKey, number>>;
  weights: Record<MetricKey, number>;
  reasons: string[];
  worstMetric: MetricKey | null;
}

export function metricSubscore(key: MetricKey, v: number, cfgOverride?: MetricCfg): number {
  const m = cfgOverride ?? METRICS[key];
  const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
  if (key === "air") {
    const wL = m.watchLow ?? 70, bL = m.badLow ?? 45;
    if (v >= wL) return clamp(80 + ((v - wL) / Math.max(1, 100 - wL)) * 20);
    if (v >= bL) return clamp(50 + ((v - bL) / Math.max(1, wL - bL)) * 30);
    return clamp((v / Math.max(1, bL)) * 50);
  }
  if (key === "dust") {
    const wH = m.watchHigh ?? 35, bH = m.badHigh ?? 65;
    if (v <= wH) return clamp(100 - (v / Math.max(1, wH)) * 20);
    if (v <= bH) return clamp(80 - ((v - wH) / Math.max(1, bH - wH)) * 35);
    return clamp(45 - ((v - bH) / Math.max(1, 100 - bH)) * 45);
  }
  if (key === "temp") {
    const wL = m.watchLow ?? 16, wH = m.watchHigh ?? 30, bH = m.badHigh ?? 36;
    const mid = (wL + wH) / 2;
    if (v >= wL && v <= wH) {
      const dist = Math.abs(v - mid) / Math.max(1, (wH - wL) / 2);
      return clamp(100 - dist * 18);
    }
    if (v > wH) {
      if (v <= bH) return clamp(80 - ((v - wH) / Math.max(1, bH - wH)) * 35);
      return clamp(45 - ((v - bH) / 10) * 45);
    }
    return clamp(80 - ((wL - v) / 8) * 50);
  }
  // hum
  const wL = m.watchLow ?? 30, wH = m.watchHigh ?? 68, bH = m.badHigh ?? 82;
  const mid = (wL + wH) / 2;
  if (v >= wL && v <= wH) {
    const dist = Math.abs(v - mid) / Math.max(1, (wH - wL) / 2);
    return clamp(100 - dist * 18);
  }
  if (v > wH) {
    if (v <= bH) return clamp(80 - ((v - wH) / Math.max(1, bH - wH)) * 35);
    return clamp(45 - ((v - bH) / Math.max(1, 100 - bH)) * 45);
  }
  return clamp(80 - ((wL - v) / Math.max(1, wL)) * 55);
}

export function computeRoomScore(
  values: Partial<Record<MetricKey, number | null>>,
  rawWeights?: Partial<Record<MetricKey, number>>,
  profile: string = "classroom",
  customThresholds?: Partial<Record<MetricKey, ThresholdOverride>>,
): RoomScoreResult {
  const weights: Record<MetricKey, number> = {
    air: Math.max(0, Number(rawWeights?.air ?? 25)),
    dust: Math.max(0, Number(rawWeights?.dust ?? 25)),
    temp: Math.max(0, Number(rawWeights?.temp ?? 25)),
    hum: Math.max(0, Number(rawWeights?.hum ?? 25)),
  };
  const subscores: Partial<Record<MetricKey, number>> = {};
  let weightedSum = 0;
  let totalW = 0;
  let worstMetric: MetricKey | null = null;
  let worstSub = 101;
  const reasons: string[] = [];

  for (const k of METRIC_KEYS) {
    const v = values[k];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const cfg = effectiveMetricCfg(k, profile, customThresholds);
    const sub = metricSubscore(k, v, cfg);
    subscores[k] = sub;
    const w = weights[k] > 0 ? weights[k] : 1;
    weightedSum += sub * w;
    totalW += w;
    const st = classify(k, v, "ok", cfg);
    if (sub < worstSub) {
      worstSub = sub;
      worstMetric = k;
    }
    if (st !== "ok") {
      reasons.push(`${cfg.label} is ${statusWord(k, st).toLowerCase()} (${fmt(k, v)}${cfg.unit})`);
    }
  }

  if (totalW === 0) {
    return { score: null, word: "No data", level: "watch", subscores, weights, reasons: ["No recent sensor readings available."], worstMetric: null };
  }
  const score = Math.round(weightedSum / totalW);
  if (reasons.length === 0) {
    reasons.push("All four readings are inside the comfortable range for this room profile.");
  }
  const word = score >= 80 ? "Good" : score >= 55 ? "Fair" : "Poor";
  const level = score >= 80 ? "good" : score >= 55 ? "watch" : "bad";
  return { score, word, level, subscores, weights, reasons, worstMetric };
}

// ---------- Action Library (section 5.2 #14 & section 2 rule 4) ----------
export type ActionCode = "open_window" | "fan" | "ac" | "water" | "close_window" | "none";

export interface ActionItem {
  id: string;
  metric: MetricKey | "all";
  condition: string;
  status: Status | "rapid";
  actionCode: ActionCode;
  advice: string;
  spokenShort: string;
  needsHardware: boolean;
  hardwareNote?: string;
}

export const ACTION_LIBRARY: ActionItem[] = [
  {
    id: "dust-watch",
    metric: "dust",
    condition: "Dust index above 35% (Watch)",
    status: "watch-high",
    actionCode: "close_window",
    advice: "Close windows facing dusty roads or harmattan wind and wipe desks with a damp cloth.",
    spokenShort: "Dust is rising. Consider closing the windows and wiping surfaces.",
    needsHardware: false,
  },
  {
    id: "dust-bad",
    metric: "dust",
    condition: "Dust index above 65% (Bad)",
    status: "bad-high",
    actionCode: "close_window",
    advice: "Keep windows closed, pause sweeping until the room clears, and damp-wipe surfaces.",
    spokenShort: "Dust is high. Keep the windows closed and let the dust settle.",
    needsHardware: false,
  },
  {
    id: "air-watch",
    metric: "air",
    condition: "Air index below 70% (Watch)",
    status: "watch-low",
    actionCode: "open_window",
    advice: "Open opposite windows for cross-ventilation to let stale air out.",
    spokenShort: "The air is getting stale. Open a window to let fresh air in.",
    needsHardware: false,
  },
  {
    id: "air-bad",
    metric: "air",
    condition: "Air index below 45% (Bad)",
    status: "bad-low",
    actionCode: "open_window",
    advice: "Open windows and doors right away and check for nearby smoke, generator exhaust, or fumes.",
    spokenShort: "Air quality index is poor. Open windows now and check for smoke or fumes.",
    needsHardware: false,
  },
  {
    id: "temp-watch-high",
    metric: "temp",
    condition: "Temperature above 30 °C (Warm)",
    status: "watch-high",
    actionCode: "fan",
    advice: "Switch on a ceiling or standing fan by hand or open windows for airflow.",
    spokenShort: "The room is getting warm. Switch on a fan or open a window.",
    needsHardware: false,
  },
  {
    id: "temp-bad-high",
    metric: "temp",
    condition: "Temperature above 36 °C (Hot)",
    status: "bad-high",
    actionCode: "ac",
    advice: "Turn on fans or air conditioning, shade sunny windows, and drink water.",
    spokenShort: "It is very hot in here. Turn on a fan, open windows, and drink some water.",
    needsHardware: false,
  },
  {
    id: "temp-watch-low",
    metric: "temp",
    condition: "Temperature below 16 °C (Cool)",
    status: "watch-low",
    actionCode: "close_window",
    advice: "Close windows to keep warmth in and wear an extra layer.",
    spokenShort: "The room is cool. Close the windows to keep warmth inside.",
    needsHardware: false,
  },
  {
    id: "hum-watch-high",
    metric: "hum",
    condition: "Humidity above 68% (Damp)",
    status: "watch-high",
    actionCode: "fan",
    advice: "Turn on a fan or open a window to move damp air out.",
    spokenShort: "Humidity is high. Turn on a fan or open a window to dry the air.",
    needsHardware: false,
  },
  {
    id: "hum-bad-high",
    metric: "hum",
    condition: "Humidity above 82% (Very humid)",
    status: "bad-high",
    actionCode: "fan",
    advice: "Ventilate the room and run a fan so moisture does not settle on walls and books.",
    spokenShort: "Humidity is very high. Open windows and run a fan to clear the moisture.",
    needsHardware: false,
  },
  {
    id: "hum-watch-low",
    metric: "hum",
    condition: "Humidity below 30% (Dry / Harmattan)",
    status: "watch-low",
    actionCode: "water",
    advice: "Drink water regularly and consider placing a bowl of water or damp towel in the room.",
    spokenShort: "Humidity is low and the air is dry. Drink some water.",
    needsHardware: false,
  },
  {
    id: "auto-fan-relay",
    metric: "all",
    condition: "Automatic fan / purifier switching",
    status: "ok",
    actionCode: "fan",
    advice: "Automatically switch a classroom extractor fan or purifier when thresholds are crossed.",
    spokenShort: "Automatic fan switching requires a relay driver module.",
    needsHardware: true,
    hardwareNote: "Needs extra hardware: MOSFET/relay driver + fan or smart plug (pod has no relay).",
  },
  {
    id: "co2-pm25-upgrade",
    metric: "all",
    condition: "Certified PM2.5 (µg/m³) & CO₂ (ppm) readings",
    status: "ok",
    actionCode: "none",
    advice: "Measure calibrated particulate concentration and true carbon dioxide in ppm.",
    spokenShort: "Calibrated gas and particle units require extra sensors.",
    needsHardware: true,
    hardwareNote: "Needs extra hardware: NDIR CO₂ sensor (e.g. SCD40) and laser PM2.5 sensor (e.g. PMS5003).",
  },
];

// ---------- 15 Offline Clips on the Pod (section 5.1) ----------
export interface OfflineClipMeta {
  id: number;
  code: string;
  title: string;
  when: string;
  transcript: string;
  action: ActionCode;
}

export const OFFLINE_CLIPS: OfflineClipMeta[] = [
  { id: 0, code: "CLIP_DUST_WATCH", title: "Dust rising", when: "Dust > 35% for 10 s", transcript: "Dust is getting a little high. Consider closing the windows and wiping dusty surfaces.", action: "close_window" },
  { id: 1, code: "CLIP_DUST_BAD", title: "Dust high", when: "Dust > 65% for 10 s", transcript: "Dust is high in this room. Keep the windows closed and let the dust settle.", action: "close_window" },
  { id: 2, code: "CLIP_AIR_WATCH", title: "Air stale", when: "Air index < 70% for 10 s", transcript: "The air is getting stale. Open a window to let fresh air into the room.", action: "open_window" },
  { id: 3, code: "CLIP_AIR_BAD", title: "Air poor", when: "Air index < 45% for 10 s", transcript: "The air quality index is poor. Open windows right away and check for smoke or fumes.", action: "open_window" },
  { id: 4, code: "CLIP_HOT_WATCH", title: "Room warm", when: "Temperature > 30 °C for 10 s", transcript: "It is getting warm in here. Switch on a fan or open a window for airflow.", action: "fan" },
  { id: 5, code: "CLIP_HOT_BAD", title: "Room very hot", when: "Temperature > 36 °C for 10 s", transcript: "It is very hot. Turn on a fan, open the windows, and drink some water.", action: "ac" },
  { id: 6, code: "CLIP_COLD", title: "Room cold", when: "Temperature < 16 °C for 10 s", transcript: "The room is getting cold. Close the windows to keep the warmth in.", action: "close_window" },
  { id: 7, code: "CLIP_TEMP_DROP", title: "Temperature dropping fast", when: "Temp drops ≥ 1.5 °C in 90 s", transcript: "Temperature is dropping quickly. Check if a door or window was left open.", action: "close_window" },
  { id: 8, code: "CLIP_TEMP_RISE", title: "Temperature rising fast", when: "Temp rises ≥ 1.5 °C in 90 s", transcript: "Temperature is rising fast. Consider turning on a fan or shading the window.", action: "fan" },
  { id: 9, code: "CLIP_HUM_HIGH", title: "Humidity high", when: "Humidity > 68% for 10 s", transcript: "Humidity is high and the air feels damp. Turn on a fan or open a window.", action: "fan" },
  { id: 10, code: "CLIP_HUM_VHIGH", title: "Humidity very high", when: "Humidity > 82% for 10 s", transcript: "Humidity is very high. Open the windows and run a fan to let the moisture out.", action: "fan" },
  { id: 11, code: "CLIP_HUM_LOW", title: "Air dry", when: "Humidity < 30% for 10 s", transcript: "Humidity is low. The air is dry. Drink some water.", action: "water" },
  { id: 12, code: "CLIP_DUST_SPIKE", title: "Dust jumping fast", when: "Dust jumps ≥ 25 points in 60 s", transcript: "Dust is jumping fast. Someone may be sweeping nearby; close the window for a bit.", action: "close_window" },
  { id: 13, code: "CLIP_ALL_GOOD", title: "All good", when: "All 4 readings return to normal", transcript: "All good now. We are safe.", action: "none" },
  { id: 14, code: "CLIP_IMPROVING", title: "Improving", when: "One reading recovers while another is still off", transcript: "That is improving. Keep going.", action: "none" },
];

export const WINDOW_MIN = 10; // history used for the trend fit
export const HORIZON_MIN = 10; // how far ahead we estimate
export const AI_CONTEXT_MIN = 2; // minutes of readings sent to the AI with every alert

