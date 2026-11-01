<p align="center"><img src="assets/logo.png" alt="EcoVital logo" width="260"></p>

# EcoVital App: Build Brief for Antigravity

**Read this whole file first, then build.** It describes the product, the hardware it talks to, the API contract the pod already follows, the AI features to build, what competitors do, and what "done" means. A working, tested backend and web app already exists (see section 6). Extend it. Do not start from scratch.

Owner: Shamaryah (FUTO, Nigeria). First public showing: **AI Builders Pitch Party, FUTO, Wed 4 Nov 2026, 12:00**. The app must look finished, work on a phone, and survive a live demo.

---

## 1. What EcoVital is

EcoVital is a small classroom and home air-monitoring pod. It reads dust, air quality, temperature and humidity, shows them on a round-dial screen, and **talks**: it says what is wrong and what to do ("Humidity is low. The air is dry. Drink some water."), and says when things are fine again ("All good now. We are safe."). The app is the control room for one or many pods.

The product promise in one line: **"Your air, explained out loud, with advice you can act on."**

### Users
| Who | What they want |
|---|---|
| Teacher or parent (main user) | Know right now if the room is OK. Get told what to do. Not be spammed. |
| Student or curious user | See live charts, learn why the numbers change. |
| Owner/admin (Shamaryah, demo day) | Add pods fast, update firmware without touching the pod, show a live network map. |
| Judge at the pitch | Understand in 10 seconds. See a pod react live. |

---

## 2. Hardware and what the numbers really mean (be honest in the UI)

**Pod:** ESP32 DevKit, GP2Y1010AU0F dust sensor, MQ135 gas module, DHT22, ST7735 160x128 screen, MAX98357A amp with a 2 W speaker. No fan, no CO2 sensor, no PM2.5 sensor.

| Reading | What it is | What it is NOT |
|---|---|---|
| Dust (0-100) | Relative index from an optical sensor, against a clean-air baseline | Not PM2.5 or PM10 in ug/m3 |
| Air index (0-100, higher is cleaner) | Relative index from the MQ135 voltage | Not CO2 ppm, not a gas concentration, not calibrated |
| Temperature (C) | DHT22, about +/-0.5 C | |
| Humidity (%) | DHT22, about +/-2-5 % | |

**Rules for the whole app and every AI message:**
1. Never show a dust or air value with a real-world unit (ug/m3, ppm). Show them as an **index** with the info note.
2. Label every value as **Measured** (from a sensor) or **Estimated** (forecast, inferred, AI). Different visual treatment.
3. No medical claims. Say "may help" and "consider", never "this will cure" or "this is dangerous to your health".
4. No automatic fan or purifier control exists. Advice like "turn on the fan" is for a person to do. Show a "Needs extra hardware" badge for any feature that would need a fan driver, CO2 or PM2.5 sensor.
5. Demo and seeded data is always labelled **Simulated**.

Pod-side thresholds (same on the pod and server; make them editable per room profile in the app):

| Metric | Watch | Bad |
|---|---|---|
| Air index | below 70 | below 45 |
| Dust | above 35 | above 65 |
| Temperature | above 30 C or below 16 C | above 36 C |
| Humidity | above 68 % or below 30 % | above 82 % |

Hysteresis (how far back before an alert clears): air 3, dust 3, temperature 0.5, humidity 2.

---

## 3. How a pod joins the app (WLED-style pairing). Build this first.

The goal: **after the pod is flashed once, nobody touches it again.** Wi-Fi, naming, volume, mute, firmware updates and pairing all happen from the app.

### What the firmware already does (firmware v1.1, in `firmware/ecovital_pod/`)
- **Unique identity from the chip's MAC address:** `deviceId = ecovital-<last 3 MAC bytes in hex>`, e.g. `ecovital-a1b2c3`. Default name `EcoVital Pod A1B2`. Never changes, no flashing per pod.
- **Pair code:** 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I), random, generated once and stored on the pod. Shown on the pod's screen (BOOT button short press, and during start-up), on the pod's own web page, and sent to the cloud in every upload as `claim`.
- **Setup portal:** with no Wi-Fi saved (or Wi-Fi fails), the pod opens its own Wi-Fi called `EcoVital-XXXX` (open network). A captive page at `http://192.168.4.1/` lets the user type Wi-Fi name and password, plus cloud URL and device key. Saved to the pod's flash, then it restarts.
- **Local discovery:** mDNS hostname `<deviceId>.local`, service `_ecovital._tcp` port 80 with TXT records `id`, `fw`, `mac`. Local JSON at `http://<deviceId>.local/api/info` (id, name, mac, fw, claim, ip, ssid, rssi, uptime, cloud online, mute, volume, current readings, status codes). CORS open.
- **BOOT button:** short press shows the pairing screen for 15 s; hold 5 s forgets Wi-Fi and reboots into setup mode.
- **Updates:** cloud update (the pod downloads a `.bin` when told to, see 3.4) and LAN update (Arduino OTA, password = pair code).
- **Remote settings:** volume 0-100 and mute can be changed by the server in the reply to an upload.

