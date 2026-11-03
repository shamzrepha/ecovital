# Antigravity: fix the AI, speech and voice parts of EcoVital

Written for the owner (Shamaryah) to hand to Antigravity. Do these in order. Keep `npm test` and `npx tsc --noEmit` green. Do not claim anything works until it was run with a real Gemini key on the deployed site and the result is written in the "Results" table at the bottom of this file.

## 0. What is known right now (facts from the live site)

- `https://ecovital-phi.vercel.app/api/health` returned `geminiConfigured: false`. So no AI line, no AI answer and no Gemini voice can work on the live site yet. Everything currently runs on the template fallbacks.
- The Ask page had no speech input. A browser-based mic and "Read answers aloud" were added (`components/useSpeech.ts`, `app/ask/page.tsx`). It has not been tested on a real phone.
- The full Voice Center (`/voice`, `POST /api/voice`) and Nigerian-language voice (Pidgin, Igbo, Yoruba, Hausa) are NOT built. They are specified in `ANTIGRAVITY_TASKS.md`, "Round 2".
- Nothing here has been tested with a real Gemini key.

## 1. Make the AI work at all (do this first)

1. In Vercel (Production env), set `GEMINI_API_KEY` (Google AI Studio key). Redeploy. Confirm `/api/health` shows `geminiConfigured: true`.
2. **Verify every model name against the current official Gemini API docs and the `models.list` call before trusting it.** The code defaults are inconsistent and may be wrong:
   - `lib/ai.ts` text: `GEMINI_TEXT_MODEL || "gemini-3.8-flash"`
   - `lib/ai-predict.ts` text: `GEMINI_TEXT_MODEL || "gemini-2.5-flash"`
   - `lib/ai.ts` speech: `GEMINI_TTS_MODEL || "gemini-3.8-flash-tts"`, calling `https://generativelanguage.googleapis.com/v1beta/interactions`
   Pick one text model and one TTS model that exist for this key, use the documented endpoint and request shape for TTS, put both in env with the SAME default everywhere, and update `.env.example`. If a model or endpoint does not exist, fix it, do not leave a silent fallback.
3. Send the API key in the `x-goog-api-key` header everywhere. `lib/ai-predict.ts` puts it in the URL query string, which leaks it into logs.
4. Make failures visible, not silent: when Gemini fails, keep the template fallback, but record the real error (status and first 200 chars) in `ai_logs` and show "AI unavailable, using built-in advice" with a badge in the app. Add the last Gemini error and a `geminiLastOkAt` time to `/api/health`.
5. Add a server test that mocks `fetch` for Gemini and checks: valid JSON line, malformed JSON falls back to the template, HTTP 429/500 falls back, timeout falls back, and the honesty guards still hold (no µg/m³ or ppm, no medical claims).
6. Run the existing 20-scenario evaluation against the live model and put the pass count in the Results table.

## 2. Speech input (talk to the app)

1. Test the new mic on the Ask page on: Chrome Android, Chrome desktop, Edge, Safari iPhone, Firefox. Record what works. Where it does not work, show the existing message and keep typing available.
2. Browser recognition does not cover Igbo or Pidgin reliably. Build `POST /api/voice` as in `ANTIGRAVITY_TASKS.md` Round 2 section B: record with `MediaRecorder`, send audio (limit 4 MB), have Gemini transcribe and answer using the pod's real data, return text plus audio. If `GEMINI_API_KEY` is missing, return a clear 503 and the page falls back to the browser recognizer.
3. Empty or low-confidence transcript: say "I did not catch that, please repeat". Never invent a question.
4. Do not store audio. Store only the transcript in `chat_messages`. Rate limit per user.

## 3. Speech output (the app and the pod talk)

1. Web: `useVoice` plays `/api/tts/<eventId>?fmt=wav` and falls back to the browser voice. Test that the fallback really plays when Gemini TTS is unavailable, and that browsers that block autoplay show a "Tap to hear" button instead of failing silently.
2. Pod: the pod plays `/api/tts/<eventId>` (raw 16-bit mono PCM at 24 kHz) when the ingest reply contains `speak.eventId`. Confirm the endpoint returns exactly that format and a correct `Content-Length`, and that audio is cached in `events.audio_b64`. If TTS fails, the reply must still be valid and the pod falls back to its own built-in clip (it does this after 35 s).
3. Add per-language quality check: generate the same line in `en-NG`, `pcm`, `ig`, `yo`, `ha`, have a native speaker listen, and record the verdict. If a language sounds wrong, do not ship it silently: show the translated text and use the English voice (or an evaluated dedicated TTS for that language behind an env flag). Write the verdict per language in the Results table.
4. Per-pod language (`pods.language`) and Nigerian Pidgin (`pcm`) are specified in `ANTIGRAVITY_TASKS.md` Round 2 section A.

## 4. Real phone alerts (BUILT, needs a real-phone test)

Web Push is now in the code: `lib/push.ts` (VAPID keys from env `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, or made once and kept in table `push_config`), `/api/push/key|subscribe|test`, `components/PushToggle.tsx` on Settings, `push`/`notificationclick` in `public/sw.js`, and sends from `lib/ingest.ts` (gas alarm always, bad/early alerts outside quiet hours). Do not rewrite it. Test it on Android Chrome with the app closed and on an iPhone installed to the home screen, then fix only what fails. Web Push cannot play a custom looping alarm sound; it uses the phone's notification sound plus long vibration. A true ringing alarm needs a native app.

## 5. Acceptance checklist (all must be shown working on the deployed site)

- [ ] `/api/health` shows `geminiConfigured: true` and a recent `geminiLastOkAt`.
- [ ] A real pod event produces an AI-written line (`source` is the AI, not "template") and its audio plays on the web and on the pod.
- [ ] Ask page: typed question answered; spoken question answered; answer read aloud.
- [ ] Voice Center `/voice`: spoken question about the live pod answered in voice, in English and Pidgin.
- [ ] Gemini failure (wrong key) shows the "using built-in advice" badge and the app still works.
- [ ] Gas alarm: banner, siren and a phone notification with the app closed.
- [ ] `npm test` and `npx tsc --noEmit` pass; new tests added for sections 1 and 2.

## Results (fill in)

| Item | Result | Date |
|---|---|---|
| Gemini key set, health shows true | | |
| Text model / TTS model chosen | | |
| 20-scenario eval pass count | | |
| Mic works: Chrome Android / desktop / Safari iPhone | | |
| Voice quality: English / Pidgin / Igbo / Yoruba / Hausa | | |
| Web push on closed app | | |
