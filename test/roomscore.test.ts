import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRoomScore } from "../lib/config.ts";

test("one bad reading (gas drops the air index) makes the room score Poor, not averaged away", () => {
  const r = computeRoomScore({ air: 20, dust: 5, temp: 26, hum: 50 });
  assert.equal(r.level, "bad");
  assert.equal(r.word, "Poor");
  assert.ok((r.score ?? 100) <= 40, `score was ${r.score}`);
  assert.equal(r.worstMetric, "air");
});

test("all good readings still score Good", () => {
  const r = computeRoomScore({ air: 95, dust: 5, temp: 26, hum: 50 });
  assert.equal(r.word, "Good");
});