### 3.1 Pairing flows the app must support
1. **Cloud claim by code (works everywhere, required).** User taps **Add pod**, types the 6-character code shown on the pod. The server finds the pod whose latest upload has `claim == code` and `claimed_by IS NULL`, sets `claimed_by = user`, then rotates nothing (the code stays for LAN OTA). Show a success screen with the pod's name and a first reading within 15 s. If no pod matches: "We have not heard from a pod with that code yet. Check the pod is on Wi-Fi (green dot in its header) and try again in 15 seconds."
2. **Nearby discovery (native app or Capacitor wrapper; optional in the plain web app).** Browsers cannot scan the LAN, and an HTTPS page cannot call `http://` pod addresses (mixed content). In a Capacitor/PWA-with-native-plugin build, browse `_ecovital._tcp`, read `/api/info`, and auto-fill the pair code so the user only taps **Add**. In the plain web app, skip this and say "Open the pod's own page" with a link to `http://<id>.local/`.
3. **First-time Wi-Fi setup guidance (web-friendly).** Step-by-step screen: "1. On your phone open Wi-Fi settings and join **EcoVital-XXXX**. 2. A setup page opens (if not, go to 192.168.4.1). 3. Pick your Wi-Fi and save. 4. Come back here and enter the pair code on the pod's screen."
4. **QR (nice to have):** the pod's local page could show a QR of `https://<app>/add?code=XXXXXX`. The app's `/add` route pre-fills the code.

### 3.2 Pod states to show
`Setup mode` (not on Wi-Fi) -> `Waiting for cloud` -> `Online` -> `Offline (last seen 4 min ago)`. Offline pods still speak advice locally (section 5.1), so say so: "This pod is offline but still giving spoken advice."

### 3.3 Unclaim and transfer
Owner can remove a pod. Removing sets `claimed_by = NULL` and flags the pod as claimable again. Document that a physical BOOT-button long press also resets the pod's Wi-Fi.

### 3.4 Firmware update (OTA) from the app
- Admin uploads a compiled `.bin` (Arduino IDE: Sketch > Export Compiled Binary) plus a version string, release notes and an optional "only these pods" filter. Store the file in Vercel Blob or GitHub Releases and keep only a URL in the database.
- In the reply to `POST /api/ingest` add `"otaVersion":"1.2","otaUrl":"https://.../ecovital_pod.bin"` for pods whose `meta.fw` differs from the target. The pod updates when it has no unsent readings and is not speaking, shows a progress bar on its screen, then restarts. The app shows `Updating... 62 %`, then `Up to date (v1.2)`.
- Show per-pod firmware version and a "Update all" button with a confirmation.
- **Known gap to fix in a later version:** the pod accepts any HTTPS certificate (`setInsecure()`) and the `.bin` is not signed. For the demo that is fine; list it under Security.

### 3.5 Remote settings from the app
Add to the same ingest reply when the user changes them: `"volume":0-100`, `"mute":true|false`. Pod stores them. Also let users rename the pod and set room, location and a room profile in the app (stored server-side; the pod does not need them).

---

## 4. Existing API contract (already built and tested against an in-process database)

All device calls send header `X-Device-Key: <DEVICE_KEY>` (one shared key today; see Security).

