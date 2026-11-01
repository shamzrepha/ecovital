"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ROOM_PROFILES, type RoomProfileKey } from "@/lib/config";

type Heard = { podId: string; name: string; fw: string | null; lastSeenSecondsAgo: number | null };
type Check =
  | { state: "idle" }
  | { state: "searching"; message: string; secondsLeft: number }
  | { state: "stopped"; tone: "bad" | "watch"; message: string }
  | { state: "heard"; pod: Heard };

const POLL_MS = 4000;
const GIVE_UP_S = 90;
const STEPS = ["Power on", "Pair code", "Name it"];

function AddPod() {
  const router = useRouter();
  const prefill = (useSearchParams().get("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);

  const [step, setStep] = useState(prefill.length === 6 ? 2 : 1);
  const [code, setCode] = useState(prefill);
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const [name, setName] = useState("");
  const [place, setPlace] = useState("");
  const [profile, setProfile] = useState<RoomProfileKey>("classroom");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState<{ podId: string; name: string } | null>(null);
  const [firstReading, setFirstReading] = useState<"waiting" | "got" | "slow">("waiting");

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useRef(0); // bumped to cancel any in-flight check loop

  const stop = useCallback(() => {
    run.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const startCheck = useCallback(
    (value: string) => {
      stop();
      const id = run.current;
      const t0 = Date.now();
      const tick = async () => {
        if (id !== run.current) return;
        const elapsed = Math.round((Date.now() - t0) / 1000);
        try {
          const res = await fetch(`/api/claim?code=${encodeURIComponent(value)}`, { cache: "no-store" });
          const j = await res.json();
          if (id !== run.current) return;
          if (!res.ok) {
            setCheck({ state: "stopped", tone: "bad", message: j.error || "Could not check the code. Try again." });
            return;
          }
          if (j.state === "heard") {
            setCheck({ state: "heard", pod: { podId: j.podId, name: j.name, fw: j.fw, lastSeenSecondsAgo: j.lastSeenSecondsAgo } });
            setName((n) => n || j.name || "");
            return;
          }
          if (j.state === "yours") {
            router.replace(`/node/${encodeURIComponent(j.podId)}`);
            return;
          }
          if (j.state === "invalid" || j.state === "taken" || j.state === "bad-key" || j.state === "locked") {
            setCheck({ state: "stopped", tone: j.state === "invalid" ? "watch" : "bad", message: j.message });
            return;
          }
          if (elapsed >= GIVE_UP_S) {
            setCheck({ state: "stopped", tone: "watch", message: j.message + " Fix that, then press Check again." });
            return;
          }
          setCheck({ state: "searching", message: j.message, secondsLeft: GIVE_UP_S - elapsed });
          timer.current = setTimeout(tick, POLL_MS);
        } catch {
          if (id !== run.current) return;
          setCheck({ state: "stopped", tone: "watch", message: "No connection to EcoVital from this device. Check your internet and press Check again." });
        }
      };
      setCheck({ state: "searching", message: "Looking for your pod…", secondsLeft: GIVE_UP_S });
      tick();
    },
    [router, stop],
  );

  // Check automatically as soon as 6 characters are in (including a code from a QR or link).
  useEffect(() => {
    if (step === 2 && code.length === 6 && check.state === "idle") startCheck(code);
  }, [step, code, check.state, startCheck]);

  function onCode(v: string) {
    const clean = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    setCode(clean);
    stop();
    setCheck({ state: "idle" });
  }

  async function addPod(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError("");
    try {
      const res = await fetch("/api/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, nickname: name, location: place, roomProfile: profile }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "Could not add the pod.");
      setAdded({ podId: j.podId, name: j.name });
      setStep(4);
      if (j.latest) setFirstReading("got");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  // After adding, wait for the first reading to show up (the pod uploads about every 15 s).
  useEffect(() => {
    if (step !== 4 || !added || firstReading === "got") return;
    let live = true;
    const t0 = Date.now();
    const poll = async () => {
      if (!live) return;
      try {
        const res = await fetch(`/api/nodes/${encodeURIComponent(added.podId)}?range=1h`, { cache: "no-store" });
        const j = await res.json();
        if (res.ok && j.latest && (j.latest.dust != null || j.latest.air != null || j.latest.temp != null || j.latest.hum != null)) {
          if (live) setFirstReading("got");
          return;
        }
      } catch {}
      if (Date.now() - t0 > 60_000) { if (live) setFirstReading("slow"); return; }
      setTimeout(poll, 4000);
    };
    poll();
    return () => { live = false; };
  }, [step, added, firstReading]);

  return (
    <div className="wrap">
      <header className="top">
        <span className="brand">Add a pod</span>
        <span className="spacer" />
        <Link className="btn small" href="/dashboard">Back to home</Link>
      </header>

      <div className="wizard">
        <ol className="steps" aria-label="Progress">
          {STEPS.map((s, i) => {
            const n = i + 1;
            const cls = step === n || (step === 4 && n === 3) ? "on" : step > n ? "done" : "";
            return (
              <li key={s} className={cls} aria-current={step === n ? "step" : undefined}>
                <b>{step > n ? "✓" : n}</b>
                {s}
              </li>
            );
          })}
        </ol>

        {step === 1 && (
          <section className="card">
            <h2 style={{ margin: 0 }}>Power on your pod</h2>
            <ol className="how">
              <li>Plug the pod into power. Its screen shows the EcoVital logo, then its status.</li>
              <li>
                <b>First time, or the pod says “Setup mode”?</b> On your phone open Wi-Fi settings and join the network called{" "}
                <b>EcoVital-XXXX</b>. A setup page opens (if not, go to <b>192.168.4.1</b>). Pick your Wi-Fi, enter its password and save.
                The pod restarts and joins.
              </li>
              <li>Wait for the pod’s Wi-Fi bars to turn green, then continue.</li>
            </ol>
            <p className="note" style={{ margin: 0 }}>
              To redo Wi-Fi later, hold the pod’s BOOT button for 5 seconds. It forgets the network and goes back to setup mode.
            </p>
            <div className="wizard-actions">
              <button className="btn primary" onClick={() => setStep(2)}>Pod is on Wi-Fi, continue</button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="card">
            <h2 style={{ margin: 0 }}>Enter the pair code</h2>
            <p style={{ margin: 0, color: "var(--ink2)", fontSize: 14.5 }}>
              The 6-character code is on the pod’s screen. Press the BOOT button once to show it again for 15 seconds.
              It is the code, not the pod’s ID.
            </p>
            <label htmlFor="pair-code" className="sr-only" style={{ position: "absolute", left: -9999 }}>Pair code</label>
            <input
              id="pair-code"
              className="input code-input"
              value={code}
              onChange={(e) => onCode(e.target.value)}
              placeholder="K7Q2MX"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={6}
              autoFocus
            />

            {check.state === "searching" && (
              <div className="pair-status" role="status">
                <span className="dot watch pulse" style={{ marginTop: 6 }} />
                <div>
                  <b>Waiting for your pod to connect…</b>
                  <div style={{ color: "var(--ink2)" }}>{check.message} We keep checking for {check.secondsLeft} more seconds.</div>
                </div>
              </div>
            )}
            {check.state === "stopped" && (
              <div className={`pair-status ${check.tone}`} role="alert">
                <span className={`dot ${check.tone}`} style={{ marginTop: 6 }} />
                <div>{check.message}</div>
              </div>
            )}
            {check.state === "heard" && (
              <div className="pair-status good" role="status">
                <span className="dot good" style={{ marginTop: 6 }} />
                <div>
                  <b>Found {check.pod.name}.</b>
                  <div style={{ color: "var(--ink2)" }}>
                    {check.pod.fw ? `Firmware v${check.pod.fw}. ` : ""}
                    {check.pod.lastSeenSecondsAgo != null ? `Last heard ${check.pod.lastSeenSecondsAgo} s ago.` : ""}
                  </div>
                </div>
              </div>
            )}

            <div className="wizard-actions">
              <button className="btn" onClick={() => { stop(); setStep(1); }}>Back</button>
              {check.state === "heard" ? (
                <button className="btn primary" onClick={() => setStep(3)}>Continue</button>
              ) : (
                <button className="btn primary" disabled={code.length !== 6 || check.state === "searching"} onClick={() => startCheck(code)}>
                  Check
                </button>
              )}
            </div>
          </section>
        )}

        {step === 3 && (
          <form className="card" onSubmit={addPod}>
            <h2 style={{ margin: 0 }}>Name it and place it</h2>
            {error && <div className="banner" role="alert" style={{ margin: 0 }}>{error}</div>}
            <div className="form-row">
              <label htmlFor="pod-name">Pod name</label>
              <input id="pod-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Room 4" required maxLength={60} />
            </div>
            <div className="form-row">
              <label htmlFor="pod-place">Where is it? (optional)</label>
              <input id="pod-place" className="input" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Science block, first floor" maxLength={80} />
            </div>
            <div className="form-row">
              <label htmlFor="pod-profile">Room type</label>
              <select id="pod-profile" className="select" value={profile} onChange={(e) => setProfile(e.target.value as RoomProfileKey)}>
                {Object.entries(ROOM_PROFILES).map(([k, p]) => (
                  <option key={k} value={k}>{p.label}</option>
                ))}
              </select>
              <span className="note">This sets the starting limits. You can change any limit later.</span>
            </div>
            <div className="wizard-actions">
              <button type="button" className="btn" onClick={() => setStep(2)}>Back</button>
              <button className="btn primary" disabled={adding || !name.trim()}>{adding ? "Adding…" : "Add pod"}</button>
            </div>
          </form>
        )}

        {step === 4 && added && (
          <section className="card">
            <h2 style={{ margin: 0 }}>{added.name} is added</h2>
            {firstReading === "got" && (
              <div className="pair-status good" role="status"><span className="dot good" style={{ marginTop: 6 }} /><div>First reading received. Your pod is live.</div></div>
            )}
            {firstReading === "waiting" && (
              <div className="pair-status" role="status"><span className="dot watch pulse" style={{ marginTop: 6 }} /><div>Waiting for the first reading. The pod sends one about every 15 seconds. The MQ sensor needs about a minute to warm up.</div></div>
            )}
            {firstReading === "slow" && (
              <div className="pair-status watch" role="status"><span className="dot watch" style={{ marginTop: 6 }} /><div>No reading yet. The pod is added, so it will appear as soon as it uploads. Check that it still shows green Wi-Fi bars.</div></div>
            )}
            <div className="wizard-actions">
              <button className="btn primary" onClick={() => router.push(`/node/${encodeURIComponent(added.podId)}`)}>Open {added.name}</button>
              <Link className="btn" href="/add" onClick={() => { setStep(1); setCode(""); setCheck({ state: "idle" }); setAdded(null); setName(""); setFirstReading("waiting"); }}>Add another pod</Link>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export default function AddPodPage() {
  return (
    <Suspense>
      <AddPod />
    </Suspense>
  );
}
