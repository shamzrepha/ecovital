// Alert rules: when should EcoVital speak? Pure logic so it can be tested without a database.

import { METRICS, METRIC_KEYS, classify, statusRank, type MetricKey, type Status } from "./config.ts";
import type { Forecast, Crossing } from "./predict.ts";

export const ALERT_COOLDOWN_MS = 2 * 60_000; // same metric cannot raise a new alert more often than this
export const PREDICT_COOLDOWN_MS = 10 * 60_000;

export interface DeviceState {
  status: Partial<Record<MetricKey, Status>>;
  lastAlert: Partial<Record<MetricKey, number>>;
  lastPredictive: Partial<Record<MetricKey, number>>;
}

export type TriggerKind = "alert" | "recovered" | "predictive";
export interface Trigger {
  kind: TriggerKind;
  metric: MetricKey;
  status: Status; // new status
  prevStatus: Status;
  value: number;
  priority: number;
  crossing?: Crossing;
}

export function emptyState(): DeviceState {
  return { status: {}, lastAlert: {}, lastPredictive: {} };
}

export function evaluateRules(args: {
  now: number;
  values: Partial<Record<MetricKey, number>>; // latest valid, fresh value per metric
  prev: DeviceState;
  forecasts: Partial<Record<MetricKey, Forecast>>;
  configs?: Partial<Record<MetricKey, import("./config.ts").MetricCfg>>;
}): { next: DeviceState; triggers: Trigger[] } {
  const { now, values, forecasts, configs } = args;
  const next: DeviceState = {
    status: { ...args.prev.status },
    lastAlert: { ...args.prev.lastAlert },
    lastPredictive: { ...args.prev.lastPredictive },
  };
  const triggers: Trigger[] = [];

  for (const key of METRIC_KEYS) {
    const v = values[key];
    if (v === undefined || !Number.isFinite(v)) continue; // no fresh valid reading: leave state alone
    const prevStatus = args.prev.status[key] ?? "ok";
    const status = classify(key, v, prevStatus, configs?.[key]);
    next.status[key] = status;

    const worse = statusRank(status) > statusRank(prevStatus);
    const toOk = status === "ok" && prevStatus !== "ok";

    if (worse) {
      const last = args.prev.lastAlert[key] ?? -Infinity;
      if (now - last >= ALERT_COOLDOWN_MS) {
        next.lastAlert[key] = now;
        triggers.push({
          kind: "alert", metric: key, status, prevStatus, value: v,
          priority: status.startsWith("bad") ? 100 : 80,
        });
      }
    } else if (toOk) {
      triggers.push({ kind: "recovered", metric: key, status, prevStatus, value: v, priority: 60 });
    } else if (status === prevStatus) {
      // Early warning: a confident trend that will reach a threshold soon.
      const f = forecasts[key];
      const last = args.prev.lastPredictive[key] ?? -Infinity;
      if (
        f && f.ok && f.crossing && f.confidence !== "low" &&
        statusRank(status) < (f.crossing.level === "bad" ? 2 : 1) &&
        now - last >= PREDICT_COOLDOWN_MS
      ) {
        next.lastPredictive[key] = now;
        triggers.push({
          kind: "predictive", metric: key, status, prevStatus, value: v, priority: 40, crossing: f.crossing,
        });
      }
    }
  }

  triggers.sort((a, b) => b.priority - a.priority);
  return { next, triggers };
}

export function describeTrigger(t: Trigger): string {
  const m = METRICS[t.metric];
  if (t.kind === "recovered") return `${m.label} is back to normal.`;
  if (t.kind === "predictive" && t.crossing) {
    return `${m.label} is trending toward ${t.crossing.threshold}${m.unit}, estimated in about ${Math.max(1, Math.round(t.crossing.minutes))} min.`;
  }
  return `${m.label} crossed its ${t.status.startsWith("bad") ? "alarm" : "watch"} level.`;
}
