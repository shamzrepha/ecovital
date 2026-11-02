// Choosing Gemini models from what the API key can actually use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickText, pickTts, type ModelInfo } from "../lib/gemini-models.ts";

const gc = (name: string): ModelInfo => ({ name, methods: ["generateContent", "countTokens"] });

test("Gemini 3.1 Flash-Lite is chosen first when the key can use it", () => {
  const list = [gc("gemini-2.5-flash"), gc("gemini-2.5-flash-lite"), gc("gemini-3.1-flash-lite-preview"), gc("gemini-3.1-flash-lite"), gc("gemini-3-flash-preview")];
  assert.equal(pickText(list)[0], "gemini-3.1-flash-lite");     // the plain name beats the preview name
  assert.ok(pickText(list).includes("gemini-2.5-flash-lite"));     // and the others stay as backups
});

test("a preview-only 3.1 Flash-Lite is still preferred over 2.5", () => {
  const list = [gc("gemini-2.5-flash"), gc("gemini-2.5-flash-lite"), gc("gemini-3.1-flash-lite-preview-09-2026")];
  assert.equal(pickText(list)[0], "gemini-3.1-flash-lite-preview-09-2026");
});

test("a saved model name that does not exist is ignored, and speech/image models are never used for text", () => {
  const list = [gc("gemini-2.5-flash"), gc("gemini-3.1-flash-lite"), gc("gemini-2.5-flash-preview-tts"), gc("gemini-2.5-flash-image")];
  const picks = pickText(list, "gemini-3.8-flash");
  assert.ok(!picks.includes("gemini-3.8-flash"));
  assert.ok(!picks.some((m) => /tts|image/.test(m)));
  assert.equal(picks[0], "gemini-3.1-flash-lite");
});

test("if Google cannot be asked, the order still starts with 3.1 Flash-Lite", () => {
  assert.equal(pickText(null)[0], "gemini-3.1-flash-lite");
});

test("the newest speech model is chosen", () => {
  const list = [gc("gemini-2.5-flash-preview-tts"), gc("gemini-2.5-pro-preview-tts"), gc("gemini-3.1-flash-tts-preview"), gc("gemini-2.5-flash")];
  assert.equal(pickTts(list)[0], "gemini-3.1-flash-tts-preview");
  assert.deepEqual(pickTts(null), ["gemini-2.5-flash-preview-tts"]);
});
