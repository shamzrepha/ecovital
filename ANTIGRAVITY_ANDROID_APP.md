# Antigravity: build the real EcoVital Android app (with a ringing alarm)

Read this whole file first. Goal: an installable Android app (APK) for the EcoVital web app at https://ecovital-phi.vercel.app that **rings like an alarm on the phone, even when the app is closed and the phone is locked**, when a pod reports smoke, gas or very bad air. Web Push cannot do that, so this is a native layer around the existing app.

Deadline: the AI Builders Pitch Party is Wed 4 Nov 2026, 12:00. A working debug APK that rings on a real phone matters more than polish. Build in the order below and stop adding features once Part C passes.

## Facts about the existing system (do not break these)

- Web app: Next.js on Vercel, repo `shamzrepha/ecovital`, branch `main`. Auth is a signed HttpOnly session cookie (`ecovital_session`, see `lib/session.ts`). Routes live in `app/api/*`: `auth/login`, `auth/me`, `nodes`, `pods/[id]`, `pods/[id]/sos`, `ask`, `voice`, `push` (Web Push, VAPID keys kept in table `push_config`), `health`.
- Alerts are created in `lib/ingest.ts`. Gas/smoke/bad-air alerts call `sendPushToUser(...)` in `lib/push.ts` with `isGasAlarm: true`. Normal alerts use `isGasAlarm: false` and respect quiet hours; gas alarms ignore quiet hours.
- Honesty rules stay: air and dust are relative 0-100 indexes, never ug/m3 or ppm. The MQ135 cannot identify a gas. Say "possible gas or fumes" or "smoke or burning likely", never a named gas, and make no medical claims.
- Do not rewrite or reformat unrelated files. Keep `npm test` and `npx tsc --noEmit` green. Commit small, push to a branch `android-app`, and merge to `main` only when Part B passes on the deployed site.

## Part A: backend (small, do first)

1. **Table** `fcm_tokens (id bigserial, user_id text, token text unique, platform text, created_at, last_seen)` in `lib/db.ts` (same `CREATE TABLE IF NOT EXISTS` style).
2. **Route** `POST /api/fcm` (signed-in user via `requireUser`): saves `{token}`; `DELETE /api/fcm` removes it. Return `{ok:true}`.
3. **Sender**: add `lib/fcm.ts` using the FCM HTTP v1 API with a service account in env `FIREBASE_SERVICE_ACCOUNT_JSON` (create a NEW Firebase project for the app; do not reuse the robot project). Get the OAuth token with `google-auth-library` or a signed JWT; cache it. If the env var is missing, do nothing and report `fcmConfigured:false` in `/api/health`. Remove tokens that return `UNREGISTERED`/404.
4. **Send alongside Web Push**: inside `sendPushToUser` also call FCM for the same user (or all tokens when `userId` is null). Use a **data-only, high-priority** message, never a `notification` message, so the app always gets control:
   ```json
   { "message": { "token": "...", "android": { "priority": "HIGH", "ttl": "3600s" },
     "data": { "type": "alarm" | "alert", "title": "...", "body": "...", "podId": "...", "cause": "smoke|gas|dust|stuffy", "ts": "..." } } }
   ```
   `type: "alarm"` exactly when `isGasAlarm` is true.
5. **Test route** `POST /api/fcm/test` sends a sample `alarm` to the signed-in user.
6. Add `fcmConfigured` and `fcmPhones` (count) to `/api/health`. Add a node test with `fetch` mocked: alarm sends `type:alarm`; a non-gas alert sends `type:alert`; a dead token is deleted.

## Part B: Android app (Kotlin, in a new folder `android/`)

Approach: a **thin native shell**. A full-screen `WebView` loads the live site (so every web feature stays identical), and the native code adds only what the web cannot do: ringing alarm, notifications, and a native test button. Do not rebuild the UI in Compose.

