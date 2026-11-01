"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

export default function DownloadAppPage() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [installed, setInstalled] = useState(false);
  const [origin, setOrigin] = useState("https://ecovital.vercel.app");

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
      const handler = (e: any) => {
        e.preventDefault();
        setDeferredPrompt(e);
      };
      window.addEventListener("beforeinstallprompt", handler);
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      }
      return () => window.removeEventListener("beforeinstallprompt", handler);
    }
  }, []);

  async function installPwa() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      setInstalled(true);
      setDeferredPrompt(null);
    }
  }

  return (
    <div className="wrap">
      <header className="top">
        <span className="brand">Download EcoVital App &amp; Physical Pod Firmware</span>
        <span className="crumb">Use on the web or install the mobile/desktop app &amp; ESP32 pod firmware</span>
        <span className="spacer" />
        <Link className="btn small" href="/">
          ← Back to Live Web Dashboard
        </Link>
      </header>

      <div className="hero">
        <h1>Use EcoVital on the Web, or Download the App to Your Device</h1>
        <p>
          Connected remotely to Vercel &amp; Firebase/Neon cloud (<code>{origin}</code>). Install the mobile/desktop app for instant home-screen access and push alerts, or download the standalone companion app and ESP32 physical pod firmware.
        </p>
      </div>

      <div className="grid-2">
        {/* Card 1: Mobile & Desktop App Download / Install */}
        <section className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>📲 1. Download EcoVital Mobile / Desktop App</h2>
            <span className="tag-measured">Android · iOS · Windows · Mac</span>
          </div>
          <p style={{ color: "var(--ink2)", fontSize: 14.5 }}>
            Download the standalone <b>EcoVital Remote Companion App</b> (runs directly on your phone or laptop and streams live sensor readings &amp; AI predictions from <code>{origin}</code>) or install the native-feel Progressive Web App to your home screen.
          </p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14, marginBottom: 14 }}>
            <a className="btn primary" href="/api/download/app" download="EcoVital-Remote-App.html">
              ⬇ Download Companion App (EcoVital-Remote-App.html)
            </a>

            {deferredPrompt && !installed && (
              <button type="button" className="btn" onClick={installPwa}>
                📲 Install App to Home Screen (1-Click PWA)
              </button>
            )}
            {installed && <span className="chip good">✓ Installed on this device</span>}
          </div>

          <div
            style={{
              background: "var(--panel-alt)",
              border: "1px solid var(--rule)",
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 13,
            }}
          >
            <b>How to install on your phone:</b>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              <li>
                <b>Android (Chrome / Edge):</b> Tap <b>Download Companion App</b> above, or tap the browser menu (⋮) →{" "}
                <b>Install App / Add to Home Screen</b>.
              </li>
              <li>
                <b>iPhone / iPad (Safari):</b> Tap the Share icon (↑) → <b>Add to Home Screen</b> to launch EcoVital full-screen like a native app.
              </li>
            </ul>
          </div>
        </section>

        {/* Card 2: Physical ESP32 Pod Firmware Download */}
        <section className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>🔌 2. Download Physical ESP32 Pod Firmware</h2>
            <span className="chip">v1.1 · WLED-Style AP + OTA</span>
          </div>
          <p style={{ color: "var(--ink2)", fontSize: 14.5 }}>
            Flashing a physical EcoVital pod? Download the complete Arduino/ESP32 firmware (<code>ecovital_pod.ino</code>) pre-configured for this cloud server (<code>{origin}</code>), with 15 offline voice clips, captive portal Wi-Fi setup (<code>EcoVital-XXXX</code>), and 6-character pair code.
          </p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14, marginBottom: 14 }}>
            <a className="btn primary" href="/api/download/firmware" download="ecovital_pod.ino">
              ⬇ Download ESP32 Firmware (ecovital_pod.ino)
            </a>
            <Link className="btn" href="/add">
              ＋ Open 6-Char Pair Code Wizard →
            </Link>
          </div>

          <div
            style={{
              background: "var(--panel-alt)",
              border: "1px solid var(--rule)",
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 13,
            }}
          >
            <b>Remote Cloud + Physical Pod Sync:</b>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              <li>
                <b>Remote Ingestion:</b> Your physical pod posts readings to <code>{origin}/api/ingest</code> every 15 seconds.
              </li>
              <li>
                <b>Remote Speaker &amp; OTA Control:</b> Adjust speaker volume, mute, room profile, or push `.bin` OTA updates from anywhere in the world via the web or downloaded app.
              </li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
