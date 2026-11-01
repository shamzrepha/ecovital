"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ROOM_PROFILES, type RoomProfileKey } from "@/lib/config";

function AddPodWizardInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const prefill = (searchParams.get("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);

  const [step, setStep] = useState<number>(prefill.length === 6 ? 3 : 1);
  const [code, setCode] = useState(prefill || "");
  const [nickname, setNickname] = useState("My Classroom Pod");
  const [location, setLocation] = useState("FUTO Hall 2");
  const [roomProfile, setRoomProfile] = useState<RoomProfileKey>("classroom");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [claimedPod, setClaimedPod] = useState<{ podId: string; deviceToken?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (prefill && prefill.length === 6) {
      setCode(prefill);
      setStep(3);
    }
  }, [prefill]);

  async function seedAndUseDemoCode() {
    setBusy(true);
    setErrorMsg("");
    setStatusMsg("Starting simulated demo pod with pair code DEMO26...");
    try {
      await fetch("/api/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: "normal" }),
      });
      setCode("DEMO26");
      setStep(3);
      setStatusMsg("Demo pod is now broadcasting pair code DEMO26. Click 'Pair & Claim Pod' below!");
    } catch (e: any) {
      setErrorMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleClaim(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrorMsg("");
    setStatusMsg("Checking pair code with EcoVital cloud...");
    try {
      const res = await fetch("/api/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: code.trim().toUpperCase(),
          nickname,
          location,
          roomProfile,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) {
        setErrorMsg(j.error || "Could not claim pod.");
        setStatusMsg("");
      } else {
        setClaimedPod({ podId: j.podId, deviceToken: j.deviceToken });
        setStatusMsg(`Pod "${j.podId}" paired and configured!`);
        setStep(4);
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Network error");
      setStatusMsg("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <header className="top">
        <span className="brand">Add &amp; Pair an EcoVital Pod</span>
        <span className="crumb">WLED-style Wi-Fi portal + 6-character pair code</span>
        <span className="spacer" />
        <Link className="btn small" href="/node/demo-node">
          Skip to Demo Pod →
        </Link>
      </header>

      {/* Stepper indicator */}
      <div className="tabs" style={{ marginBottom: 18 }}>
        {[
          { n: 1, label: "1. Power on pod" },
          { n: 2, label: "2. Connect pod to Wi-Fi" },
          { n: 3, label: "3. Enter 6-char pair code" },
          { n: 4, label: "4. Room profile & ready" },
        ].map((s) => (
          <button
            key={s.n}
            type="button"
            className="btn small"
            aria-pressed={step === s.n}
            onClick={() => setStep(s.n)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {errorMsg && <div className="banner">{errorMsg}</div>}
      {statusMsg && <div className="banner info">{statusMsg}</div>}

      <div className="cols">
        <main>
          {step === 1 && (
            <div className="card">
              <h2>Step 1 — Power on your EcoVital Pod</h2>
              <p>
                Plug your EcoVital ESP32 pod into a 5 V USB power supply. Within 3 seconds the OLED screen lights up, the RGB LED glows, and the speaker announces <i>&ldquo;EcoVital ready&rdquo;</i>.
              </p>
              <ul style={{ lineHeight: 1.65 }}>
                <li>
                  <b>Works out of the box without Wi-Fi:</b> Even before you pair it, the pod reads its 4 sensors and speaks all 15 built-in offline voice clips locally.
                </li>
                <li>
                  <b>Find your 6-character pair code:</b> Look at the bottom of the pod&rsquo;s OLED screen, on the `EcoVital-XXXX` setup page, or type <code>code</code> over USB serial (115200 baud).
                </li>
              </ul>
              <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
                <button className="btn primary" onClick={() => setStep(2)}>
                  Next: Connect pod to Wi-Fi →
                </button>
                <button className="btn" onClick={() => setStep(3)}>
                  Pod is already on Wi-Fi (Enter code) →
                </button>
                <button className="btn" disabled={busy} onClick={seedAndUseDemoCode}>
                  Testing without hardware? Use Demo Code (DEMO26)
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="card">
              <h2>Step 2 — Connect the Pod to Wi-Fi (WLED-Style Captive Portal)</h2>
              <ol style={{ lineHeight: 1.75 }}>
                <li>
                  On your phone or laptop, open Wi-Fi settings and join the network named{" "}
                  <code>EcoVital-XXXX</code> (where <code>XXXX</code> are the last 4 characters of your pod).
                </li>
                <li>
                  A setup page opens automatically. If it doesn&rsquo;t, open{" "}
                  <a href="http://192.168.4.1" target="_blank" rel="noreferrer" style={{ textDecoration: "underline", fontWeight: 600 }}>
                    http://192.168.4.1
                  </a>{" "}
                  in your browser.
                </li>
                <li>
                  Pick your home, school, or phone hotspot Wi-Fi network, enter the password, and tap{" "}
                  <b>Save &amp; Connect</b> (or tap <b>Open EcoVital Cloud</b> right from the pod&rsquo;s page to pre-fill your pair code).
                </li>
                <li>
                  Once on the same Wi-Fi, you can also open the pod&rsquo;s local status page anytime at{" "}
                  <code>http://&lt;pod-id&gt;.local/</code>.
                </li>
              </ol>
              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button className="btn" onClick={() => setStep(1)}>← Back</button>
                <button className="btn primary" onClick={() => setStep(3)}>
                  Next: Enter 6-character pair code →
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <form className="card" onSubmit={handleClaim}>
              <h2>Step 3 — Enter Your Pod&rsquo;s 6-Character Pair Code</h2>
              <p className="note">
                Uses unambiguous characters (<code>ABCDEFGHJKLMNPQRSTUVWXYZ23456789</code> — no <code>0/O/1/I</code>). Locked for 15 minutes after 5 wrong attempts.
              </p>

              <div className="form-row" style={{ marginTop: 12 }}>
                <label htmlFor="pair-code">6-Character Pair Code</label>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    id="pair-code"
                    className="input code-input"
                    maxLength={6}
                    placeholder="DEMO26"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                    required
                  />
                  <button type="button" className="btn small" onClick={seedAndUseDemoCode} disabled={busy}>
                    Fill Demo Code (DEMO26)
                  </button>
                </div>
              </div>

              <div className="grid-2" style={{ marginTop: 14 }}>
                <div className="form-row">
                  <label htmlFor="claim-nick">Pod Nickname</label>
                  <input
                    id="claim-nick"
                    className="input"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    placeholder="e.g. JSS 2 Classroom Pod"
                  />
                </div>
                <div className="form-row">
                  <label htmlFor="claim-loc">Room / Location</label>
                  <input
                    id="claim-loc"
                    className="input"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="e.g. FUTO Lecture Room B"
                  />
                </div>
              </div>

              <div className="form-row">
                <label htmlFor="claim-prof">Room Profile Preset (Sets comfort &amp; alert thresholds)</label>
                <select
                  id="claim-prof"
                  className="select"
                  value={roomProfile}
                  onChange={(e) => setRoomProfile(e.target.value as RoomProfileKey)}
                >
                  {Object.entries(ROOM_PROFILES).map(([k, p]) => (
                    <option key={k} value={k}>
                      {p.label} — {p.description}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button type="button" className="btn" onClick={() => setStep(2)}>
                  ← Back
                </button>
                <button type="submit" className="btn primary" disabled={busy || code.length < 4}>
                  {busy ? "Pairing..." : "Pair & Claim Pod →"}
                </button>
              </div>
            </form>
          )}

          {step === 4 && (
            <div className="card">
              <h2>Step 4 — Pod Paired &amp; Ready!</h2>
              <p>
                Your pod <b>{nickname}</b> (<code>{claimedPod?.podId || "demo-node"}</code>) is now linked to your account with the{" "}
                <b>{ROOM_PROFILES[roomProfile]?.label}</b> profile.
              </p>
              {claimedPod?.deviceToken && (
                <div className="banner info">
                  <b>Per-Pod Device Token issued:</b> <code>{claimedPod.deviceToken}</code>
                  <div className="note" style={{ marginTop: 4 }}>
                    Delivered automatically to the pod on its next <code>POST /api/ingest</code> check-in.
                  </div>
                </div>
              )}
              <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
                <button
                  className="btn primary"
                  onClick={() => router.push(`/node/${encodeURIComponent(claimedPod?.podId || "demo-node")}`)}
                >
                  Open Live Pod Dashboard →
                </button>
                <Link className="btn" href="/">
                  Back to Home &amp; Network Map
                </Link>
              </div>
            </div>
          )}
        </main>

        <aside className="side">
          <section className="card">
            <h2>Pod Quick Reference (v1.1)</h2>
            <table className="kv">
              <tbody>
                <tr><th>Setup Wi-Fi AP</th><td><code>EcoVital-XXXX</code></td></tr>
                <tr><th>Captive Portal IP</th><td><code>192.168.4.1</code></td></tr>
                <tr><th>Local mDNS URL</th><td><code>http://&lt;id&gt;.local/</code></td></tr>
                <tr><th>OLED Pair Code</th><td>6 chars (e.g. <code>DEMO26</code>)</td></tr>
                <tr><th>DHT22 (Temp/Hum)</th><td>GPIO 4</td></tr>
                <tr><th>MQ-135 (Air Index)</th><td>GPIO 34 (ADC)</td></tr>
                <tr><th>GP2Y1010 (Dust)</th><td>GPIO 35 / LED 32</td></tr>
                <tr><th>PAM8403 Speaker</th><td>GPIO 25 (DAC1)</td></tr>
                <tr><th>SSD1306 OLED</th><td>GPIO 21 (SDA), 22 (SCL)</td></tr>
              </tbody>
            </table>
            <p className="note" style={{ marginTop: 10 }}>
              <b>USB Serial Commands (115200 baud):</b> <code>help</code>, <code>status</code>, <code>code</code>, <code>test</code>, <code>vol 80</code>, <code>mute</code>, <code>unmute</code>, <code>wifi-reset</code>.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

export default function AddPodPage() {
  return (
    <Suspense fallback={<div className="wrap"><div className="skeleton">Loading pairing wizard...</div></div>}>
      <AddPodWizardInner />
    </Suspense>
  );
}