- `applicationId com.ecovital.app`, minSdk 26, targetSdk 35, Kotlin, Gradle. Add the Firebase BoM, `firebase-messaging`. The user will add `google-services.json`; document where it goes and make the build clear if it is missing.
- **MainActivity**: WebView, JavaScript on, DOM storage on, cookies kept (`CookieManager.setAcceptCookie(true)`, keep third-party off), back button navigates history, pull-to-refresh, offline page "No connection. Retrying...". Load `https://ecovital-phi.vercel.app/dashboard`. Open external links in the browser. Keep the user signed in across restarts (the 30-day cookie must survive; flush cookies on pause).
- **Register the phone**: after sign-in is detected (call `/api/auth/me` through the WebView cookie), get the FCM token and `POST /api/fcm` with the session cookie. Re-send when the token refreshes. Expose a tiny `AndroidBridge` JS interface so the settings page can show "Phone alarm: on" and a **Test alarm** button that calls `/api/fcm/test`.
- **EcoFirebaseMessagingService** (`onMessageReceived`, data messages only):
  - `type=alert`: normal notification on channel `alerts` (IMPORTANCE_HIGH, default sound). Tap opens the pod page.
  - `type=alarm`: start `AlarmService` (a foreground service, type `mediaPlayback`/`specialUse`, started from the FCM callback which is allowed to start it) and post a **full-screen intent** notification on channel `alarm` (IMPORTANCE_HIGH, `AudioAttributes.USAGE_ALARM`, `CATEGORY_ALARM`, `setFullScreenIntent`, ongoing, visibility PUBLIC).
- **AlarmService**: plays a looping siren (bundle a royalty-free or self-generated two-tone siren in `res/raw`) on the **alarm audio stream** at the user's alarm volume (offer "raise to max while ringing" in settings, default on), vibrates in a repeating pattern, holds a partial wake lock, auto-stops after 5 minutes or on dismiss. Mute-switch and silent mode do not stop the alarm stream.
- **AlarmActivity** (shown over the lock screen: `setShowWhenLocked(true)`, `setTurnScreenOn(true)`, requests keyguard dismissal): big red screen with the pod name, the cause line ("Smoke or burning likely" / "Possible gas or fumes"), the advice ("Open windows, put out flames, leave if you smell gas"), a **Stop alarm** button and an **Open pod** button. Stopping silences it for that alert only.
- **Permissions and first-run flow** (one screen, plain language): `POST_NOTIFICATIONS` (Android 13+), full-screen intent permission (Android 14+: `canUseFullScreenIntent`, deep link to its settings page), ignore battery optimisation (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`), and optional Do Not Disturb access (`ACCESS_NOTIFICATION_POLICY`) so alarms may sound in DND. Show which ones are still missing and re-check on resume. Say clearly that Samsung/Xiaomi/Tecno/Infinix phones may need "Auto-start" and "No battery restrictions" turned on, with a link that opens that settings screen where possible.
- Quiet hours: alarms (`type=alarm`) always ring. `type=alert` follows the server's rules (the server already decides).
- Icons: reuse `public/assets/logo.png`. App name "EcoVital".

## Part C: acceptance tests (run on a real phone, record results in a table at the bottom of this file)

1. Fresh install, sign in, permissions screen shows all green.
2. **Test alarm** from the app: with the app open, then in the background, then swiped away, then with the screen locked, then phone on silent. It must ring and show the full-screen alarm each time. Record which phone models and Android versions.
3. Real path: with the pod on, hold a lighter's gas (unlit) near the MQ135, or use the pod's serial `g` test. The phone must ring within about 15 seconds of the pod alarm.
4. Server down for FCM (wrong credentials): the app and Web Push still work, and `/api/health` shows `fcmConfigured:false`.
5. Sign out removes the token (`DELETE /api/fcm`) so a signed-out phone does not ring.

## Part D: build and ship

- `./gradlew assembleDebug` must produce `android/app/build/outputs/apk/debug/app-debug.apk`. Add a short `android/README.md`: how to open in Android Studio, where to put `google-services.json`, how to install by USB (`adb install -r`), and how to sideload from a link.
- If time allows: a signed release build and an `assetlinks`-free link on `/download` ("Get the Android app") pointing to the APK. Never commit keystores or `google-services.json` with real keys to a public repo without the owner's OK; say what you did in the README.

## Do not

- Do not name a specific gas, give ppm/ug/m3 numbers, or give medical advice in alarm text.
- Do not claim it works until Part C is recorded on a real phone.
- Do not touch the pod firmware (`firmware/`) or the voice/AI code in this task.

## Results (fill in)

| Test | Phone / Android version | Result | Date |
|---|---|---|---|
| 1 Permissions | | | |
| 2 Test alarm: open / background / swiped away / locked / silent | | | |
| 3 Real pod alarm to phone ring | | | |
| 4 FCM off, others still work | | | |
| 5 Sign-out stops ringing | | | |