### `POST /api/ingest`
Request:
```json
{
  "deviceId": "ecovital-a1b2c3",
  "name": "EcoVital Pod A1B2",
  "location": "FUTO, Owerri, Nigeria",
  "lat": 5.385, "lng": 6.998,
  "fw": "1.1", "mac": "AA:BB:CC:A1:B2:C3", "claim": "K7Q2MX",
  "rssi": -58, "uptimeS": 5321, "mqReady": true,
  "readings": [
    { "ageMs": 12000, "dust": 12.0, "air": 88.0, "temp": 28.4, "hum": 61.0 },
    { "ageMs": 7000,  "dust": 13.0, "air": 87.0, "temp": 28.5, "hum": 60.0 }
  ]
}
```
- `ageMs` = how old the reading was when sent (the pod buffers about 10 minutes offline and sends the backlog when Wi-Fi returns).
- A field **omitted** means "not available yet" (for example the MQ135 is warming up for 60 s). A field set to **null** means "sensor read failed" (counted as a data-quality flag). Out-of-range or non-numeric values are rejected and flagged. Re-sending the same reading is safe (idempotent).

Response (today): `{ "ok": true, "accepted": n, "rejected": n, "speak": { "eventId": 41, "text": "...", "source": "gemini" | "template" } }`. `speak` is present only when the server wants the pod to talk. The pod then downloads `GET /api/tts/<eventId>` (raw 16-bit mono PCM at 24 kHz, about 5 s max) and plays it.

New optional fields to add to the response (pod ignores unknown ones): `volume`, `mute`, `otaVersion`, `otaUrl` (section 3).

### Other routes that exist
`GET /api/nodes` (all pods, latest values, status, online flag), `GET /api/nodes/<id>?range=1h|6h|24h|7d` (series, events, forecasts, scoring), `GET /api/tts/<eventId>[?fmt=wav]`, `POST /api/demo` (simulator for the Demo node), `scripts/simulate.mjs <base-url> <device-key> [node-id]`.

### Database (Neon Postgres, schema auto-created)
`devices(id, name, location, lat, lng, simulated, created_at, last_seen, meta jsonb, state jsonb)`, `readings(device_id, ts, dust, air, temp, hum, flags)`, `events(id, device_id, ts, kind, metric, status, severity, message, spoken, spoken_flag, source, data, audio_b64, outcome)`, `forecasts(id, device_id, metric, made_at, target_at, predicted, baseline, actual, confidence, trend, resolved, void)`.

`devices.meta` now also stores `mac` and `claim` from each upload.

### To add
```sql
users(id, email, name, created_at)
pods(device_id PK -> devices.id, claimed_by -> users.id, claimed_at, room_id, profile, volume, muted, nickname)
rooms(id, owner_id, name, type)               -- classroom | bedroom | lab | office | other
room_profiles / thresholds_override(pod, metric, watch, bad)   -- per-pod overrides
firmware_releases(id, version, url, notes, created_at, channel) -- stable | beta
pod_firmware_target(device_id, version)
push_subscriptions(user_id, endpoint, keys)
insights(id, device_id, period, created_at, summary_json, text)  -- daily/weekly AI summaries
chat_messages(id, user_id, device_id, role, text, ts, data_refs)
notifications_log(id, user_id, device_id, event_id, channel, sent_at)
```
Use per-pod device tokens (generated at claim time, returned to the pod in the ingest reply once) to replace the single shared key.

---

## 5. AI features to build (and how the AI must behave)

### 5.1 Two voices, one personality
- **Online:** the server rules engine decides *when* to speak (alert, early warning, recovered). Gemini writes the line from the **last 2 minutes of all four sensors**, current status, estimates and the pod's room profile. Gemini TTS turns it into audio; the pod plays it. If Gemini fails, a deterministic template line is used (already built).
- **Offline:** the pod has 15 pre-recorded advice clips and its own copy of the rules (same limits, 10 s confirmation, 2 min cooldown per metric, rapid-change detection). It decides and speaks on its own. If the cloud has not spoken within 35 s of a problem, the pod says its own clip. When the pod is online and the AI already spoke, the clip is dropped.
- Offline clips today: dust rising, dust high, air stale, air poor, warm, very hot, cold, temperature dropping rapidly, temperature rising rapidly, humidity high, humidity very high, air dry, dust jumping fast, all good, improving. The app should let the owner **preview** every clip and see the pod's transcript list.
- **Recovery:** "All good now. We are safe." when everything returns to normal; "That is improving. Keep going." when one reading improves while another is still off.
- **Tone:** calm, short (max 32 words), one action first. Always say what to do, not just what is wrong. Introduce forecasts as estimates ("looks like it may...").

