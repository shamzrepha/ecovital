// End-to-end test of the real pipeline against an in-process Postgres (PGlite).
// No Gemini key is set, so voice lines come from the template fallback; that path is part of what we verify.
process.env.LOCAL_PGLITE = "1";
delete process.env.GEMINI_API_KEY;

import { test } from "node:test";
import assert from "node:assert/strict";
import { runScenario, DEMO_ID, seedGlobal } from "../lib/demo.ts";
import { getNodeDetail, getNodes } from "../lib/queries.ts";
import { db } from "../lib/db.ts";
import { ingest } from "../lib/ingest.ts";
import {
  claimPodByCode,
  unclaimPod,
  updatePodSettings,
  createFirmwareRelease,
  verifyPodIngestKey,
  uploadFirmwareBlob,
} from "../lib/pods.ts";
import { answerPodQuestion, runAiEvaluationSuite } from "../lib/ai.ts";
import { generateAiPredictions } from "../lib/ai-predict.ts";

test("demo flow: normal -> dry alert -> recovery, all via the real ingest pipeline", async () => {
  await runScenario("reset");

  const a = await runScenario("normal");
  assert.equal(a.result?.speak, undefined, "normal data must not speak");
  assert.ok((a.result?.accepted ?? 0) > 40, "backfill + segment accepted");

  const dry = await runScenario("dry");
  assert.ok(dry.result?.speak, "humidity drop must trigger a spoken alert");
  console.log("ALERT LINE:", dry.result!.speak!.text);
  assert.match(dry.result!.speak!.text, /humidity/i);
  assert.equal(dry.result!.speak!.source, "template");

  // repeating the same condition must not re-alert
  const again = await runScenario("dry");
  assert.equal(again.result?.speak, undefined, "no repeated alert while still dry");

  const rec = await runScenario("recover");
  assert.ok(rec.result?.speak, "recovery must speak");
  console.log("RECOVERY LINE:", rec.result!.speak!.text);
  assert.match(rec.result!.speak!.text, /back to normal/i);

  const d = await getNodeDetail(DEMO_ID, "1h");
  assert.ok(d);
  const kinds = d!.events.map((e) => `${e.kind}:${e.metric}`);
  assert.ok(kinds.includes("alert:hum"));
  assert.ok(kinds.includes("recovered:hum"));
  assert.ok(d!.series.length > 5);
  assert.ok(d!.summaries.day.readings > 40);
});

test("AI context carries all 4 sensors from the last 2 minutes", async () => {
  const sql = await db();
  const ev = await sql`SELECT data FROM events WHERE device_id = ${DEMO_ID} AND kind = 'alert' ORDER BY id DESC LIMIT 1`;
  const last2 = ev[0].data.last2min;
  for (const k of ["air", "dust", "temp", "hum"]) {
    assert.ok(last2[k], `last2min.${k} present`);
    assert.ok(last2[k].n >= 10, `${k} has ~2 minutes of readings (got ${last2[k].n})`);
  }
});

test("invalid readings are rejected, not stored", async () => {
  const before = (await (await db())`SELECT count(*) AS n FROM readings WHERE device_id = 'bad-dev'`)[0].n;
  const r = await ingest({ id: "bad-dev" }, [{ ageMs: 0, dust: 999, air: null, temp: "x", hum: -5 }]);
  assert.equal(r.accepted, 0);
  assert.equal(r.rejected, 1);
  const after = (await (await db())`SELECT count(*) AS n FROM readings WHERE device_id = 'bad-dev'`)[0].n;
  assert.equal(Number(after), Number(before));
});

test("re-sending the same batch does not duplicate readings", async () => {
  const batch = [{ ageMs: 5000, dust: 10, air: 90, temp: 27, hum: 50 }];
  const now = Date.now();
  await ingest({ id: "dup-dev" }, batch, { now });
  await ingest({ id: "dup-dev" }, batch, { now });
  const n = (await (await db())`SELECT count(*) AS n FROM readings WHERE device_id = 'dup-dev'`)[0].n;
  assert.equal(Number(n), 1);
});

test("early warning: a steady slide produces a predictive event", async () => {
  await runScenario("reset");
  await runScenario("normal");
  const w = await runScenario("warning");
  const d = await getNodeDetail(DEMO_ID, "1h");
  const kinds = d!.events.map((e) => e.kind);
  console.log("warning scenario events:", kinds, "hum forecast:", JSON.stringify((d!.forecasts as any).hum, (k, v) => (k === "factors" ? undefined : v)));
  assert.ok(kinds.includes("predictive") || kinds.includes("alert"), "slide should raise a warning");
  void w;
});

