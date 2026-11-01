// The forecasting model and the weather red flags, on made-up but realistic data.
process.env.LOCAL_PGLITE = "1";
process.env.WEATHER = "";
delete process.env.GEMINI_API_KEY;

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMinuteSeries, trainMetric, predictNext, weatherFlags, type MinuteRow } from "../lib/forecast-ml.ts";
import type { Outside } from "../lib/weather.ts";

const DAYS = 5;
const N = DAYS * 1440;
const T0 = Date.UTC(2026, 10, 1) - N * 60_000;

// A room whose temperature rises and falls with the time of day (warmest mid-afternoon), with a little noise.
function dailyRows(): MinuteRow[] {
  const rows: MinuteRow[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < N; i++) {
    const t = T0 + i * 60_000;
    const h = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
    const temp = 27 + 3 * Math.sin((2 * Math.PI * (h - 9)) / 24) + rnd() * 0.1;
    rows.push({ t, dust: 12 + rnd(), air: 88 + rnd(), temp, hum: 50 - (temp - 27) * 2 + rnd() * 0.2 });
  }
  return rows;
}

test("the model learns the daily rhythm and beats 'no change' on data it did not train on", () => {
  const S = buildMinuteSeries(dailyRows(), T0, N);
  const trained = trainMetric(S, "temp", 30, null);
  assert.equal(trained.method, "learned");
  assert.ok(trained.skillPct >= 30, `skill ${trained.skillPct}`);
  assert.ok(trained.samples > 500);

  // Predict 30 minutes ahead from a point on the rising morning slope and compare with what really happened.
  const i = N - 1 - 30 - 600;
  const p = predictNext(S, "temp", trained, i, null)!;
  const actual = S.v.temp[i + 30];
  assert.ok(Math.abs(p.value - actual) < 0.4, `predicted ${p.value}, actual ${actual}`);
  assert.ok(p.low < p.value && p.value < p.high);
});

test("a pod with only a few minutes of history still gets a trend forecast, labelled as such", () => {
  const rows = dailyRows().slice(0, 12);
  const S = buildMinuteSeries(rows, rows[0].t, 12);
  const trained = trainMetric(S, "temp", 10, null);
  assert.equal(trained.method, "trend");
  assert.equal(trained.skillPct, 0);
  assert.ok(predictNext(S, "temp", trained, 11, null));
});

test("training with outside weather works and is only credited when the model wins", () => {
  const hours = [];
  for (let h = -24; h < N / 60 + 48; h++) hours.push({ t: T0 + h * 3600_000, temp: 24 + 3 * Math.sin(h / 4), hum: 70, rainChance: h % 24 > 20 ? 80 : 5, rainMm: 0 });
  const outside: Outside = { source: "Open-Meteo", fetchedAt: 0, hours, now: { temp: 24, hum: 70, rainMm: 0, code: 1 } };
  const S = buildMinuteSeries(dailyRows(), T0, N);
  const t = trainMetric(S, "temp", 60, outside);
  assert.ok(["learned", "trend", "steady"].includes(t.method));
  assert.equal(t.usesWeather, t.method === "learned");
});

const hours = (temps: number[], rain = 0): Outside["hours"] => temps.map((temp, i) => ({ t: 1_000_000 + i * 3600_000, temp, hum: 80, rainChance: rain, rainMm: 0 }));

test("red flag: the room warms up while it is cooling down outside", () => {
  const now = 1_000_000;
  const outside: Outside = { source: "Open-Meteo", fetchedAt: now, hours: hours([25, 23, 21, 20, 20]), now: { temp: 25, hum: 80, rainMm: 0.4, code: 61 } };
  const flags = weatherFlags({ now, room: { temp: 31, hum: 55 }, perHour: { temp: 0.8, hum: 0 }, outside });
  const f = flags.find((x) => x.id === "warm-inside-cooling-outside");
  assert.ok(f, "must raise the red flag");
  assert.equal(f!.level, "flag");
  assert.match(f!.text, /something inside/i);
});

test("rain with a cooling room is normal and only gets an info note", () => {
  const now = 1_000_000;
  const outside: Outside = { source: "Open-Meteo", fetchedAt: now, hours: hours([25, 23, 22, 22, 22], 80), now: { temp: 25, hum: 85, rainMm: 0.3, code: 61 } };
  const flags = weatherFlags({ now, room: { temp: 29, hum: 55 }, perHour: { temp: -0.5, hum: 0 }, outside });
  assert.ok(!flags.some((f) => f.level === "flag"));
  assert.ok(flags.some((f) => f.id === "rain-cooler" && f.level === "info"));
});

test("without a location there is no weather and no weather flags", () => {
  assert.deepEqual(weatherFlags({ now: 0, room: { temp: 31 }, perHour: { temp: 1 }, outside: null }), []);
});
