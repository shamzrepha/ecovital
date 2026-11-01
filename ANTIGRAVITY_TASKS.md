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