### 5.2 Features (priority order)
**P0 (needed for the pitch)**
1. **Live pod page:** four live values with status words, a strip chart (1 h / 6 h / 24 h / 7 d) with threshold bands, event flags on the chart, and a big **"What the pod just said"** ribbon with a Replay button (calls `/api/tts/<id>?fmt=wav`).
2. **Event timeline:** every alert, early warning and recovery with time, the sentence spoken, whether it came from Gemini or the template, and a **Measured vs Estimated** tag.
3. **Pairing, rename, volume, mute, firmware update** (section 3).
4. **Network map and list** of all pods (already exists; keep Simulated labelled).
5. **Early-warning forecasts** with confidence, range and "reaches limit in about N min", scored against a "no change" baseline (already built). Show the **scoreboard**: "Our forecast beat the baseline 7 of 10 times." Never claim the system "learns by itself".

**P1**
6. **Room score** (0-100) per pod, in the style of Awair, built only from the four readings, with **adjustable weights** and a short "why" list. Colour plus word (Good, Fair, Poor) so it is not colour-only.
7. **Ask EcoVital (chat).** Grounded Q&A over the pod's data: "Why did the air index drop at 2 pm?", "Is it better with the window open?". The model gets a compact JSON of recent readings and events (never raw tables dumped), must cite the time ranges it used, must say "I don't have data for that" instead of guessing, and follows the honesty rules in section 2.
8. **Daily and weekly insight card** written by Gemini from computed statistics (you compute the numbers; the model only writes the words): worst hour, best hour, how many alerts, what changed versus yesterday, one suggestion. Push it as a notification each evening.
9. **"What changed?" view:** compare two time ranges or yesterday vs today (uHoo-style overlay charts).
10. **Web push notifications** (PWA) with the same deduplication as the pod: one alert per metric per 2 minutes, one early warning per 10, plus "recovered". Per-metric on/off and **quiet hours**.

**P2**
11. **Room profiles** that change thresholds and wording: Classroom, Bedroom, Nursery, Lab, Office. Netatmo-style profiles (baby, asthma/allergies, family) change what is flagged; unlike Netatmo, **let users edit thresholds**.
12. **Anomaly detection** with simple, explainable methods (rolling median and MAD, step detection). Always show *why* it flagged ("Dust is 3x above the last 6 hours' typical level").
13. **Pattern learning, honestly:** hour-of-day baselines per metric ("usually dusty at 10:00 when the room is swept"). Describe as "typical pattern", never as a trained model.
14. **Action library:** a table of condition -> advice -> "needs hardware?" so advice is consistent between the pod clips, the AI prompts and the app. Example: humidity above 68 -> "Turn on a fan or open a window" -> no hardware needed.
15. **Weather and harmattan context (optional):** if a weather API is allowed, add outdoor temperature and humidity to explain indoor changes. Label as outside data.
16. **Data export:** CSV download per pod and range (uHoo notably does not offer this; it is easy to be better).
17. **Shareable read-only link** for a classroom screen or a parent (Awair guest access, uHoo sharing).

### 5.3 AI prompt rules (keep and extend)
- Inputs: 2-minute window summary for all four sensors (min, max, mean, last, slope), statuses, the triggering rule, forecasts with confidence, room profile, language preference.
- Output: JSON `{ "line": "...", "tags": ["measured","estimate"], "action": "open_window|fan|ac|water|none" }` so the app can show an icon and the pod can pick a matching offline clip.
- Hard rules: max 32 words; first the action, then a short reason; call estimates "estimates"; do not name gases; do not give health diagnoses; do not mention numbers the data does not contain; if data is missing, say so.
- Keep a fixed **evaluation set** of 20 scenarios (dry air, dusty room, stuffy and humid, rapid temperature drop, sensor failure, recovery, offline flapping...) with the expected action. Run it whenever the prompt changes.
- Log every generated line with its inputs so a human can review. Never train on or store raw user chat without consent.

### 5.4 Voice settings
Voice name, speed and language options in the app. Nigerian English default. Consider Igbo, Yoruba and Hausa advice lines later (clips would need recording); for now make **text** available in those languages if the model is confident and mark as machine-translated.

---

## 6. What already exists (zip: `ecovital-web/`)

