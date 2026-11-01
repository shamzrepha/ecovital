import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, statusWord } from "../lib/config.ts";
import { forecast, type Pt } from "../lib/predict.ts";
import { evaluateRules, emptyState, ALERT_COOLDOWN_MS } from "../lib/rules.ts";
import { validateReading } from "../lib/validate.ts";

// helper: build a series, one point every 5 s ending at t=0
function series(f: (i: number, n: number) => number, minutes = 6, stepS = 5): Pt[] {
  const n = Math.floor((minutes * 60) / stepS) + 1;
  return Array.from({ length: n }, (_, i) => ({ t: (i - (n - 1)) * stepS * 1000, v: f(i, n) }));
}
// deterministic pseudo-noise
const noise = (i: number, amp: number) => Math.sin(i * 12.9898) * amp;

test("classify: thresholds and hysteresis", () => {
  assert.equal(classify("hum", 45), "ok");
  assert.equal(classify("hum", 29), "watch-low");
  assert.equal(classify("hum", 83), "bad-high");
  assert.equal(classify("air", 40), "bad-low");
  assert.equal(classify("air", 60), "watch-low");
  // hysteresis: humidity was dry (<=30); 31 is still dry, 33 is back to ok
  assert.equal(classify("hum", 31, "watch-low"), "watch-low");
  assert.equal(classify("hum", 33, "watch-low"), "ok");
  // without a previous alert, 31 is simply ok
  assert.equal(classify("hum", 31, "ok"), "ok");
  assert.equal(statusWord("hum", "watch-low"), "Dry");
});

test("forecast: steady noisy signal is called steady", () => {
  const f = forecast("hum", series((i) => 50 + noise(i, 0.6)));
  assert.equal(f.ok, true);
  assert.equal(f.trend, "steady");
  assert.equal(f.crossing, undefined);
});

test("forecast: falling humidity predicts crossing the dry threshold", () => {
  // 45 -> 33 over 6 min (-2 %/min), small noise. 30 is reached ~1.5 min after the end.
  const f = forecast("hum", series((i, n) => 45 - (12 * i) / (n - 1) + noise(i, 0.3)));
  assert.equal(f.ok, true);
  assert.equal(f.trend, "falling");
  assert.ok(f.crossing, "should find a crossing");
  assert.equal(f.crossing!.threshold, 30);
  assert.equal(f.crossing!.side, "low");
  assert.ok(f.crossing!.minutes > 0.5 && f.crossing!.minutes < 3.5, `minutes=${f.crossing!.minutes}`);
  assert.ok(f.predicted < 30);
  assert.notEqual(f.confidence, "low");
});

test("forecast: refuses to guess with too little data", () => {
  const f = forecast("hum", series(() => 50, 1));
  assert.equal(f.ok, false);
  assert.match(f.reason ?? "", /Not enough/);
});

test("forecast: pure noise does not produce a confident trend", () => {
  const f = forecast("dust", series((i) => 20 + noise(i, 4)));
  assert.equal(f.trend, "steady");
});

test("rules: alert fires once, respects cooldown, recovery speaks", () => {
  let state = emptyState();
  const t0 = 1_000_000;
  // ok -> dry
  let r = evaluateRules({ now: t0, values: { hum: 28 }, prev: state, forecasts: {} });
  assert.equal(r.triggers.length, 1);
  assert.equal(r.triggers[0].kind, "alert");
  assert.equal(r.triggers[0].metric, "hum");
  state = r.next;
  // still dry 10 s later: no repeat
  r = evaluateRules({ now: t0 + 10_000, values: { hum: 27 }, prev: state, forecasts: {} });
  assert.equal(r.triggers.length, 0);
  state = r.next;
  // hovering at 31 (inside hysteresis): still no recovery
  r = evaluateRules({ now: t0 + 20_000, values: { hum: 31 }, prev: state, forecasts: {} });
  assert.equal(r.triggers.length, 0);
  state = r.next;
  // clearly recovered
  r = evaluateRules({ now: t0 + 60_000, values: { hum: 36 }, prev: state, forecasts: {} });
  assert.equal(r.triggers.length, 1);
  assert.equal(r.triggers[0].kind, "recovered");
  state = r.next;
  // drops again before cooldown (2 min since first alert) -> suppressed
  r = evaluateRules({ now: t0 + 90_000, values: { hum: 25 }, prev: state, forecasts: {} });
  assert.equal(r.triggers.length, 0, "cooldown should suppress a repeat alert");
  // after cooldown -> alerts again (state was updated to watch-low above, so reset it)
  state = { ...state, status: { hum: "ok" } };
  r = evaluateRules({ now: t0 + ALERT_COOLDOWN_MS + 5_000, values: { hum: 25 }, prev: state, forecasts: {} });
  assert.equal(r.triggers[0]?.kind, "alert");
});

test("rules: predictive warning only with a non-low-confidence crossing", () => {
  const f = forecast("hum", series((i, n) => 45 - (12 * i) / (n - 1) + noise(i, 0.3)));
  const r = evaluateRules({ now: 5_000_000, values: { hum: 38 }, prev: emptyState(), forecasts: { hum: f } });
  assert.equal(r.triggers[0]?.kind, "predictive");
  assert.ok(r.triggers[0].crossing);
  const r2 = evaluateRules({ now: 5_001_000, values: { hum: 38 }, prev: r.next, forecasts: { hum: f } });
  assert.equal(r2.triggers.length, 0, "predictive cooldown");
  const low = { ...f, confidence: "low" as const };
  const r3 = evaluateRules({ now: 9_000_000, values: { hum: 38 }, prev: emptyState(), forecasts: { hum: low } });
  assert.equal(r3.triggers.length, 0, "low confidence must not warn");
});

test("rules: worst alert is primary", () => {
  const r = evaluateRules({ now: 1, values: { hum: 28, dust: 80 }, prev: emptyState(), forecasts: {} });
  assert.equal(r.triggers[0].metric, "dust"); // bad (100) beats watch (80)
});

test("validate: rejects missing, NaN and out-of-range values", () => {
  const c = validateReading({ ageMs: 5000, dust: 12, air: 120, temp: null, hum: "x" });
  assert.equal(c.values.dust, 12);
  assert.equal(c.values.air, null);
  assert.equal(c.values.temp, null);
  assert.equal(c.values.hum, null);
  assert.deepEqual(c.flags.sort(), ["air:out_of_range", "hum:not_a_number", "temp:missing"]);
});
