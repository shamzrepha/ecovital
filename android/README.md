# EcoVital Android Native Companion App

This directory contains the native Android companion shell for [EcoVital](https://ecovital-phi.vercel.app).

## Architecture

- **Thin Native Shell**: Loads the live dashboard in a full-screen, cookie-persisting `WebView`.
- **FCM Data-Only High Priority Messaging**: Pierces silent mode and wakes the phone when smoke, gas, or hazardous air is detected.
- **Lock-Screen Emergency Siren (`AlarmService`)**: Plays a looping hi-lo siren (`R.raw.siren`) on the Android `USAGE_ALARM` audio stream, maximizes alarm volume, vibrates in an emergency cadence, and acquires a wake lock.
- **Over-the-Keyguard Emergency Screen (`AlarmActivity`)**: Displays over the lock screen with `setShowWhenLocked(true)` and `setTurnScreenOn(true)`, showing the affected pod, cause, safety instructions, a **Stop Alarm** button, and an **Open Pod** button.
- **JS Bridge (`AndroidBridge`)**: Connects the web UI to the native shell for alarm status detection and instant siren testing.

---

## Prerequisites

- **Java JDK**: JDK 17 or higher (Android Studio bundled JBR recommended).
- **Android SDK**: Compile SDK 35, Min SDK 26 (Android 8.0 Oreo or later).
- **Android Studio**: Android Studio Koala / Ladybug or newer.

---

## Firebase Setup (`google-services.json`)

To receive push alarms on a real phone:
1. Create a Firebase project in the [Firebase Console](https://console.firebase.google.com).
2. Add an Android app with Package Name: `com.ecovital.app`.
3. Download `google-services.json` and place it at:
   ```
   android/app/google-services.json
   ```
4. In Project Settings > Service Accounts, generate a new private key and set the environment variable on your server/Vercel:
   ```
   FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}'
   ```
*(A starter placeholder template is included in `android/app/google-services.json` to allow offline Gradle compilation).*

---

## Building the APK

From the `android/` directory:

```bash
# On Windows
.\gradlew.bat assembleDebug

# On macOS / Linux
./gradlew assembleDebug
```

The compiled APK will be output to:
```
android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Installing on a Device

### 1. Via USB Debugging (ADB)
Connect your Android phone via USB with Developer Options and USB Debugging enabled:
```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### 2. Sideloading from Browser / Direct Download
1. Navigate to `/download` on your deployed EcoVital web app (`https://ecovital-phi.vercel.app/download`).
2. Tap **Download Android APK**.
3. Open the downloaded file, allow installation from your browser if prompted, and tap **Install**.

---

## First Run & Required Permissions

When launching the app for the first time, the `PermissionsActivity` will guide you through granting:
1. **Notifications** (`POST_NOTIFICATIONS` on Android 13+).
2. **Display Over Lock Screen** (`USE_FULL_SCREEN_INTENT` on Android 14+).
3. **Ignore Battery Optimization** (Excludes EcoVital from system deep-sleep battery killers).
4. **Do Not Disturb Access** (Optional: allows alarms to sound during DND mode).

### OEM Notes (Samsung, Xiaomi, Tecno, Infinix)
For devices with aggressive background app termination:
- Enable **Auto-start** for EcoVital in phone settings.
- Set **App battery usage** to **Unrestricted** / **No restrictions**.
