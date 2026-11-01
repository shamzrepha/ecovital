# EcoVital

"Your air, explained out loud, with advice you can act on."

EcoVital pods (ESP32, dust + gas + temperature/humidity sensors, speaker) upload readings to this Next.js app. The app has a public business page, accounts, pod pairing, live dashboards, spoken-advice history, insights, an "Ask EcoVital" assistant, CSV export and an admin area for firmware updates.

## Pages

| Route | Who | What |
|---|---|---|
| `/` | public | Business page and "Get pods" request form (saved in the `leads` table) |
| `/signup`, `/login` | public | Email and password accounts. Only the owner email (`ROOT_ADMIN_EMAIL`) can be admin, and creating that account needs `ADMIN_SETUP_CODE`. |
| `/dashboard` | signed in | Your rooms: score, four live readings, last spoken advice, early warnings |
| `/add` | signed in | Add a pod: power on, enter the 6-character code, name it. It waits and checks automatically |
| `/node/[id]` | owner | Live charts, voice replay, thresholds, volume/mute, firmware, share link, remove pod |
| `/insights`, `/ask`, `/settings` | signed in | Daily insight and comparisons, grounded Q&A, profile, notifications, delete account |
| `/share/[token]` | anyone with the link | Read-only view of one pod (pair code and MAC are hidden) |
| `/admin` | admin | Publish firmware, download pre-configured pod firmware, fleet status, AI evaluation |

## How pairing works

1. The pod identifies itself with a unique ID from its chip and shows a random 6-character **pair code**. On first contact it enrolls itself with no key; the server hands it a private token that it stores and uses from then on.
2. On `/add` the user types the code. `GET /api/claim?code=` says whether the pod has been heard, was turned away for a wrong key, or already belongs to someone else. Checking never claims anything and does not count as a wrong guess.
3. `POST /api/claim` links the pod to the signed-in account and issues a private device token. The pod receives it on its next upload and stops using the shared key.
4. Wrong codes that no pod has ever announced count as failed claims: 5 in a row locks claiming for 10 minutes.

## Forecasts

`lib/forecast-ml.ts` trains a small ridge regression per reading and per horizon (+10, +30, +60 min) on the pod's last 7 days. Inputs are the rate of change over 5, 15 and 60 minutes, distance from the usual level, time of day, and (when the pod has a location) outside temperature, its expected change, humidity and rain chance from Open-Meteo. The model is used only if it beats "no change" and a damped-trend guess on held-out data; otherwise the better guess is used and labelled. Red flags (for example a room warming while it cools outside) are rule-based. The Ask assistant receives the same forecast. Everything forecast is labelled Estimate. A pod needs a location (set on the dashboard) to get weather.

## Honesty rules

- Dust and air are **relative indexes (0–100)**, never shown as µg/m³ or ppm.
- Values are labelled **Measured** or **Estimated**.
- Advice uses "may help" and "consider". No medical claims. The pod does not control fans or purifiers.

## Run it

```bash
npm install
npm test
npm run dev
```

With no `DATABASE_URL` (or `LOCAL_PGLITE=1`) it uses an in-process database that resets when the server stops. Copy `.env.example` for the settings below.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres |
| `DEVICE_KEY` | Shared key pods use until they are paired. Must match the key inside the pod firmware |
| `SESSION_SECRET` | Signs sign-in cookies. Set a long random value in production |
| `ROOT_ADMIN_EMAIL` | The one owner account (admin: publish firmware, see all users) |
| `ADMIN_SETUP_CODE` | Secret needed once to create the owner account |
| `GEMINI_API_KEY` | Optional. Without it the app speaks template advice |
| `NEXT_PUBLIC_DEMO` | Leave unset. `1` enables the `/api/demo` simulator for development only |

To fake a pod while developing: `node scripts/simulate.mjs http://localhost:3000 YOUR_DEVICE_KEY`.

## Tested and not tested

Tested by the automated suite and a local production build: validation, rules, forecasts, accounts and sessions, the pairing flow including bad key / taken / locked states, owner-only access, firmware upload checks, and the AI evaluation scenarios.

Not tested here: a real ESP32 on this version of the firmware, a live Neon database, live Gemini calls, and a Vercel deploy.
