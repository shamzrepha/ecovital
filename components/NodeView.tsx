"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import StripChart from "./StripChart";
import SosButton from "./SosButton";
import AiPredictorPanel from "./AiPredictorPanel";
import { ago, useVoice } from "./useVoice";
import {
  ACTION_LIBRARY,
  METRICS,
  METRIC_KEYS,
  OFFLINE_CLIPS,
  ROOM_PROFILES,
  fmt,
  parseStatus,
  statusWord,
  type MetricCfg,
  type MetricKey,
  type RoomProfileKey,
} from "@/lib/config";

const RANGES = ["1h", "6h", "24h", "7d"];

function levelClass(s: string | undefined): "good" | "watch" | "bad" {
  const l = parseStatus(s).level;
  return l === "ok" ? "good" : l;
}

export default function NodeView({ id, readOnly = false, shareToken }: { id: string; readOnly?: boolean; shareToken?: string }) {
  const [range, setRange] = useState("1h");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"day" | "week">("day");
  const [bottomTab, setBottomTab] = useState<"settings" | "thresholds" | "clips" | "actions">("settings");
  const [, setTick] = useState(0);
  const voice = useVoice();
  const spokenUpTo = useRef<number | null>(null);

  // Pod settings form state
  const [nickname, setNickname] = useState("");
  const [location, setLocation] = useState("");
  const [roomProfile, setRoomProfile] = useState<RoomProfileKey>("classroom");
  const [volume, setVolume] = useState(80);
  const [mute, setMute] = useState(false);
  const [voiceLang, setVoiceLang] = useState<string>("");
  const [quietOn, setQuietOn] = useState(false);
  const [quietStart, setQuietStart] = useState(22);
  const [quietEnd, setQuietEnd] = useState(6);
  const [cmdMsg, setCmdMsg] = useState("");
  const [weights, setWeights] = useState<Record<MetricKey, number>>({ dust: 35, air: 35, temp: 15, hum: 15 });
  const [threshDraft, setThreshDraft] = useState<Record<string, any>>({});
  const [saveMsg, setSaveMsg] = useState("");
  const [playingClip, setPlayingClip] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/nodes/${encodeURIComponent(id)}?range=${range}${shareToken ? `&share=${encodeURIComponent(shareToken)}` : ""}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setData(j);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [id, range, shareToken]);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") {
        load();
        setTick((x) => x + 1);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [load]);

  // Populate settings form when data arrives for the first time
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!data || initializedRef.current) return;
    initializedRef.current = true;
    const dev = data.device;
    const ps = data.podState;
    setNickname(dev.name || "");
    setLocation(dev.location || "");
    setRoomProfile((ps?.roomProfile as RoomProfileKey) || "classroom");
    setVolume(ps?.volume ?? 80);
    setMute(Boolean(ps?.mute));
    setVoiceLang(ps?.voiceLang ?? "");
    if (ps?.quietStart != null && ps?.quietEnd != null) { setQuietOn(true); setQuietStart(ps.quietStart); setQuietEnd(ps.quietEnd); }
    if (ps?.scoreWeights) setWeights(ps.scoreWeights);
    if (data.effectiveConfigs) setThreshDraft(data.effectiveConfigs);
  }, [data]);

  // Speak new voice lines as they arrive (only while the voice toggle is on; never replay old ones).
  useEffect(() => {
    if (!data) return;
    const spoken = (data.events as any[]).filter((e) => e.spokenFlag && e.spoken);
    const maxId = spoken.reduce((m, e) => Math.max(m, e.id), 0);
    if (spokenUpTo.current === null) {
      spokenUpTo.current = maxId;
      return;
    }
    const fresh = spoken
      .filter((e) => e.id > (spokenUpTo.current ?? 0) && data.now - e.t < 90_000)
      .sort((a, b) => a.id - b.id);
    spokenUpTo.current = Math.max(spokenUpTo.current, maxId);
    if (voice.on && fresh.length) voice.play(fresh[fresh.length - 1].id, fresh[fresh.length - 1].spoken);
  }, [data, voice]);

  async function savePodSettings(extra?: Record<string, any>) {
    setSaveMsg("Saving pod settings...");
    try {
      const res = await fetch(`/api/pods/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nickname,
          location,
          roomProfile,
          volume,
          mute,
          scoreWeights: weights,
          voiceLang: voiceLang || null,
          quietStart: quietOn ? quietStart : null,
          quietEnd: quietOn ? quietEnd : null,
          tzMin: -new Date().getTimezoneOffset(),
          ...extra,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Save failed");
      setSaveMsg("Saved. Name, volume, mute and limits reach the pod within about 5 seconds.");
      load();
    } catch (e: any) {
      setSaveMsg(`Error: ${e.message}`);
    }
  }

  async function sendCommand(cmd: "identify" | "calibrate" | "restart") {
    const warn = cmd === "calibrate" ? "Recalibrate only works well in clean, fresh air, away from smoke, dust and fumes. Continue?" : cmd === "restart" ? "Restart the pod now?" : "";
    if (warn && !confirm(warn)) return;
    setCmdMsg("Sending…");
    try {
      const res = await fetch(`/api/pods/${encodeURIComponent(id)}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd }) });
      const j = await res.json();
      setCmdMsg(j.message || j.error || "Could not send.");
      if (res.ok) load();
    } catch {
      setCmdMsg("Could not reach EcoVital.");
    }
  }

  async function unclaimThisPod() {
    if (!confirm("Remove this pod from your account? Readings stay stored, and the pod can be claimed again.")) return;
    const res = await fetch("/api/claim", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ podId: id }),
    });
    const j = await res.json();
    setSaveMsg(j.ok ? "Pod unclaimed." : j.error || "Could not unclaim.");
    load();
  }

  function playOfflineClip(clipId: number) {
    setPlayingClip(clipId);
    const audio = new Audio(`/api/clips/${clipId}`);
    audio.onended = () => setPlayingClip(null);
    audio.onerror = () => setPlayingClip(null);
    audio.play().catch(() => setPlayingClip(null));
  }

  if (!data) {
    return (
      <div className="wrap">
        <Header name={id} />
        {error ? (
          <div className="banner">Could not load this node: {error}</div>
        ) : (
          <div className="skeleton">Loading readings...</div>
        )}
      </div>
    );
  }

  const now: number = data.now;
  const dev = data.device;
  const ps = data.podState;
  const rs = data.roomScore;
  const anomalies: any[] = data.anomalies ?? [];
  const events: any[] = data.events;
  const lastSpoken = events.find((e) => e.spokenFlag && e.spoken);
  const stale = dev.lastReadingAt ? now - dev.lastReadingAt > 60_000 : true;
  const savedReadingsEst = dev.lastReadingAt
    ? Math.min(240, Math.max(1, Math.floor(Math.max(0, now - dev.lastReadingAt) / 15_000)))
    : 0;
  const sys = data.system;

  return (
    <div className="wrap">
      <Header
        name={dev.name}
        location={dev.location}
        simulated={dev.simulated}
        online={dev.online && !stale}
        lastAt={dev.lastReadingAt}
        savedCount={savedReadingsEst}
        fw={sys?.fw}
        rssi={sys?.rssi}
        now={now}
        voiceOn={voice.on}
        toggleVoice={voice.toggle}
        podId={dev.id}
        readOnly={readOnly}
      />

      {error && <div className="banner">Showing the last data received. Refresh failed: {error}</div>}
      {stale && !dev.simulated && (
        <div className="banner warn">
          <b>
            Offline, {savedReadingsEst} reading{savedReadingsEst === 1 ? "" : "s"} saved on the pod will arrive when it reconnects
            {dev.lastReadingAt ? ` (last reading ${ago(now, dev.lastReadingAt)})` : " (waiting for first reading)"}:
          </b>{" "}
          This pod is offline from Wi-Fi, but still judging readings, forecasting, and speaking its 15 built-in offline alerts in the room.
        </div>
      )}

      {/* Anomaly Alert Banner */}
      {anomalies.length > 0 && (
        <div className="banner warn" role="region" aria-label="Detected anomalies">
          <b>Unusual sensor jump detected (Measured):</b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {anomalies.slice(0, 3).map((a, idx) => (
              <li key={idx}>
                {a.explanation} <span className="chip">{ago(now, a.ts)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Room Score & What the pod just said */}
      <div className="grid-2" style={{ alignItems: "stretch", marginBottom: 18 }}>
        {rs && (
          <div className="card score-card" style={{ marginBottom: 0 }}>
            <div
              className={`score-ring ${rs.level === "poor" ? "poor" : rs.level === "fair" ? "fair" : ""}`}
              style={{ width: 108, height: 108, flexShrink: 0, margin: 0 }}
            >
              <span className="score-num" style={{ fontSize: 32 }}>{rs.score}</span>
              <span className="score-word" style={{ fontSize: 11.5 }}>{rs.word}</span>
            </div>
            <div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                <h2 style={{ margin: 0 }}>Room Score (0–100)</h2>
                <span className="tag-measured">Measured</span>
                <span className="chip">
                  Profile: {ROOM_PROFILES[(ps?.roomProfile as RoomProfileKey) ?? "classroom"]?.label ?? "Classroom"}
                </span>
              </div>
              <ul style={{ margin: "6px 0", paddingLeft: 18, fontSize: 13.5, color: "var(--ink2)" }}>
                {rs.reasons.map((r: string, i: number) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
              <div style={{ fontSize: 12, color: "var(--ink2)" }}>
                Subscores: Dust {rs.subscores.dust} · Air {rs.subscores.air} · Temp {rs.subscores.temp} · Hum {rs.subscores.hum}
              </div>
            </div>
          </div>
        )}

        {lastSpoken ? (
          <div className={`said ${lastSpoken.kind}`} style={{ margin: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 650, textTransform: "uppercase", color: "var(--ink2)" }}>
                What the pod just said
              </span>
              {lastSpoken.kind === "predictive" ? (
                <span className="tag-estimated">Estimated trend</span>
              ) : (
                <span className="tag-measured">Measured trigger</span>
              )}
              {lastSpoken.action && <span className="chip">Action: {lastSpoken.action}</span>}
            </div>
            <q>{lastSpoken.spoken}</q>
            {lastSpoken.translatedText && lastSpoken.machineTranslated && (
              <p style={{ margin: "6px 0 0", fontSize: 14, color: "var(--brand-deep)" }}>
                <b>{lastSpoken.language?.toUpperCase()}:</b> &ldquo;{lastSpoken.translatedText}&rdquo;{" "}
                <span className="chip">Machine translated</span>
              </p>
            )}
            <div className="meta">
              <span>{ago(now, lastSpoken.t)}</span>
              <button className="btn small primary" onClick={() => voice.play(lastSpoken.id, lastSpoken.spoken)}>
                ▶ Replay voice
              </button>
              <span>
                {lastSpoken.source === "gemini"
                  ? "Written by Gemini from the last 2 minutes of all four sensors"
                  : "Standard template wording (offline/fallback)"}
              </span>
            </div>
          </div>
        ) : (
          <div className="said quiet" style={{ margin: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 650, textTransform: "uppercase", color: "var(--ink2)", marginBottom: 4 }}>
              What the pod just said
            </span>
            <q>Nothing to report. EcoVital speaks only when a reading crosses a limit, or a clear trend is heading for one.</q>
          </div>
        )}
      </div>

      {/* Multi-Horizon AI Predictive Engine & What-If Simulator */}
      <AiPredictorPanel
        podId={dev.id}
        onSpeak={(evId, txt) => {
          load();
          voice.play(evId, txt);
        }}
      />

      <div className="cols">
        <main>
          <div className="rangebar" role="group" aria-label="Chart range">
            <span className="label">Showing</span>
            {RANGES.map((r) => (
              <button key={r} className="btn small" aria-pressed={range === r} onClick={() => setRange(r)}>
                {r}
              </button>
            ))}
            <span className="spacer" />
            <a className="btn small" href={`/api/export/${encodeURIComponent(dev.id)}?range=${range}`} download>
              ⬇ Export {range} CSV
            </a>
            <Link className="btn small" href={`/insights?pod=${encodeURIComponent(dev.id)}`}>
              Compare today vs yesterday
            </Link>
          </div>

          {METRIC_KEYS.map((k) => (
            <Strip key={k} k={k} data={data} cfgOverride={data.effectiveConfigs?.[k]} />
          ))}

          <div className="legend">
            <span><i /> <b>Measured</b> (from sensor)</span>
            <span><i className="f" /> <b>Estimated</b> next 10 min (linear trend, 1h &amp; 6h views)</span>
            <span><i className="w" /> Watch zone</span>
            <span><i className="b" /> Alarm zone</span>
            <span>Vertical dotted lines mark spoken alerts</span>
          </div>

          {/* Pod Management, Custom Thresholds, Offline Clips & Action Library Tabs */}
          {!readOnly && (
            <section className="card" style={{ marginTop: 26 }}>
              <div className="tabs" style={{ borderBottom: "1px solid var(--rule)", paddingBottom: 10, marginBottom: 14 }}>
                <button
                  className="btn small"
                  aria-pressed={bottomTab === "settings"}
                  onClick={() => setBottomTab("settings")}
                >
                  ⚙ Pod Settings, Volume &amp; Share
                </button>
                <button
                  className="btn small"
                  aria-pressed={bottomTab === "thresholds"}
                  onClick={() => setBottomTab("thresholds")}
                >
                  🎚 Room Profile &amp; Custom Thresholds
                </button>
                <button
                  className="btn small"
                  aria-pressed={bottomTab === "clips"}
                  onClick={() => setBottomTab("clips")}
                >
                  🔊 Preview 15 Offline Pod Clips
                </button>
                <button
                  className="btn small"
                  aria-pressed={bottomTab === "actions"}
                  onClick={() => setBottomTab("actions")}
                >
                  📋 Action Library &amp; Hardware Honesty
                </button>
              </div>

              {saveMsg && <div className="banner info" role="status">{saveMsg}</div>}

              {bottomTab === "settings" && (
                <div className="grid-2">
                  <div>
                    <h3>Identity &amp; Room Profile</h3>
                    <div className="form-row">
                      <label htmlFor="pod-nick">Pod nickname</label>
                      <input
                        id="pod-nick"
                        className="input"
                        value={nickname}
                        onChange={(e) => setNickname(e.target.value)}
                      />
                    </div>
                    <div className="form-row">
                      <label htmlFor="pod-loc">Room / Location</label>
                      <input
                        id="pod-loc"
                        className="input"
                        value={location}
                        onChange={(e) => setLocation(e.target.value)}
                      />
                    </div>
                    <div className="form-row">
                      <label htmlFor="pod-prof">Room Profile preset</label>
                      <select
                        id="pod-prof"
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
                    <button className="btn primary" onClick={() => savePodSettings()}>
                      Save pod settings
                    </button>
                  </div>

                  <div>
                    <h3>Remote Speaker Volume &amp; Sharing</h3>
                    <p className="note" style={{ marginTop: 0 }}>
                      Sent in the reply to the pod&rsquo;s next <code>POST /api/ingest</code> check-in (within about 5 seconds) and saved to ESP32 flash.
                    </p>
                    <div className="form-row">
                      <label htmlFor="pod-vol">Pod speaker volume: <b>{volume}%</b></label>
                      <input
                        id="pod-vol"
                        type="range"
                        min={0}
                        max={100}
                        value={volume}
                        onChange={(e) => setVolume(Number(e.target.value))}
                      />
                    </div>
                    <div className="form-row">
                      <label htmlFor="pod-lang">Language the pod speaks (when online)</label>
                      <select id="pod-lang" className="select" value={voiceLang} onChange={(e) => setVoiceLang(e.target.value)}>
                        <option value="">Use my account language</option>
                        <option value="en-NG">English</option>
                        <option value="pcm">Naija Pidgin</option>
                        <option value="ig">Igbo</option>
                        <option value="yo">Yoruba</option>
                        <option value="ha">Hausa</option>
                      </select>
                      <span className="note">Pidgin, Igbo, Yoruba and Hausa are machine-written and may have mistakes. When the pod is offline it uses its built-in English clips.</span>
                    </div>
                    <div className="form-row" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <input
                        id="pod-mute"
                        type="checkbox"
                        checked={mute}
                        onChange={(e) => setMute(e.target.checked)}
                      />
                      <label htmlFor="pod-mute" style={{ margin: 0 }}>
                        Mute spoken alerts on pod speaker (LED and screen stay active)
                      </label>
                    </div>
                    <div className="form-row" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <input id="pod-quiet" type="checkbox" checked={quietOn} onChange={(e) => setQuietOn(e.target.checked)} />
                      <label htmlFor="pod-quiet" style={{ margin: 0 }}>Quiet hours: keep the pod silent (the SOS alarm still sounds)</label>
                    </div>
                    {quietOn && (
                      <div className="form-row" style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <label htmlFor="pod-qs" style={{ margin: 0 }}>From</label>
                        <select id="pod-qs" className="select" style={{ width: "auto" }} value={quietStart} onChange={(e) => setQuietStart(Number(e.target.value))}><option value={0}>00:00</option><option value={1}>01:00</option><option value={2}>02:00</option><option value={3}>03:00</option><option value={4}>04:00</option><option value={5}>05:00</option><option value={6}>06:00</option><option value={7}>07:00</option><option value={8}>08:00</option><option value={9}>09:00</option><option value={10}>10:00</option><option value={11}>11:00</option><option value={12}>12:00</option><option value={13}>13:00</option><option value={14}>14:00</option><option value={15}>15:00</option><option value={16}>16:00</option><option value={17}>17:00</option><option value={18}>18:00</option><option value={19}>19:00</option><option value={20}>20:00</option><option value={21}>21:00</option><option value={22}>22:00</option><option value={23}>23:00</option></select>
                        <label htmlFor="pod-qe" style={{ margin: 0 }}>to</label>
                        <select id="pod-qe" className="select" style={{ width: "auto" }} value={quietEnd} onChange={(e) => setQuietEnd(Number(e.target.value))}><option value={0}>00:00</option><option value={1}>01:00</option><option value={2}>02:00</option><option value={3}>03:00</option><option value={4}>04:00</option><option value={5}>05:00</option><option value={6}>06:00</option><option value={7}>07:00</option><option value={8}>08:00</option><option value={9}>09:00</option><option value={10}>10:00</option><option value={11}>11:00</option><option value={12}>12:00</option><option value={13}>13:00</option><option value={14}>14:00</option><option value={15}>15:00</option><option value={16}>16:00</option><option value={17}>17:00</option><option value={18}>18:00</option><option value={19}>19:00</option><option value={20}>20:00</option><option value={21}>21:00</option><option value={22}>22:00</option><option value={23}>23:00</option></select>
                        <span className="note">Your local time. Alerts are still recorded in the timeline.</span>
                      </div>
                    )}
                    <button className="btn small" onClick={() => savePodSettings()} style={{ marginBottom: 14 }}>
                      Apply Volume &amp; Mute
                    </button>

                    <div style={{ borderTop: "1px solid var(--rule)", paddingTop: 12 }}>
                      <div style={{ fontSize: 13, marginBottom: 6 }}>
                        <b>Read-only classroom/parent link:</b>{" "}
                        {ps?.shareToken ? (
                          <Link href={`/share/${ps.shareToken}`} style={{ textDecoration: "underline" }}>
                            /share/{ps.shareToken}
                          </Link>
                        ) : (
                          "Available after first save"
                        )}
                      </div>
                      <div style={{ fontSize: 13, marginBottom: 10 }}>
                        <b>Local network page (same Wi-Fi):</b>{" "}
                        <a href={`http://${dev.id}.local/`} target="_blank" rel="noreferrer">
                          http://{dev.id}.local/
                        </a>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                        <button type="button" className="btn small" onClick={() => sendCommand("identify")}>📍 Find this pod</button>
                        <button type="button" className="btn small" onClick={() => sendCommand("calibrate")}>🧪 Recalibrate sensors</button>
                        <button type="button" className="btn small" onClick={() => sendCommand("restart")}>⟳ Restart pod</button>
                      </div>
                      {cmdMsg && <p className="note" role="status" style={{ margin: "0 0 8px" }}>{cmdMsg}</p>}
                      <button className="btn small danger" onClick={unclaimThisPod}>
                        Unclaim / Remove pod from account
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {bottomTab === "thresholds" && (
                <div>
                  <h3>Custom Thresholds &amp; Room Score Weights</h3>
                  <p className="note">
                    Start from a Room Profile ({ROOM_PROFILES[roomProfile]?.label}) or customize when this pod enters Watch and Alarm zones.
                  </p>
                  <div className="grid-2" style={{ marginBottom: 14 }}>
                    {METRIC_KEYS.map((k) => {
                      const cur = threshDraft[k] || METRICS[k];
                      return (
                        <div key={k} className="sensor-tile">
                          <b>{METRICS[k].label} ({METRICS[k].unit})</b>
                          <span className="note">{METRICS[k].note}</span>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
                            {cur.watchHigh !== undefined && (
                              <label style={{ fontSize: 12 }}>
                                Watch High
                                <input
                                  type="number"
                                  className="input"
                                  value={cur.watchHigh ?? ""}
                                  onChange={(e) =>
                                    setThreshDraft({
                                      ...threshDraft,
                                      [k]: { ...cur, watchHigh: Number(e.target.value) },
                                    })
                                  }
                                />
                              </label>
                            )}
                            {cur.badHigh !== undefined && (
                              <label style={{ fontSize: 12 }}>
                                Alarm High
                                <input
                                  type="number"
                                  className="input"
                                  value={cur.badHigh ?? ""}
                                  onChange={(e) =>
                                    setThreshDraft({
                                      ...threshDraft,
                                      [k]: { ...cur, badHigh: Number(e.target.value) },
                                    })
                                  }
                                />
                              </label>
                            )}
                            {cur.watchLow !== undefined && (
                              <label style={{ fontSize: 12 }}>
                                Watch Low
                                <input
                                  type="number"
                                  className="input"
                                  value={cur.watchLow ?? ""}
                                  onChange={(e) =>
                                    setThreshDraft({
                                      ...threshDraft,
                                      [k]: { ...cur, watchLow: Number(e.target.value) },
                                    })
                                  }
                                />
                              </label>
                            )}
                            {cur.badLow !== undefined && (
                              <label style={{ fontSize: 12 }}>
                                Alarm Low
                                <input
                                  type="number"
                                  className="input"
                                  value={cur.badLow ?? ""}
                                  onChange={(e) =>
                                    setThreshDraft({
                                      ...threshDraft,
                                      [k]: { ...cur, badLow: Number(e.target.value) },
                                    })
                                  }
                                />
                              </label>
                            )}
                          </div>
                          <label style={{ fontSize: 12, marginTop: 6 }}>
                            Room Score Weight (%):
                            <input
                              type="number"
                              className="input"
                              value={weights[k] ?? 25}
                              onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })}
                            />
                          </label>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="btn primary"
                      onClick={() => savePodSettings({ customThresholds: threshDraft })}
                    >
                      Save Custom Thresholds &amp; Weights
                    </button>
                    <button
                      className="btn"
                      onClick={() => savePodSettings({ resetThresholds: true })}
                    >
                      Reset to Room Profile Defaults
                    </button>
                  </div>
                </div>
              )}

              {bottomTab === "clips" && (
                <div>
                  <h3>15 Built-in Offline Voice Clips (Stored in Pod Flash `clips.h`)</h3>
                  <p className="note">
                    These 15 clips are stored in the ESP32 flash memory at 12 kHz 8-bit mu-law mono so the pod keeps speaking even when Wi-Fi and power grids fail. Click any clip to decode and play it in your browser.
                  </p>
                  <div className="table-wrap">
                    <table className="kv">
                      <thead>
                        <tr>
                          <th>Clip</th>
                          <th>Trigger Condition</th>
                          <th>Spoken Transcript</th>
                          <td>Preview</td>
                        </tr>
                      </thead>
                      <tbody>
                        {OFFLINE_CLIPS.map((c) => (
                          <tr key={c.id}>
                            <th>#{c.id}</th>
                            <td style={{ textAlign: "left", paddingRight: 10 }}>
                              <span className="chip">{c.title}: {c.when}</span>
                            </td>
                            <td style={{ textAlign: "left" }}>&ldquo;{c.transcript}&rdquo;</td>
                            <td>
                              <button
                                className="btn small"
                                disabled={playingClip === c.id}
                                onClick={() => playOfflineClip(c.id)}
                              >
                                {playingClip === c.id ? "Playing..." : "▶ Play"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {bottomTab === "actions" && (
                <div>
                  <h3>Action Library &amp; Hardware Honesty</h3>
                  <p className="note">
                    Every alert picks one concrete action. Features requiring a fan relay, CO₂ sensor, or calibrated PM2.5 sensor are honestly marked below.
                  </p>
                  <div className="table-wrap">
                    <table className="kv">
                      <thead>
                        <tr>
                          <th>Condition</th>
                          <th>Recommended Action</th>
                          <td>Hardware Status</td>
                        </tr>
                      </thead>
                      <tbody>
                        {ACTION_LIBRARY.map((a) => (
                          <tr key={a.id}>
                            <th>{a.condition}</th>
                            <td style={{ textAlign: "left" }}>{a.advice}</td>
                            <td>
                              {a.needsHardware ? (
                                <span className="tag-hardware" title={a.hardwareNote}>
                                  Needs extra hardware ({a.hardwareNote})
                                </span>
                              ) : (
                                <span className="tag-measured">Included on pod v1.1</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          )}
        </main>

        <aside className="side">
          <section>
            <h2>What EcoVital said (Event Timeline)</h2>
            {events.length === 0 && <p className="hint">No events yet.</p>}
            <ul className="events">
              {events.slice(0, 12).map((e) => (
                <li key={e.id} className={e.kind}>
                  <div className="when">
                    <span>{ago(now, e.t)}</span>
                    <span className="chip">
                      {e.kind === "alert" ? "Alert" : e.kind === "recovered" ? "Back to normal" : "Early warning"}
                    </span>
                    {e.kind === "predictive" ? (
                      <span className="tag-estimated">Estimated</span>
                    ) : (
                      <span className="tag-measured">Measured</span>
                    )}
                    <span className="chip">{e.source === "gemini" ? "Gemini" : "Template"}</span>
                    {e.kind === "predictive" && e.outcome === "hit" && <span className="chip good">Came true</span>}
                    {e.kind === "predictive" && e.outcome === "miss" && <span className="chip bad">False alarm</span>}
                    {e.kind === "predictive" && !e.outcome && <span className="chip">Checking</span>}
                  </div>
                  <div className="txt">{e.spoken ?? e.message}</div>
                  {e.translatedText && (
                    <div className="note" style={{ marginBottom: 4 }}>
                      <b>{e.language?.toUpperCase()}:</b> {e.translatedText} <span className="chip">Machine translated</span>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {e.spoken && (
                      <button className="btn small" onClick={() => voice.play(e.id, e.spoken)}>
                        ▶ Replay
                      </button>
                    )}
                    {e.action && <span className="chip">Action: {e.action.replace(/_/g, " ")}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2>Early-Warning Forecast Scoreboard</h2>
            <Accuracy acc={data.accuracy} />
          </section>

          <section>
            <h2>Summary</h2>
            <div className="tabs">
              <button className="btn small" aria-pressed={tab === "day"} onClick={() => setTab("day")}>
                Last 24 hours
              </button>
              <button className="btn small" aria-pressed={tab === "week"} onClick={() => setTab("week")}>
                Last 7 days
              </button>
            </div>
            <Summary s={data.summaries[tab]} />
          </section>

          <section>
            <h2>Pod Health &amp; Pairing Status</h2>
            <table className="kv">
              <tbody>
                <tr>
                  <th>Status</th>
                  <td>
                    {dev.simulated
                      ? "Simulated"
                      : dev.online && !stale
                        ? "Online"
                        : ps?.claimedBy
                          ? "Offline (still speaking locally)"
                          : "Waiting for cloud"}
                  </td>
                </tr>
                {ps?.claimCode && (
                  <tr>
                    <th>Pair code</th>
                    <td><code>{ps.claimCode}</code></td>
                  </tr>
                )}
                <tr><th>Room Profile</th><td>{ROOM_PROFILES[(ps?.roomProfile as RoomProfileKey) ?? "classroom"]?.label ?? "Classroom"}</td></tr>
                <tr><th>Speaker Volume</th><td>{ps?.mute ? "Muted" : `${ps?.volume ?? 80}%`}</td></tr>
                <tr><th>Last reading</th><td>{ago(now, dev.lastReadingAt)}</td></tr>
                <tr><th>Readings, last hour</th><td>{sys.readingsLastHour}</td></tr>
                <tr>
                  <th>Rejected sensor values</th>
                  <td>{sys.invalidLastHour > 0 ? `${sys.invalidLastHour} readings had a bad value` : "None"}</td>
                </tr>
                {sys.rssi !== null && <tr><th>Wi-Fi signal</th><td>{sys.rssi <= -75 ? "Weak" : sys.rssi <= -67 ? "Fair" : sys.rssi <= -55 ? "Good" : "Excellent"} ({sys.rssi} dBm)</td></tr>}
                {sys.uptimeS != null && <tr><th>Running for</th><td>{sys.uptimeS < 3600 ? `${Math.max(1, Math.round(sys.uptimeS / 60))} min` : sys.uptimeS < 172800 ? `${Math.round(sys.uptimeS / 3600)} hours` : `${Math.round(sys.uptimeS / 86400)} days`}</td></tr>}
                {sys.rst && <tr><th>Last restart</th><td>{({ power: "Power was connected", restart: "Restarted from the app or on purpose", crash: "The pod crashed and recovered", watchdog: "The pod stopped responding and reset itself", brownout: "The power dipped. Check the charger or USB port", other: "Unknown reason" } as Record<string, string>)[sys.rst] ?? sys.rst}</td></tr>}
                {sys.drops != null && <tr><th>Wi-Fi drops since start</th><td>{sys.drops === 0 ? "None" : sys.drops}</td></tr>}
                {sys.heap != null && <tr><th>Free memory</th><td>{Math.round(sys.heap / 1024)} KB {sys.heap < 40000 ? "(low)" : ""}</td></tr>}
                {sys.dhtOk === false && <tr><th>Temperature sensor</th><td>Not responding. Check its wiring.</td></tr>}
                {sys.fw && <tr><th>Firmware</th><td>v{sys.fw} {ps?.targetFwVersion && ps.targetFwVersion !== sys.fw ? `→ OTA v${ps.targetFwVersion} queued` : "(up to date)"}</td></tr>}
                {dev.id !== "demo-node" && sys.mqReady === false && <tr><th>Gas sensor</th><td>Warming up (first 90 s)</td></tr>}
              </tbody>
            </table>
            <details className="note" style={{ marginTop: 10 }}>
              <summary>Honesty &amp; sensor reference (What do these numbers mean?)</summary>
              <ul style={{ paddingLeft: 16 }}>
                {METRIC_KEYS.map((k) => (
                  <li key={k}>
                    <b>{METRICS[k].label}:</b> {METRICS[k].note}
                  </li>
                ))}
                <li>
                  <b>Estimates:</b> Early warnings use a straight-line trend over the last 10 minutes, checked against a &ldquo;no change&rdquo; baseline. The forecast panel uses a small model trained on this pod&rsquo;s own history (plus outside weather when a location is set), and is used only when it beats simple guesses. All of it is estimated, not measured.
                </li>
                <li>
                  <b>Serial commands (115200 baud):</b> <code>help</code>, <code>status</code>, <code>code</code>, <code>test</code>, <code>vol 0-100</code>, <code>mute</code>, <code>unmute</code>, <code>wifi-reset</code>.
                </li>
              </ul>
            </details>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Header(props: {
  name: string;
  location?: string | null;
  simulated?: boolean;
  online?: boolean;
  lastAt?: number | null;
  savedCount?: number;
  fw?: string | null;
  rssi?: number | null;
  now?: number;
  voiceOn?: boolean;
  toggleVoice?: () => void;
  podId?: string;
  readOnly?: boolean;
}) {
  return (
    <header className="top">
      <Link className="brand" href={props.readOnly ? "/" : "/dashboard"}>EcoVital</Link>
      <span className="crumb">
        / {props.name}
        {props.location ? ` · ${props.location}` : ""}
      </span>
      {props.simulated && <span className="chip sim">Simulated data</span>}
      {props.fw && <span className="chip" title="Pod firmware version">FW v{props.fw}</span>}
      {props.rssi !== undefined && props.rssi !== null && (
        <span className="chip" title="Wi-Fi signal strength">{props.rssi} dBm</span>
      )}
      {props.readOnly && <span className="chip">Read-only shared view</span>}
      <span className="spacer" />
      {props.now !== undefined && !props.simulated && (
        <span className="live">
          <span className={`dot ${props.online ? "good pulse" : "watch"}`} />
          {props.online
            ? `Online (${ago(props.now, props.lastAt)})`
            : `Offline, ${props.savedCount ?? 0} readings saved on the pod will arrive when it reconnects`}
        </span>
      )}
      {props.podId && !props.readOnly && <SosButton podId={props.podId} podName={props.name} />}
      {props.podId && !props.readOnly && (
        <Link className="btn small" href={`/ask?pod=${encodeURIComponent(props.podId)}`}>
          💬 Ask about this pod
        </Link>
      )}
      {props.toggleVoice && (
        <button
          className="btn small"
          aria-pressed={!!props.voiceOn}
          onClick={props.toggleVoice}
          title="Speak new alerts in this browser"
        >
          🔊 Browser voice: {props.voiceOn ? "on" : "off"}
        </button>
      )}
    </header>
  );
}

function Strip({ k, data, cfgOverride }: { k: MetricKey; data: any; cfgOverride?: MetricCfg }) {
  const cfg = cfgOverride ?? METRICS[k];
  const status: string = data.device.status[k] ?? "ok";
  const v: number | null = data.latest[k];
  const f = data.forecasts[k];
  const series = data.series.map((p: any) => ({ t: p.t, v: p[k] }));
  const cls = levelClass(status);

  return (
    <div className="strip">
      <div className="gauge">
        <div className="name">
          <span>{cfg.label}</span>
          <span className="tag-measured">Measured</span>
        </div>
        <div className="num">
          {fmt(k, v)}
          <small>{cfg.unit}</small>
        </div>
        <div className="state">
          <span className={`dot ${cls}`} />
          {statusWord(k, status)}
        </div>
        <div className="est">
          {f?.ok ? (
            <>
              <span className="tag-estimated" style={{ marginBottom: 3 }}>Estimated</span>
              <div>
                <b>
                  In {f.horizonMin} min: {fmt(k, f.predicted)}
                  {cfg.unit}
                </b>{" "}
                (range {fmt(k, f.low)} to {fmt(k, f.high)}), {f.trend}. Confidence {f.confidence}.
              </div>
              <details>
                <summary>Why this estimate</summary>
                <ul>
                  {f.factors.map((x: string, i: number) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </details>
            </>
          ) : (
            <>No estimate yet. {f?.reason}</>
          )}
        </div>
      </div>
      <div className="plot" aria-label={`${cfg.label} over the ${data.range.label}`}>
        <StripChart
          metric={k}
          series={series}
          now={data.now}
          rangeMs={data.range.ms}
          forecast={f}
          events={data.events}
          cfgOverride={cfg}
        />
      </div>
    </div>
  );
}

function Accuracy({ acc }: { acc: any }) {
  const rows: any[] = acc.metrics;
  const p = acc.predictive;
  const decided = p.hit + p.miss;
  const totalWins = acc.totalWins ?? 0;
  const totalChecks = acc.totalChecks ?? 0;

  return (
    <>
      {totalChecks > 0 && (
        <div
          style={{
            background: "var(--panel-alt)",
            border: "1px solid var(--rule)",
            borderRadius: 8,
            padding: "8px 12px",
            marginBottom: 10,
            fontSize: 13.5,
          }}
        >
          <span className="tag-estimated" style={{ marginRight: 6 }}>Scoreboard</span>
          <b>
            Our linear forecast beat the &ldquo;no-change&rdquo; baseline {totalWins} of {totalChecks} times
          </b>{" "}
          ({Math.round((totalWins / totalChecks) * 100)}%).
        </div>
      )}
      <p className="hint">
        Every 5 minutes EcoVital writes down where its 10-minute linear trend expects each reading to be in 15 minutes, then checks against actual readings.
      </p>
      {rows.length === 0 ? (
        <p className="note">Collecting data. The first scores appear about 10 minutes after the pod starts sending.</p>
      ) : (
        <table className="kv">
          <thead>
            <tr>
              <th>Reading</th>
              <td>Trend error</td>
              <td>&ldquo;No change&rdquo; error</td>
              <td>Wins / n</td>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const k = r.metric as MetricKey;
              const better =
                r.n >= 3 && r.maeModel !== null && r.maeBase !== null ? r.maeModel < r.maeBase * 0.95 : null;
              return (
                <tr
                  key={r.metric}
                  title={
                    r.n < 3
                      ? "Too few checks to judge yet"
                      : better
                        ? "Trend beat assuming nothing changes"
                        : "No better than assuming nothing changes"
                  }
                >
                  <th>{METRICS[k]?.label ?? r.metric}</th>
                  <td>{r.maeModel === null ? "--" : r.maeModel.toFixed(1)}</td>
                  <td>{r.maeBase === null ? "--" : r.maeBase.toFixed(1)}</td>
                  <td>
                    {r.wins ?? 0}/{r.n}
                    {better === true ? " ✓" : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="note" style={{ marginTop: 8 }}>
        Average error in the sensor&rsquo;s own units. This compares the 10-minute early-warning trend with &ldquo;no change&rdquo;.
      </p>
      <p className="note">
        Early warnings, last 7 days:{" "}
        {decided === 0
          ? "none checked yet"
          : `${p.hit} of ${decided} came true, ${p.miss} false alarm${p.miss === 1 ? "" : "s"}`}
        {p.pending ? `, ${p.pending} still being checked` : ""}.
      </p>
    </>
  );
}

function Summary({ s }: { s: any }) {
  if (!s || s.readings === 0) return <p className="note">No readings in this period.</p>;
  return (
    <>
      <table className="kv">
        <thead>
          <tr>
            <th>Reading</th>
            <td>Low</td>
            <td>Avg</td>
            <td>High</td>
            <td>Off-limit</td>
          </tr>
        </thead>
        <tbody>
          {METRIC_KEYS.map((k) => {
            const m = s.metrics[k];
            return (
              <tr key={k}>
                <th>{METRICS[k].label}</th>
                <td>{fmt(k, m.min)}</td>
                <td>{fmt(k, m.avg)}</td>
                <td>{fmt(k, m.max)}</td>
                <td>{m.pctOutside === null ? "--" : `${Math.round(m.pctOutside)}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="note" style={{ marginTop: 8 }}>
        Off-limit is the share of time outside the comfortable range. {s.alerts} alert{s.alerts === 1 ? "" : "s"},{" "}
        {s.predictive} early warning{s.predictive === 1 ? "" : "s"}, data present for {Math.round(s.coveragePct)}% of the
        period.
      </p>
    </>
  );
}