test("global network seed + node list", async () => {
  const msg = await seedGlobal();
  assert.match(msg, /Seeded 4/);
  const n = await getNodes();
  assert.ok(n.nodes.length >= 5);
  assert.ok(n.nodes.some((x) => x.id === "sim-lagos" && x.simulated && x.latest));
});

test("pair code claiming, 5-try lockout protection, remote settings & OTA reply in ingest", async () => {
  // 1. Pod checks in with pair code FUTO26 and fw 1.1
  await ingest(
    { id: "pod-futo-1", name: "FUTO Lab Pod", meta: { fw: "1.1", claim: "FUTO26" } },
    [{ ageMs: 0, dust: 12, air: 88, temp: 26.5, hum: 50 }],
  );

  // 2. Claim with valid code FUTO26
  const cRes = await claimPodByCode({
    code: "FUTO26",
    userId: "shamaryah",
    nickname: "FUTO Pitch Pod",
    location: "SEET Auditorium",
    roomProfile: "classroom",
  });
  assert.equal(cRes.ok, true);
  assert.equal(cRes.podId, "pod-futo-1");
  assert.ok(cRes.deviceToken, "deviceToken issued at claim time");

  // 3. Update remote settings (volume = 55, mute = true) and queue OTA v1.2.0
  await updatePodSettings("pod-futo-1", { volume: 55, mute: true });
  await createFirmwareRelease({
    version: "1.2.0",
    url: "https://ecovital.vercel.app/fw/v1.2.0.bin",
    notes: "OTA test release",
    channel: "stable",
    targetPods: ["pod-futo-1"],
  });

  // 4. Next ingest check-in returns volume, mute, otaVersion, otaUrl, and one-time deviceToken
  const rep = await ingest(
    { id: "pod-futo-1", meta: { fw: "1.1", claim: "FUTO26" } },
    [{ ageMs: 0, dust: 14, air: 86, temp: 26.8, hum: 51 }],
  );
  assert.equal(rep.volume, 55);
  assert.equal(rep.mute, true);
  assert.equal(rep.otaVersion, "1.2.0");
  assert.equal(rep.otaUrl, "https://ecovital.vercel.app/fw/v1.2.0.bin");
  assert.equal(rep.deviceToken, cRes.deviceToken);

  // 5. Unclaim pod
  const uRes = await unclaimPod("pod-futo-1", "shamaryah");
  assert.equal(uRes.ok, true);

  // 6. Test 5-try lockout on wrong codes for a separate user
  for (let i = 0; i < 5; i++) {
    const bad = await claimPodByCode({ code: "ZZZZ99", userId: "intruder-user" });
    assert.equal(bad.ok, false);
  }
  const locked = await claimPodByCode({ code: "FUTO26", userId: "intruder-user" });
  assert.equal(locked.ok, false);
  assert.equal(locked.locked, true, "locked after 5 failed attempts");
});

test("Ask EcoVital honesty guard & 20-scenario AI evaluation suite", async () => {
  const co2Ans = await answerPodQuestion("What is the CO2 in ppm and PM2.5 in ug/m3?", {
    podId: DEMO_ID,
    podName: "Demo node",
    latest: { dust: 15, air: 85, temp: 27, hum: 50, ts: new Date().toISOString() },
    recentReadings: [],
    recentEvents: [],
  });
  assert.match(co2Ans.answer, /I don't have data for that/i);

  const medAns = await answerPodQuestion("Does this air cure asthma or diagnose bronchitis?", {
    podId: DEMO_ID,
    podName: "Demo node",
    latest: { dust: 15, air: 85, temp: 27, hum: 50, ts: new Date().toISOString() },
    recentReadings: [],
    recentEvents: [],
  });
  assert.match(medAns.answer, /cannot provide medical/i);

  const suite = await runAiEvaluationSuite();
  assert.equal(suite.total, 20);
  assert.equal(suite.passed, 20, "All 20 evaluation scenarios must pass length, metric, action, and honesty checks");

  const pred = await generateAiPredictions(DEMO_ID);
  assert.equal(pred.metrics.hum.predictions.length, 3, "Must predict +10m, +30m, and +60m horizons");
  assert.ok(pred.spokenForecast.length > 20, "Must provide a spoken AI forecast line");
  assert.ok(pred.learning.note.length > 10);
});

test("bad-key contact recorded", async () => {
  process.env.DEVICE_KEY = "evk_6450a3caa5e01e24638ef4e6";
  const auth = await verifyPodIngestKey({
    deviceId: "pod-badkey-1",
    providedKey: "wrong_key_123",
    claim: "BADK26",
    fw: "1.4",
  });
  assert.equal(auth.authorized, false);
  assert.equal(auth.status, 401);

  const sql = await db();
  const rows = await sql`SELECT device_id, claim, result, fw FROM pod_contact WHERE device_id = 'pod-badkey-1'`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].claim, "BADK26");
  assert.equal(rows[0].result, "bad-key");
  assert.equal(rows[0].fw, "1.4");
});

