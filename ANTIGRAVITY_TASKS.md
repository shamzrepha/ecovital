# EcoVital: what Antigravity must do now

Read this first. It explains the pod cloud changes already in this zip and what is left to finish and verify.
Nothing here needs new ideas: the code is written and tested locally (17 unit tests pass, `tsc` is clean, and the flows below were run against a local server). It has NOT been tested on a real ESP32 or on Vercel.

## 1. The problem to fix first

The pod (firmware 1.3, or older) never shows the green cloud status, and pairing says "the server has not heard from the pod".

Cause: firmware 1.3 ships with `DEFAULT_BASE = https://your-app.vercel.app` and a placeholder `DEFAULT_KEY`, so it never reaches `https://ecovital-phi.vercel.app`. Even with the right address, the server rejects it unless the pod's key equals the `DEVICE_KEY` environment variable on Vercel.

Fix, in this order:
1. Merge/deploy this zip's code (see section 4).
2. On Vercel (Project > Settings > Environment Variables) set `DEVICE_KEY` = `evk_6450a3caa5e01e24638ef4e6` for Production, then redeploy. (This is the key compiled into firmware 1.4. If the owner prefers another value, the same value must go into `DEFAULT_KEY` in `firmware/ecovital_pod/ecovital_pod.ino` and the pod must be re-flashed, or entered on the pod's Settings page.)
3. Pod side, no re-flash needed for a pod already running 1.3: open the pod's own page at `http://<IP shown at the bottom of its screen>` > Settings, set App address `https://ecovital-phi.vercel.app` and Device key `evk_6450a3caa5e01e24638ef4e6`, then Save. The pod restarts and connects. (Pods on firmware older than 1.3 only have the setup page: join the `EcoVital-XXXX` Wi-Fi, open 192.168.4.1, same fields.)
4. Open `https://ecovital-phi.vercel.app/api/health`. It shows `deviceKeyConfigured`, the database state, and the last pods that contacted the server with `result: "ok"` or `"bad-key"`. If the pod is listed with `bad-key`, the key does not match. If it is not listed at all, the pod has not reached the server (wrong address, no internet, or old firmware).
5. In the Add Pod wizard, enter the 6-character pair code shown on the pod's screen (not its ID). The wizard now explains `bad-key` and "not heard" separately.

## 2. What changed (all already in the code)

| Area | File | Change |
|---|---|---|
| Auth | `app/api/ingest/route.ts` | Pod authenticates with the shared `DEVICE_KEY` until claimed. After claim the server issues a private `deviceToken`; once the pod uses it, the shared key no longer works for that pod. The token is re-sent in every reply until the pod proves it has it. |
| Diagnostics | `lib/pods.ts` (`noteContact`), `lib/db.ts` (`pod_contact`) | Every pod contact, including rejected ones, is recorded with the pod's claim code, so `claimPodByCode` can say "reaching the server but key rejected". |
| Health | `app/api/health/route.ts` | New. Config flags (no secrets) and recent pod contacts. |
| Firmware upload | `app/api/ota/upload/route.ts`, `app/api/firmware/[file]/route.ts`, `lib/db.ts` (`firmware_blobs`) | Upload the compiled `.ino.bin` on the Admin page; stored in Postgres as base64, served at `/api/firmware/<version>.bin` with `Content-Length`, queued for pods. Limit 4.4 MB (Vercel body limit 4.5 MB). Image must start with byte 0xE9. |
| Admin security | `lib/auth.ts`, `app/api/ota/route.ts`, `app/admin/page.tsx` | Publishing firmware needs the `x-admin-key` header (`ADMIN_KEY`, or `DEVICE_KEY` if `ADMIN_KEY` is unset). The Admin page has an Admin key field. |
| Download | `app/api/download/firmware/route.ts`, `app/download/page.tsx` | Downloads `ecovital_pod.zip` (sketch folder with its 3 header files) pre-set to the site address and key. `?file=ino` gives only the sketch. Set `EMBED_DEVICE_KEY=0` to stop embedding the key. |
| Firmware | `firmware/ecovital_pod/ecovital_pod.ino` (v1.4) | Site address built in, stores the private token, falls back to the setup key if the token is rejected (e.g. after unclaim), protects against OTA update loops, retries failed OTA after 5 min. Wi-Fi defaults are placeholders. |

Pod behaviour that the app should rely on (already implemented in firmware):
- A pod stores readings while offline (about 1 hour) and uploads them in batches of 24 with `ageMs` (milliseconds old). The server places them at their original time.
- The pod keeps judging readings, speaking offline alerts, and forecasting while offline.
- The ingest reply carries `volume`, `mute`, `deviceToken` (once), `otaVersion` and `otaUrl`. The pod applies them.
- Pod local API on the LAN (optional for the app, not needed for monitoring): `GET http://<pod-ip>/api/live` (readings, status, advice, forecast, wifi, backlog; add `?trend=1` for the last hour). Pairing and monitoring must NOT depend on it: the phone talks only to the cloud.

## 3. Tasks for Antigravity

Do these, and keep the honesty rules in `README.md` (dust and air are relative indexes, never µg/m³ or ppm; label estimates; demo data is badged Simulated).

1. **Deploy and verify the fix in section 1.** Report what `/api/health` shows after the pod restarts. A healthy result: `deviceKeyConfigured: true`, `database: "ok"`, and the pod listed with `result: "ok"`.
2. **Pairing wizard UX** (`app/add/page.tsx`): show the `/api/claim` error text as returned (it is written for users). Poll `/api/health`-style status or retry automatically every 5 s for up to 60 s after the user enters the code, with a visible "Waiting for your pod to connect" state. Show where to find the code (pod screen, press BOOT briefly to show it again for 30 s).
3. **Pod status in the app:** show green "Online" when the last reading is under 60 s old, amber "Offline, N readings saved on the pod will arrive when it reconnects" when older, with the time of the last reading. Show firmware version (`meta.fw`) and signal (`meta.rssi`) on the pod page.
4. **Admin page:** after the upload succeeds, show per-pod status ("Queued", "Updating", "Updated to X") from `pod_firmware_target` and `meta.fw`. Add a one-line guide: Arduino IDE > Sketch > Export Compiled Binary > upload the file ending `.ino.bin`. The version typed here must equal `FW_VERSION` inside that firmware, or the pod will report a different version after updating.
5. **Settings sync:** name, room profile, volume and mute changed in the app must reach the pod on its next upload (volume and mute already do). Add pod rename to the pod's reply only if firmware support is added; do not claim it works today.
6. **Mobile/PWA:** keep it installable and usable from anywhere over the internet; push alerts for new events when the app is closed (the repo has `push_subscriptions`; finish and test the send path, with the quiet-hours setting honoured).
7. **Insights and AI:** continue to use the last readings of all four sensors, include the pod's local advice context only as an extra hint, and fall back to templates when Gemini is unavailable. Keep the existing 20-scenario evaluation passing.
8. Keep `npm test` (17 tests) and `npx tsc --noEmit` green and add tests for: bad-key contact recorded, claim explains bad-key, shared key rejected after token confirmation, firmware upload rejects a file that does not start with 0xE9.

## 4. How to apply this zip

This zip is the full repository (without `node_modules`, `.next` and `.git`). The same changes are on the GitHub branch `pod-cloud-seamless` of `shamzrepha/ecovital`. Easiest: merge that branch into `main`, or copy this zip's files over the repo, then run `.\deploy.ps1`.

## 5. Pod firmware, for reference

- File: `firmware/ecovital_pod/ecovital_pod.ino` plus `logo.h`, `welcome.h`, `clips.h` in the same folder. Arduino-ESP32 core 3.x. Tools > Partition Scheme > Minimal SPIFFS (1.9MB APP with OTA).
- The owner flashes it once over USB. After that, updates come from the Admin page.
- Not yet verified on hardware: compile on every core version, OTA end to end, voice clip quality.

---

# Round 2: Nigerian-language voice and a live Voice Center

Already in the repo (do not rebuild): a per-user language setting (`en-NG`, `ig`, `yo`, `ha`), Gemini text translation in `lib/ai.ts` (`translatedText`, `translateFallback`), Gemini speech in `lib/ai.ts` (`synthesize`), event audio at `/api/tts/<eventId>`, the Ask page (`/api/ask`, `answerPodQuestion`), and pod speech through the ingest reply (`speak.eventId`).

Be honest in the UI and docs: machine-translated text and synthetic speech in Igbo, Yoruba, Hausa and Pidgin can be wrong. Keep the existing "Machine translated" badge until a native speaker has reviewed the wording. Do not claim medical benefits. Dust and air stay relative indexes.

## A. Pod voice in Igbo and Pidgin (needs the pod online)

1. Add Nigerian Pidgin, language code `pcm`, to the language list in `app/settings/page.tsx`, `app/api/user/route.ts`, `lib/ai.ts` types and the eval suite.
2. Make language **per pod**: add `language text` to `pods` (default: the owner's user language), editable on the pod page and in `updatePodSettings`. `ingest` must use the pod's language when it writes the line. The pod itself plays whatever audio the server gives it, so no firmware change is needed.
3. Prompt rules for `pcm`: short everyday Nigerian Pidgin ("Dust don plenty for here. Open window or put fan on."). One sentence, same advice actions as English (`open_window`, `fan`, `ac`, `water`, `close_window`). Keep numbers and units as in English.
4. Add `translateFallback` strings for `pcm` for every trigger, so Pidgin still works with no Gemini key.
5. **Speech quality check (must do before the pitch):** generate the same line in `en-NG`, `pcm`, `ig`, `yo`, `ha` with the current Gemini TTS model and play each one to a native speaker.
   - If a language sounds wrong or unintelligible, do not ship it silently. Options, in order: (a) have the pod and web play the English voice with the translated text shown on screen; (b) route that language to a dedicated TTS (for Igbo, Meta MMS-TTS `facebook/mms-tts-ibo` is one candidate to evaluate; confirm it exists and its licence before using it) behind an env flag; (c) keep that language text-only.
   - Record the result per language in `README.md`.
6. The pod's 15 offline clips stay English. Say so on the pod page: "Offline alerts are in English; other languages need Wi-Fi."
7. Eval suite: keep the existing Igbo scenario passing and add one for `pcm`.

## B. Voice Center (talk to EcoVital, it talks back)

New page `/voice` (add to the nav and bottom bar), plus `POST /api/voice`.

1. UI: pod picker, language picker (English, Pidgin, Igbo, Yoruba, Hausa), a large push-to-talk mic button (hold or tap to start, tap to stop), a stop-speaking button, and a running transcript where each answer shows its source badges (Measured / Estimated) and a Machine translated badge when not English. Typed input stays available. Clear states: mic permission denied, no speech heard, offline, server error.
2. Speech to text: record with `MediaRecorder` (webm/opus or mp4 on Safari), send to `/api/voice` as raw audio (limit 4 MB, about 60 s). Do not rely on the browser `SpeechRecognition` API for Igbo or Pidgin; it does not cover them. On the server, let Gemini transcribe and answer in one call using the audio input, with the chosen language as a hint. If the transcript is empty or low confidence, say so and ask the user to repeat; never invent a question.
3. Answer: reuse `answerPodQuestion` (grounded in the pod's real readings, events and forecasts, with citations). Reply in the chosen language. Refuse medical claims and ug/m3 or ppm claims as the Ask page already does.
4. Voice out: return the answer text plus audio (same `synthesize` path as events; cache by hash). Play it in the browser; show a captions line while it plays. Respect the user's mute setting.
5. "Say it on the pod" button: queues the answer as a spoken event for the pod so the physical pod speaks it on its next check-in (about 15 s). Respect pod mute and quiet hours.
6. Live streaming (nice to have, after the above works): use the Gemini Live API with short-lived tokens issued by `/api/voice/token`, never expose `GEMINI_API_KEY` to the browser.
7. Privacy: audio is not stored; keep only the transcript in `chat_messages`. Rate limit `/api/voice` per user.
8. Tests: audio too large or empty returns 4xx; answers carry citations; language falls back to English when unsupported; no key exposed in client bundles.

## C. Definition of done for Round 2

- A pod set to Pidgin speaks a Pidgin line after a real event, or clearly falls back to English audio with Pidgin text.
- Voice Center answers a spoken question about the live pod and speaks the reply, in at least English and Pidgin end to end.
- Per-language speech quality results are written down. `npm test` and `npx tsc --noEmit` pass.

---

# Round 3: gas / fumes alarm (firmware 2.1)

Done by Claude, already in this branch and tested locally (21/21 tests, `tsc` clean):
- Firmware 2.1 detects a fast drop of the air index (15 points below its slow baseline, or under 40, for 1 s). The pod then flashes a red warning screen, plays a siren and the spoken air warning every 25 s, uploads immediately with `"alarm":"gas"`, and clears 10 s after the air recovers. Serial command `g` runs a 20 s test alarm.
- `POST /api/ingest` with `alarm: "gas"` creates one `alert` event per 2 minutes (`data.alarm = "gas"`) and a `notifications_log` row. `GET /api/alarms` lists alarms from the last 3 minutes. `components/GasAlarm.tsx` (mounted in `AppShell`) shows a red banner with a siren and a browser notification while the app is open.

Honest limits to keep in the UI: the MQ135 reacts to many gases and fumes but cannot identify them, and this is NOT a certified gas-leak detector. The wording is "possible gas or fumes". Thresholds (`GAS_DROP_POINTS`, `GAS_LOW_LEVEL` in the firmware) must be tuned on the real pod with the lighter test.

Still to do:
1. **Real background push.** Today `notifications_log` rows are written but nothing sends them to a phone that has the app closed. Implement Web Push: `web-push` package, VAPID keys in env (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`), a subscribe flow on the Settings page that stores into `push_subscriptions`, a `push` handler in `public/sw.js`, and sending for every `notifications_log` row (gas alarms first, never during quiet hours except gas alarms). iPhone needs the app added to the Home Screen. Say clearly in the UI when push is not enabled.
2. Add an alarm history list on the pod page (time, value, cleared time) and a "Test alarm" button that sends a clearly labelled test.
3. Tests: alarm event is created once per 2 minutes; `/api/alarms` returns only recent alarms; ingest without the flag creates none.
