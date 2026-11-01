# EcoVital — Cloud Dashboard, AI Voice & Pod Firmware

**"Your air, explained out loud, with advice you can act on."**
Built for the **AI Builders Pitch Party, FUTO (Nigeria), Wed 4 Nov 2026**.

## Architecture Overview
Pod (ESP32 v1.1) → `POST /api/ingest` → Neon Postgres (or local PGlite) → Rules & Room Profile Thresholds → 10-min Linear Trend Forecast → Gemini 1-sentence Spoken Guidance (or deterministic template fallback) → Gemini TTS (`/api/tts/<id>`) or 15 built-in 12 kHz mu-law offline clips (`clips.h`).
The `POST /api/ingest` response also delivers remote settings (`volume`, `mute`), over-the-air firmware updates (`otaVersion`, `otaUrl`), and a per-pod `deviceToken` upon pairing.

## What Was Tested & What Was Not (Honesty Report)
- **Tested (17 automated unit & end-to-end tests in `test/logic.test.ts` and `test/e2e.test.ts` against in-process PGlite Postgres + Next.js 16 production build):**
  - Sensor validation, threshold classification with hysteresis, alert cooldowns, recovery speech, and early-warning linear trend forecasting.
  - 2-minute AI context packing across all 4 sensors.
  - WLED-style 6-character pair code claiming (`POST /api/claim`), 5-try lockout rate-limiting, and unclaiming (`DELETE /api/claim`).
  - Remote `volume`, `mute`, `otaVersion`, `otaUrl`, and one-time `deviceToken` returned in `POST /api/ingest`.
  - Awair-style Room Score (0–100), custom thresholds, rolling median/MAD anomaly detection, Ask EcoVital sensor/medical honesty guard, and the 20-scenario AI evaluation suite (`20/20 PASS`).
- **Not tested in sandbox (say these out loud if asked):**
  - Physical ESP32 compilation and live sensor/speaker hardware wiring (verify in order: sensors → serial `test` clip → Wi-Fi AP `EcoVital-XXXX` → cloud upload → OTA).
  - Live Gemini API network calls when `GEMINI_API_KEY` is omitted (deterministic template fallback is verified and always active).

## Non-Negotiable Honesty & Hardware Rules
1. **No fake units:** Dust (`0–100%`) and Air index (`0–100%`, higher is cleaner) are relative uncalibrated sensor indexes and are never displayed as `µg/m³` or `ppm`.
2. **Measured vs Estimated:** Every sensor value, chart line, event, and AI insight is explicitly badged **Measured** (from a sensor) or **Estimated** (forecast, pattern, or AI synthesis).
3. **No medical claims:** Advice uses practical comfort language (*"may help"*, *"consider opening a window"*), never medical diagnosis or cure claims.
4. **Hardware honesty:** Features requiring a fan relay, NDIR CO₂ sensor, or laser PM2.5 sensor are badged **Needs extra hardware** in the Action Library.
5. **Simulated badge:** All demo and seeded city nodes are badged **Simulated**.

## Key Screens & Routes
- `/` — **Home & Network Map:** Active Room Score (0–100) ring, 4 Measured sensor tiles, spoken ribbon, world map, and node table.
- `/add` (`?code=XXXXXX`) — **4-Step Pairing Wizard:** Power on, join `EcoVital-XXXX` (`192.168.4.1`), enter 6-char pair code (or test with `DEMO26`), and choose a Room Profile (`Classroom`, `Bedroom`, `Nursery`, `Sensitive/Asthma`, `Lab`, `Office`).
- `/node/[id]` — **Live Pod Dashboard & Settings:** 1h/6h/24h/7d strip charts with custom threshold bands, anomaly alerts, early-warning forecast scoreboard (*"Our forecast beat the baseline X of Y times"*), 15 playable offline pod clips (`/api/clips/[id]`), Action Library, remote volume/mute, custom threshold editor, CSV export, and read-only share link.
- `/insights` — **Insights & "What Changed?":** Daily/weekly AI digests, Today vs Yesterday hourly comparison, sensor correlation overlay, and typical hour-of-day pattern bars.
- `/ask` — **Ask EcoVital:** Grounded Q&A over pod readings and events with time-range citations and sensor/medical honesty guards.
- `/settings` — **Settings & Languages:** Account profile, Nigerian English + Igbo / Yoruba / Hausa machine-translated text lines, Web Push notifications, quiet hours, CSV export, and account deletion.
- `/admin` — **Admin, OTA & AI Eval:** Publish ESP32 `.bin` OTA releases (`POST /api/ota`), view fleet targets, and run the 20-scenario AI evaluation suite (`POST /api/eval`).
- `/share/[token]` — **Read-Only Shared View** for teachers, students, or parents.

## Quick Start
```bash
npm install
npm test
npm run dev
```
Set `LOCAL_PGLITE=1` and `NEXT_PUBLIC_DEMO=1` in `.env.local` for zero-config local development, or configure `DATABASE_URL` (Neon Postgres), `DEVICE_KEY`, and `GEMINI_API_KEY` for production deployment on Vercel.
