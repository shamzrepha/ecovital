import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateLine, answerPodQuestion, type AiContext } from "../lib/ai.ts";
import { aiStats, resetModelCache } from "../lib/gemini-models.ts";

const originalFetch = global.fetch;
const originalKey = process.env.GEMINI_API_KEY;

const sampleCtx: AiContext = {
  deviceName: "Test Pod",
  trigger: {
    kind: "alert",
    metric: "air",
    status: "watch-low",
    prevStatus: "ok",
    value: 65,
    priority: 80,
  },
  summaries: {
    air: { n: 12, first: 75, last: 65, min: 65, max: 75, avg: 70, change: -10 },
  },
  statuses: { air: "watch-low" },
  forecasts: {},
};

beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-mock-gemini-key";
  resetModelCache();
  aiStats.lastError = "";
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey) process.env.GEMINI_API_KEY = originalKey;
  else delete process.env.GEMINI_API_KEY;
  resetModelCache();
});

test("mock fetch: valid JSON line from Gemini returns gemini source, action, and tags", async () => {
  global.fetch = (async (url: any) => {
    const s = String(url);
    if (s.includes("models?pageSize=")) {
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["generateContent"] }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              line: "Air index has dropped to 65 percent. Open a window for fresh airflow.",
              tags: ["measured"],
              action: "open_window",
            }),
          }],
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;

  const res = await generateLine(sampleCtx);
  assert.equal(res.source, "gemini");
  assert.equal(res.action, "open_window");
  assert.deepEqual(res.tags, ["measured"]);
  assert.ok(res.text.includes("65 percent"));
});

test("mock fetch: malformed JSON from Gemini falls back to the deterministic template", async () => {
  global.fetch = (async (url: any) => {
    const s = String(url);
    if (s.includes("models?pageSize=")) {
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["generateContent"] }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Return garbage text that is not valid JSON
    return new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: "This is invalid JSON output { broken line: not json " }],
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;

  const res = await generateLine(sampleCtx);
  assert.equal(res.source, "template");
  assert.ok(!res.text.includes("broken line"));
  assert.ok(res.text.includes("Air index has dropped to 65 percent"));
  assert.ok(res.action === "open_window");
});

test("mock fetch: HTTP 429 and HTTP 500 error falls back to template and records error", async () => {
  global.fetch = (async (url: any) => {
    const s = String(url);
    if (s.includes("models?pageSize=")) {
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["generateContent"] }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("Resource has been exhausted (rate limit)", { status: 429, statusText: "Too Many Requests" });
  }) as any;

  const res = await generateLine(sampleCtx);
  assert.equal(res.source, "template");
  assert.ok(res.error);
  assert.ok(res.error.includes("429") || res.error.includes("exhausted"));
  assert.ok(res.text.includes("Air index has dropped to 65 percent"));
});

test("mock fetch: network timeout (AbortError) falls back to template", async () => {
  global.fetch = (async (url: any) => {
    const s = String(url);
    if (s.includes("models?pageSize=")) {
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["generateContent"] }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  }) as any;

  const res = await generateLine(sampleCtx);
  assert.equal(res.source, "template");
  assert.ok(res.error);
  assert.ok(res.error.includes("timed out") || res.error.includes("aborted"));
});

test("mock fetch: honesty guards hold: unsupported sensors (CO2/PM2.5) and medical claims are rejected", async () => {
  // Even if Gemini key is set, unsupported queries or medical diagnosis are caught by honesty guard
  const qCO2 = await answerPodQuestion("What is the exact CO2 ppm level and PM2.5 in the room?", {
    podName: "Lab 1",
    latest: { air: 85, dust: 20, temp: 25, hum: 50 },
  });
  assert.equal(qCO2.source, "template");
  assert.ok(!qCO2.answer.includes("µg/m³") && !qCO2.answer.includes("ppm"));
  assert.ok(qCO2.answer.includes("does not have a calibrated CO₂ or PM2.5 sensor"));
  assert.ok(qCO2.citations.includes("sensor & medical honesty guard"));

  const qMedical = await answerPodQuestion("Can this cure my child's asthma attack or diagnose disease?", {
    podName: "Clinic Room",
    latest: { air: 85, dust: 20, temp: 25, hum: 50 },
  });
  assert.equal(qMedical.source, "template");
  assert.ok(qMedical.answer.includes("cannot provide medical advice or diagnosis"));
});
