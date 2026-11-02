// Languages for the pod's voice, and short replies in Ask.
process.env.LOCAL_PGLITE = "1";
delete process.env.GEMINI_API_KEY;

import { test } from "node:test";
import assert from "node:assert/strict";
import { runScenario, DEMO_ID } from "../lib/demo.ts";
import { db } from "../lib/db.ts";
import { answerPodQuestion, LANGS, normLang, translateFallback } from "../lib/ai.ts";

test("language codes are checked and Pidgin has built-in fallback lines", () => {
  assert.equal(normLang("pcm"), "pcm");
  assert.equal(normLang("klingon"), "en-NG");
  assert.equal(normLang(undefined), "en-NG");
  assert.ok(LANGS.ig.machine && LANGS.pcm.machine && !LANGS["en-NG"].machine);
  const t = { kind: "alert", metric: "hum", status: "watch-low", prevStatus: "ok", value: 25, priority: 80 } as any;
  assert.match(translateFallback(t, "pcm")!, /dry|water/i);
  assert.ok(translateFallback(t, "ig"));
  assert.equal(translateFallback(t, "en-NG"), undefined);
});

test("a pod set to Pidgin speaks the Pidgin line and keeps English for the screen", async () => {
  await runScenario("reset");
  await runScenario("normal");
  const sql = await db();
  await sql`UPDATE pods SET voice_lang = 'pcm' WHERE device_id = ${DEMO_ID}`;
  const out = await runScenario("dry");
  assert.ok(out.result?.speak, "the dry-air alert must still speak");
  const rows = await sql`SELECT spoken, data FROM events WHERE id = ${out.result!.speak!.eventId}`;
  const data = rows[0].data;
  assert.equal(data.language, "pcm");
  assert.ok(data.spokenText && /di |dey|don/i.test(data.spokenText), `spokenText: ${data.spokenText}`);
  assert.match(rows[0].spoken, /humidity/i, "the English line stays for the screen");
});

test("a pod with no language set speaks English (nothing to translate)", async () => {
  await runScenario("reset");
  await runScenario("normal");
  const sql = await db();
  await sql`UPDATE pods SET voice_lang = NULL WHERE device_id = ${DEMO_ID}`;
  const out = await runScenario("dry");
  const rows = await sql`SELECT data FROM events WHERE id = ${out.result!.speak!.eventId}`;
  assert.equal(rows[0].data.spokenText, null);
});

const base = {
  deviceName: "Room 4", profile: "classroom",
  latest: { dust: 12, air: 88, temp: 30.5, hum: 40 },
  hourlyBuckets: [], recentEvents: [], forecasts: {},
  prediction: { stale: false, headline: "Temperature may become warm in about 20 minutes.", redFlags: [], suggestion: "Open windows on opposite sides, or switch on a fan or the AC." },
};

test("Ask: 'yes' to a follow-up question carries on instead of starting over", async () => {
  const history = [
    { role: "user" as const, text: "How is the room?" },
    { role: "assistant" as const, text: "The room feels fine. Would you like to know what the temperature will do next?" },
  ];
  const out = await answerPodQuestion({
    ...base, question: "yes", history,
    followUp: { answer: "yes", question: "Would you like to know what the temperature will do next?" },
  });
  assert.match(out.answer, /may become warm in about 20 minutes/i);
  assert.match(out.answer, /estimate/i);
  assert.doesNotMatch(out.answer, /what is the room like at another time|check another time of day/i);
});

test("Ask: 'no' to a follow-up ends politely", async () => {
  const out = await answerPodQuestion({
    ...base, question: "no", history: [{ role: "assistant", text: "Want tips?" }],
    followUp: { answer: "no", question: "Want tips?" },
  });
  assert.match(out.answer, /no problem/i);
});
