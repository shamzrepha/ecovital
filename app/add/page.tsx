"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
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
  const [waitingSec, setWaitingSec] = useState<number>(0);
  const [health, setHealth] = useState<any>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setWaitingSec(0);
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        setHealth(j);
        return j;
      }
    } catch {}
    return null;
  }, []);

  useEffect(() => {
    loadHealth();
    return () => stopPolling();
  }, [loadHealth, stopPolling]);

  useEffect(() => {
    if (prefill && prefill.length === 6) {
      setCode(prefill);
      setStep(3);
    }
  }, [prefill]);

  async function seedAndUseDemoCode() {
    stopPolling();
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

  const attemptClaim = useCallback(
    async (cleanCode: string) => {
      const res = await fetch("/api/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: cleanCode,
          nickname,
          location,
          roomProfile,
        }),
      });
      const j = await res.json();
      return { ok: res.ok && !!j.ok, data: j };
    },
    [nickname, location, roomProfile],
  );

  async function handleClaim(e: React.FormEvent) {
    e.preventDefault();
    stopPolling();
    const cleanCode = code.trim().toUpperCase();
    setBusy(true);
    setErrorMsg("");
    setStatusMsg("Checking pair code with EcoVital cloud...");
    try {
      const { ok, data: j } = await attemptClaim(cleanCode);
      if (ok) {
        setClaimedPod({ podId: j.podId, deviceToken: j.deviceToken });
        setStatusMsg(`Pod "${j.podId}" paired and configured!`);
        setStep(4);
        return;
      }

      // Show the exact error message returned by /api/claim
      setErrorMsg(j.error || "Could not claim pod.");
      setStatusMsg("");

      // If the server has not heard from the pod yet, poll /api/health every 5 s for up to 60 s
      if (!j.locked && typeof j.error === "string" && j.error.includes("We have not heard from a pod")) {
        let remaining = 60;
        setWaitingSec(remaining);
        setStatusMsg("Waiting for your pod to connect... Checking server every 5 seconds (60 s remaining).");
        pollTimerRef.current = setInterval(async () => {
          remaining -= 5;
          if (remaining <= 0) {
            stopPolling();
            setStatusMsg("Finished waiting 60 seconds. Check your pod's Wi-Fi & App address, then try again.");
            return;
          }
          setWaitingSec(remaining);
          setStatusMsg(`Waiting for your pod to connect... Checking server every 5 seconds (${remaining} s remaining).`);
          const h = await loadHealth();
          const recentContact = h?.contacts?.some((c: any) => typeof c.secondsAgo === "number" && c.secondsAgo <= 20);
          if (recentContact || remaining % 20 === 0) {
            const retry = await attemptClaim(cleanCode);
            if (retry.ok) {
              stopPolling();
              setErrorMsg("");
              setClaimedPod({ podId: retry.data.podId, deviceToken: retry.data.deviceToken });
              setStatusMsg(`Pod "${retry.data.podId}" connected and paired!`);
              setStep(4);
            } else if (retry.data?.error) {
              setErrorMsg(retry.data.error);
              if (retry.data.locked || retry.data.error.includes("rejected its key")) {
                stopPolling();
                setStatusMsg("");
              }
            }
          }
        }, 5000);
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

      {errorMsg && (
        <div className="banner" role="alert">
          <b>Pairing diagnosis:</b> {errorMsg}
        </div>
      )}
      {statusMsg && (
        <div className="banner info" role="status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <span>
            {waitingSec > 0 && <span className="dot good pulse" style={{ marginRight: 8 }} />}
            {statusMsg}
          </span>
          {waitingSec > 0 && (
            <button type="button" className="btn small" onClick={stopPolling}>
              Stop waiting
            </button>
          )}
        </div>
      )}

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
                  <b>Where to find your 6-character pair code:</b> Look on the <b>pod&rsquo;s OLED screen</b> during startup, or <b>press the BOOT button briefly</b> on the pod to display the pair code again for 30 seconds. (It is also shown on the <code>EcoVital-XXXX</code> setup page and via USB serial <code>code</code>.)
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
                  Pick your home, school, or phone hotspot Wi-Fi network, enter the password, verify the App address is set to this site and the Device key matches <code>DEVICE_KEY</code>, and tap{" "}
                  <b>Save &amp; Connect</b>.
                </li>
                <li>
                  Already on Wi-Fi (firmware 1.3+)? Open <code>http://&lt;IP shown at bottom of pod screen&gt;</code> &gt; <b>Settings</b> to update the App address or Device key without reflashing.
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
                <b>Where to find the code:</b> Check the <b>pod&rsquo;s OLED screen</b>, or <b>press the BOOT button briefly on the pod</b> to show the 6-character pair code again for 30 seconds. Make sure the pod&rsquo;s Wi-Fi bars are green in the top-right corner of its screen.
              </p>

              <div className="form-row" style={{ marginTop: 12 }}>
                <label htmlFor="pair-code">6-Character Pair Code (on pod screen — not its device ID)</label>
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

              <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
                <button type="button" className="btn" onClick={() => setStep(2)}>
                  ← Back
                </button>
                <button type="submit" className="btn primary" disabled={busy || code.length < 4}>
                  {busy ? "Pairing..." : waitingSec > 0 ? `Waiting (${waitingSec}s)... Click to Retry Now` : "Pair & Claim Pod →"}
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
                  <b>Per-Pod Private Token issued:</b> <code>{claimedPod.deviceToken}</code>
                  <div className="note" style={{ marginTop: 4 }}>
                    Delivered automatically to the pod on its next <code>POST /api/ingest</code> check-in. Once confirmed by the pod, the shared setup key is no longer accepted for this pod.
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
            <h2>Cloud Health &amp; Pod Contacts</h2>
            {health ? (
              <>
                <table className="kv">
                  <tbody>
                    <tr>
                      <th>Database</th>
                      <td><span className={`chip ${health.database === "ok" ? "good" : "bad"}`}>{health.database}</span></td>
                    </tr>
                    <tr>
                      <th>DEVICE_KEY set</th>
                      <td><span className={`chip ${health.deviceKeyConfigured ? "good" : "bad"}`}>{health.deviceKeyConfigured ? "Yes" : "No"}</span></td>
                    </tr>
                  </tbody>
                </table>
                {health.contacts?.length > 0 ? (
                  <div style={{ marginTop: 10 }}>
                    <div className="note" style={{ fontWeight: 600, marginBottom: 4 }}>Recent pods contacting server:</div>
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5 }}>
                      {health.contacts.slice(0, 5).map((c: any) => (
                        <li key={c.deviceId}>
                          <code>{c.deviceId}</code> (fw {c.fw || "?"}) —{" "}
                          <span className={`chip ${c.result === "ok" ? "good" : "bad"}`}>{c.result}</span>{" "}
                          <span>{c.secondsAgo}s ago</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="note" style={{ marginTop: 8 }}>No hardware pods have contacted this server instance yet.</p>
                )}
              </>
            ) : (
              <p className="note">Checking /api/health...</p>
            )}
          </section>

          <section className="card">
            <h2>Pod Quick Reference (v1.4)</h2>
            <table className="kv">
              <tbody>
                <tr><th>Show Pair Code</th><td>Press <b>BOOT</b> button briefly (shows for 30 s)</td></tr>
                <tr><th>Setup Wi-Fi AP</th><td><code>EcoVital-XXXX</code> (<code>192.168.4.1</code>)</td></tr>
                <tr><th>Pod Settings Page</th><td><code>http://&lt;IP on bottom of screen&gt;</code> &gt; Settings</td></tr>
                <tr><th>DHT22 (Temp/Hum)</th><td>GPIO 4</td></tr>
                <tr><th>MQ-135 (Air Index)</th><td>GPIO 34 (ADC)</td></tr>
                <tr><th>GP2Y1010 (Dust)</th><td>GPIO 35 / LED 32</td></tr>
                <tr><th>PAM8403 Speaker</th><td>GPIO 25 (DAC1)</td></tr>
                <tr><th>SSD1306 OLED</th><td>GPIO 21 (SDA), 22 (SCL)</td></tr>
              </tbody>
            </table>
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