Next.js 16 App Router + React 19 + Recharts 3, deployable to Vercel. Neon Postgres. Gemini text (`gemini-3.8-flash`) and Gemini TTS (`gemini-3.8-flash-tts`, voice Kore) through REST. Local tests use an in-process Postgres (PGlite, `LOCAL_PGLITE=1`).

| Path | Purpose |
|---|---|
| `lib/config.ts` | Metric definitions, thresholds, hysteresis, status classification |
| `lib/validate.ts` | Reading validation (undefined = not available, null = sensor failed) |
| `lib/predict.ts` | 10-minute least-squares trend, confidence, ~90 % range, time to cross limit |
| `lib/rules.ts` | Alert, recovered, early-warning triggers, cooldowns |
| `lib/ai.ts` | Gemini line + TTS, template fallback, WAV helper |
| `lib/ingest.ts` | Full pipeline, forecast recording and scoring |
| `lib/queries.ts`, `lib/demo.ts`, `lib/db.ts` | Reads, simulator, database |
| `app/` and `components/` | Network page, pod page, strip chart, voice playback, demo panel |
| `scripts/simulate.mjs` | Fake pod for testing |
| `test/` | 15 automated tests (logic and end-to-end) |
| `firmware/ecovital_pod/` | Current pod firmware v1.1 and its asset headers |

**Tested:** validation, alert / no-repeat / recovery / early warning, 2-minute AI context with all four sensors, forecast scoring, idempotent re-send, seeded network, production build and type-check, UI in light, dark and mobile.
**Not yet tested live:** real Neon connection, live Gemini text and TTS calls, Vercel deploy, the pod firmware on hardware. Say so in the README and do not claim otherwise until you have run them.

Environment variables: `DATABASE_URL`, `DEVICE_KEY`, `GEMINI_API_KEY`, `GEMINI_TEXT_MODEL`, `GEMINI_TTS_MODEL`, `GEMINI_VOICE`, `NEXT_PUBLIC_DEMO=1` (shows simulator buttons; remove after the pitch). If a model name is rejected, change the env var, not the code.

---

## 7. Research: what other smart air monitors do (and what to take from them)

Sources fetched during this brief are linked. Anything not linked is general product knowledge, so verify before quoting it publicly.

