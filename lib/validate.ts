// Sensor reading validation. Nothing invalid is ever stored as a real value.

import { METRICS, METRIC_KEYS, type MetricKey } from "./config.ts";

export interface RawReading {
  ageMs?: unknown;
  dust?: unknown;
  air?: unknown;
  temp?: unknown;
  hum?: unknown;
}

export interface CleanReading {
  ageMs: number;
  values: Record<MetricKey, number | null>;
  flags: string[]; // e.g. "temp:missing", "hum:out_of_range"
}

export function validateReading(r: RawReading): CleanReading {
  const flags: string[] = [];
  const values = {} as Record<MetricKey, number | null>;
  for (const k of METRIC_KEYS) {
    const raw = (r as Record<string, unknown>)[k];
    const cfg = METRICS[k];
    if (raw === undefined) {
      values[k] = null; // not sent (for example the gas sensor is still warming up): not an error
    } else if (raw === null) {
      values[k] = null;
      flags.push(`${k}:missing`); // sent as null: the sensor read failed
    } else if (typeof raw !== "number" || !Number.isFinite(raw)) {
      values[k] = null;
      flags.push(`${k}:not_a_number`);
    } else if (raw < cfg.min || raw > cfg.max) {
      values[k] = null;
      flags.push(`${k}:out_of_range`);
    } else {
      values[k] = raw;
    }
  }
  let ageMs = typeof r.ageMs === "number" && Number.isFinite(r.ageMs) ? r.ageMs : 0;
  ageMs = Math.min(Math.max(0, ageMs), 24 * 3600_000); // device buffer is at most a day old
  return { ageMs, values, flags };
}