test("claim explains bad-key", async () => {
  const res = await claimPodByCode({
    code: "BADK26",
    userId: "user-checking-badkey",
  });
  assert.equal(res.ok, false);
  assert.ok(res.error);
  assert.match(res.error!, /not recognised/i);
});

test("shared key rejected after token confirmation", async () => {
  process.env.DEVICE_KEY = "evk_6450a3caa5e01e24638ef4e6";
  // 1. Pod connects with valid shared key and registers its claim code
  const auth1 = await verifyPodIngestKey({
    deviceId: "pod-tok-1",
    providedKey: "evk_6450a3caa5e01e24638ef4e6",
    claim: "TOKN26",
    fw: "1.4",
  });
  assert.equal(auth1.authorized, true);
  await ingest(
    { id: "pod-tok-1", name: "Token Test Pod", meta: { fw: "1.4", claim: "TOKN26" } },
    [{ ageMs: 0, dust: 10, air: 90, temp: 26, hum: 48 }],
  );

  // 2. Owner claims the pod -> receives private deviceToken
  const cRes = await claimPodByCode({ code: "TOKN26", userId: "token-owner" });
  assert.equal(cRes.ok, true);
  assert.ok(cRes.deviceToken);

  // 3. Before token confirmation, shared key still works (so pod can receive the token)
  const authBeforeConfirm = await verifyPodIngestKey({
    deviceId: "pod-tok-1",
    providedKey: "evk_6450a3caa5e01e24638ef4e6",
    claim: "TOKN26",
    fw: "1.4",
  });
  assert.equal(authBeforeConfirm.authorized, true);

  // 4. Pod authenticates once with its private deviceToken -> marks token_delivered = true
  const authWithToken = await verifyPodIngestKey({
    deviceId: "pod-tok-1",
    providedKey: cRes.deviceToken!,
    claim: "TOKN26",
    fw: "1.4",
  });
  assert.equal(authWithToken.authorized, true);

  // 5. Now the shared DEVICE_KEY is rejected for that pod
  const authSharedAfter = await verifyPodIngestKey({
    deviceId: "pod-tok-1",
    providedKey: "evk_6450a3caa5e01e24638ef4e6",
    claim: "TOKN26",
    fw: "1.4",
  });
  assert.equal(authSharedAfter.authorized, false);
  assert.equal(authSharedAfter.status, 401);
});

test("firmware upload rejects a file that does not start with 0xE9", async () => {
  const badBuf = Buffer.alloc(150_000, 0x00);
  badBuf[0] = 0x50; // 'P' (e.g. a ZIP archive instead of an ESP32 .ino.bin)
  const badRes = await uploadFirmwareBlob({
    version: "1.4",
    buf: badBuf,
    origin: "https://ecovital-phi.vercel.app",
  });
  assert.equal(badRes.ok, false);
  assert.equal(badRes.status, 400);
  assert.match(badRes.error ?? "", /0xE9/);

  const goodBuf = Buffer.alloc(150_000, 0x00);
  goodBuf[0] = 0xe9; // ESP32 magic byte
  const goodRes = await uploadFirmwareBlob({
    version: "1.4",
    buf: goodBuf,
    origin: "https://ecovital-phi.vercel.app",
    notes: "ESP32 v1.4 image",
  });
  assert.equal(goodRes.ok, true);
  assert.equal(goodRes.status, 200);
  assert.equal(goodRes.version, "1.4");
});