### Awair (Element and Glow)
- Overall **Awair Score** plus a reading per factor, each colour-coded against ranges from WHO, EPA and ISO. **Custom score weighting** lets users decide how much each factor counts. **Tips** are personalised to the factor needing the most improvement. Trends: last day graph, swipe to 30 days, pin a moment to compare factors, landscape weekly view. Guest access to real-time data. Alerts exist but the help page marks push notifications as deprecated. ([Awair help](https://support.getawair.com/hc/en-us/articles/360039235533-Using-the-Awair-Home-App))
- **Take:** one headline score with a "why", per-factor colour, "fix the worst factor first" tip, editable weights, pin-and-compare on the chart. **Avoid:** dropping notifications.

### uHoo
- Nine sensors and **1-10 indices** (Mold, Virus, Influenza, Pollen, Discomfort, AQI) per room and per home. Insights: hourly today-vs-yesterday charts, weekly and monthly comparison, date comparison, time-of-day patterns, overlay charts for correlations, side-by-side rooms. Every alert has a plain-language explanation **and a suggested action**. IF/THEN **automations** (for example turn on ventilation when CO2 passes 1,000 ppm) work with Apple Home, Google Home, Alexa, SmartThings and Home Assistant. Household profiles tighten thresholds (kids). Paid tiers; the page does not mention data export. ([uHoo app](https://getuhoo.com/uhoo-app/))
- **Take:** alert = reason + action; compare-two-periods; overlays; per-room comparison; rules. **Avoid:** paywalling basics; no export.

### Airthings View Plus
- Seven sensors (radon, PM2.5, CO2, VOC, temperature, humidity, pressure) sampled every 5 minutes; always-on e-ink display with four custom values; glow indicator green/yellow/red; Wi-Fi with **Bluetooth for setup**; the unit doubles as a hub for other Airthings devices. Free app with guided setup, alerts, trends, colour-coded levels with **actionable next steps**; account needs only an email and name. Integrations: Alexa, Google Assistant, IFTTT, Homey. ([Airthings](https://airthings.com/view-plus))
- **Take:** guided setup, minimal sign-up (email + name), colour-coded levels with next steps, a physical glanceable status (the pod already has one: the screen and the voice).

### Netatmo Healthy Home Coach
- Room health shown as a colour-coded background, alert icons per parameter, **advice** on improving the room, **three profiles** (baby or toddler, asthma and allergies, whole family), push notifications for humidity, air, noise and temperature, history from one hour to a year, HomeKit, no subscription. A reviewer notes alert thresholds are fixed and cannot be customised. ([App Store listing](https://apps.apple.com/app/id1131510218))
- **Take:** profiles, whole-screen colour for glance reading, long history, free basics. **Avoid:** fixed thresholds.

### Others worth a look (not researched in depth here)
Qingping, IQAir AirVisual, Aqara and Dyson/Xiaomi purifier apps are common references for AQI display conventions and purifier control. Look at how they present outdoor vs indoor AQI and how they handle auto-mode switching.

### WLED (the discovery model the owner asked for)
WLED devices announce themselves on the local network (mDNS) with a unique name based on the MAC, host a setup Wi-Fi network and captive page when they have no Wi-Fi, expose a small JSON API, and update their own firmware from a web page. EcoVital firmware v1.1 follows the same ideas; the app adds the cloud account layer on top.

### Standards to use for default ranges (verify the exact numbers before publishing)
Awair says it uses WHO, EPA and ISO ranges; common indoor guidance is **humidity roughly 30-60 %** (EPA suggests 30-50 %), **comfortable temperature roughly 20-26 C** (ASHRAE 55 style), **CO2 under about 1,000 ppm** as a ventilation marker, and WHO's 2021 PM2.5 guideline of 15 ug/m3 over 24 hours (5 ug/m3 annual). EcoVital's own limits (section 2) are tuned to a Nigerian classroom (warmer, humid, harmattan dust). Dust and air are **indexes**, so cannot be compared with these numbers directly.

### Where EcoVital can beat them
1. **It talks.** Spoken, actionable advice in the room, online and offline.
2. **Honest forecasts** with a visible scoreboard against a simple baseline.
3. **Editable thresholds** and weights (Netatmo's complaint).
4. **Free export and sharing** (uHoo gap).
5. **Zero-touch pods:** pair by code, update over the air, no reflashing.
6. **Built for the place:** Nigerian classroom, harmattan dust, power and Wi-Fi that drop (the pod buffers and still advises offline).

---

## 8. Screens and UX

**Brand:** use the logo in `assets/logo.png` (green leaf and globe, a white air-purifier pod, "Eco" and "Vital" in green italic). Sample the greens and the globe blue from the image for tokens rather than guessing. Approximate palette: deep green `#0F6B2A`, leaf green `#1E9B3C`, light leaf `#7CCB4A`, globe blue `#1F5F8F`, clean white. Keep the existing **strip-chart recorder** look for charts (threshold bands, dashed forecast, event flags). Support light and dark. System fonts or one considered web font.

**Navigation (mobile first, bottom tabs):** Home, Pods, Insights, Ask, Settings.

1. **Welcome / sign in:** logo, email magic link or Google, one sentence of value. Name and email only.
2. **Add a pod (wizard):** 4 steps (power on, join pod Wi-Fi if needed, enter the pair code, name and place it). Live progress ("Waiting for the pod... heard it!"). A skip link to the Demo node for judges.
3. **Home:** one big status sentence for the main room ("Dust is a little high in Room 4"), the room score, four live tiles, the last thing the pod said with Replay, and offline/online state. Colour **and** word.
4. **Pod detail:** strip chart with range tabs, forecast band, event flags; "Measured / Estimated" legend; event timeline; scoreboard; settings (name, room, profile, volume slider, mute, firmware).
5. **Insights:** daily/weekly summary cards, time-of-day pattern, compare periods, correlation overlay, export CSV.
6. **Ask EcoVital:** chat with suggested questions, sources shown as small chips ("used 14:00-15:00 readings").
7. **Network:** map + list of pods (owner's own pods; an opt-in public map for the demo with Simulated labels).
8. **Settings:** profile, thresholds editor with reset to defaults, notifications and quiet hours, language, data export, delete account and data.
9. **Admin (owner only):** firmware releases, rollout, per-pod versions, fleet health, simulate button (hidden when `NEXT_PUBLIC_DEMO` is off).

Empty, loading and error states are part of the build. Errors say what happened and what to do, without apologising. Keyboard focus visible, `prefers-reduced-motion` respected, 16 px minimum side gutter, works at 400 px width.

---

## 9. Security and privacy
- Per-pod device tokens issued at claim time; rotate on unclaim. Today there is one shared `DEVICE_KEY`.
- The local pod API shows the pair code to anyone on the same Wi-Fi (proximity pairing, like WLED). Document it. A BOOT-button long press resets the pod's Wi-Fi.
- OTA: pods currently accept any HTTPS certificate and the `.bin` is unsigned. Next step: pin the server certificate or verify a signature.
- Rate-limit `/api/ingest`, `/api/tts`, chat and claim attempts (claim codes are 32^6 possibilities; lock a pod after 5 wrong tries from one user).
- Store only what is needed (email, name, readings). Offer delete-my-data. Do not log chat text to third parties without consent. Never put API keys in the browser.

---

## 10. Build order for the next three days
**Day 1 (pairing and truth):** deploy backend to Vercel + Neon, set env vars, flash the pod, confirm a real reading, a real spoken alert and a replay in the browser. Add users (magic link), `pods` table, claim-by-code, rename, volume, mute. Add `otaVersion/otaUrl` and `volume/mute` to the ingest reply.
**Day 2 (the demo experience):** polished Home and Pod detail, event timeline, Replay, forecast scoreboard, notifications, firmware update screen, room score. Run the 20-scenario AI evaluation.
**Day 3 (pitch hardening):** Ask EcoVital and daily insight, offline-mode story ("unplug Wi-Fi, still talks"), fallbacks for every network call, demo script rehearsed, Simulated labels checked, `NEXT_PUBLIC_DEMO` decision, backup video.

### Demo script (3 minutes)
1. Show the pod boot (logo, welcome voice). 2. Open the app, add the pod by its code (live). 3. Breathe on the humidity sensor or use the Demo node: the pod speaks the AI line and the app shows the ribbon and the timeline. 4. Turn off the hotspot: the pod still speaks its offline advice. 5. Turn it back on: it says "All good now" and the backlog uploads. 6. Show the forecast scoreboard and say plainly it is a baseline, not magic. 7. Push a firmware update from the app (if time).

---

## 11. Acceptance checklist (do not mark done until true)
- [ ] A new pod appears in the app after entering its pair code, with no code changes and no reflashing.
- [ ] Pod name, volume and mute changed in the app take effect within one upload (15 s).
- [ ] A real alert produces a Gemini line, TTS audio, pod playback, a timeline entry and a push notification, exactly once.
- [ ] Gemini failure still produces a spoken template line.
- [ ] Wi-Fi off: pod speaks offline clips; back on: backlog uploads and no duplicate readings.
- [ ] Firmware update completes from the app and the pod reports the new version.
- [ ] Every value is labelled Measured or Estimated; dust and air are never shown in real-world units.
- [ ] No feature claims fan control, CO2 or PM2.5 without that hardware.
- [ ] Forecast scoreboard matches stored results and the baseline comparison.
- [ ] All screens usable at 400 px width, light and dark, keyboard focus visible.
- [ ] 15 existing tests still pass; new tests added for claim, OTA reply and permissions.

## 12. Honest status and limits
- The pod firmware v1.1 was written without a compiler available. **It has not been compiled or run on hardware as of this brief.** Expect small compile fixes. Select **Tools > Partition Scheme > Minimal SPIFFS (1.9MB APP with OTA)** in the Arduino IDE (the voice clips use about 0.5 MB). If the build says the sketch is too big, switch to Huge APP, which has no OTA, and tell the owner.
- Gemini text and TTS response parsing was written defensively but **has not been run against the live API**.
- Forecasts are straight-line trends, not machine-learned models.
- Offline clips and the welcome voice were generated with an offline speech model and have not been listened to by the author of this brief; the owner should check them.

## 13. Pod quick reference (for support screens)
Serial commands (115200 baud): `c` calibrate in clean air, `t` test beep, `a` play next offline clip, `v` replay last cloud voice, `i` status, `p` pairing info, `w` forget Wi-Fi.
Pins: screen CS 15, DC 2, RST 4, SCK 18, MOSI 23; DHT22 13; MQ135 GPIO34 (divider); dust Vo GPIO35 (divider), dust LED GPIO27; amp DIN 22, BCLK 26, LRC 25; BOOT button GPIO0.
