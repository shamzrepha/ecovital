"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useMic } from "@/components/useMic";

const LANGS: { id: string; label: string; flag: string; prompt: string; machine: boolean }[] = [
  { id: "en-NG", label: "Nigerian English", flag: "🇳🇬", prompt: "clear Nigerian English", machine: false },
  { id: "pcm", label: "Naija Pidgin", flag: "🇳🇬", prompt: "warm Naija Pidgin", machine: true },
  { id: "ig", label: "Igbo", flag: "🇳🇬", prompt: "clear Igbo", machine: true },
  { id: "yo", label: "Yoruba", flag: "🇳🇬", prompt: "clear Yoruba", machine: true },
  { id: "ha", label: "Hausa", flag: "🇳🇬", prompt: "clear Hausa", machine: true },
];

const SUGGESTED_VOICE_QUESTIONS = [
  "How comfortable is the room right now?",
  "What is the forecast for the next hour?",
  "Why did the pod speak earlier?",
  "Does the outside weather matter today?",
  "What simple thing should I do to improve the air?",
];

type VoiceState = "idle" | "listening" | "thinking" | "speaking";

function VoiceCenterInner() {
  const searchParams = useSearchParams();
  const initialPod = searchParams.get("pod") || "";

  const [nodes, setNodes] = useState<any[]>([]);
  const [podId, setPodId] = useState(initialPod);
  const [language, setLanguage] = useState("en-NG");
  const [vState, setVState] = useState<VoiceState>("idle");
  const [heard, setHeard] = useState("");
  const [answer, setAnswer] = useState("");
  const [answerSource, setAnswerSource] = useState<"gemini" | "template" | null>(null);
  const [citations, setCitations] = useState<any[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [speakNote, setSpeakNote] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [lastAudioB64, setLastAudioB64] = useState<string | null>(null);

  const mic = useMic();
  const playCtxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const playTokenRef = useRef(0);
  const vStateRef = useRef<VoiceState>("idle");
  const podRef = useRef("");
  const langRef = useRef("en-NG");
  podRef.current = podId;
  langRef.current = language;
  vStateRef.current = vState;

  useEffect(() => {
    try {
      setLanguage(localStorage.getItem("ev-voice-lang") || "en-NG");
    } catch { /* storage unavailable */ }
  }, []);

  const selectLanguage = (l: string) => {
    setLanguage(l);
    try { localStorage.setItem("ev-voice-lang", l); } catch { /* ignore */ }
  };

  useEffect(() => {
    fetch("/api/nodes", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (j.nodes && Array.isArray(j.nodes)) {
          setNodes(j.nodes);
          if (!podId && j.nodes.length) setPodId(j.nodes[0].id);
        }
      })
      .catch(() => {});
  }, [podId]);

  function unlockAudio() {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!playCtxRef.current) playCtxRef.current = new Ctx();
      const ctx = playCtxRef.current!;
      ctx.resume().catch(() => {});
      const b = ctx.createBuffer(1, 1, 24000);
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.connect(ctx.destination);
      src.start(0);
      window.speechSynthesis?.getVoices();
    } catch { /* audio context error */ }
  }

  function stopSpeaking() {
    playTokenRef.current++;
    try {
      if (srcRef.current) {
        srcRef.current.onended = null;
        srcRef.current.stop();
        srcRef.current.disconnect();
        srcRef.current = null;
      }
    } catch { /* ignore */ }
    try {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    } catch { /* ignore */ }
    setVState("idle");
    setSpeakNote("");
  }

  async function playAudioBuffer(buf: ArrayBuffer, token: number): Promise<boolean> {
    unlockAudio();
    if (!playCtxRef.current) return false;
    const ctx = playCtxRef.current;
    await ctx.resume();
    const audio = await ctx.decodeAudioData(buf);
    if (token !== playTokenRef.current) return false; // Stale trigger aborted
    return new Promise<boolean>((resolve) => {
      try {
        if (srcRef.current) {
          srcRef.current.onended = null;
          srcRef.current.stop();
          srcRef.current.disconnect();
          srcRef.current = null;
        }
      } catch {}
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(ctx.destination);
      srcRef.current = src;
      src.onended = () => {
        if (srcRef.current === src) srcRef.current = null;
        resolve(true);
      };
      src.start();
    });
  }

  async function playVoiceResponse(b64Audio: string | null, text: string) {
    stopSpeaking();
    const token = ++playTokenRef.current;
    setVState("speaking");
    setSpeakNote("Playing voice answer…");
    setAudioBlocked(false);

    if (b64Audio) {
      try {
        const bin = atob(b64Audio);
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        const played = await playAudioBuffer(bytes.buffer, token);
        if (token === playTokenRef.current) {
          setVState("idle");
          setSpeakNote("");
        }
        if (played) return;
      } catch (e: any) {
        if (e?.name === "NotAllowedError") {
          setAudioBlocked(true);
        }
      }
    }

    if (token !== playTokenRef.current) return;

    // Fall back to browser speech synthesis
    try {
      const synth = window.speechSynthesis;
      if (synth) {
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = language === "pcm" ? "en-NG" : language.startsWith("en") ? "en-NG" : language;
        u.onend = () => {
          if (token === playTokenRef.current) {
            setVState("idle");
            setSpeakNote("");
          }
        };
        u.onerror = () => {
          if (token === playTokenRef.current) {
            setVState("idle");
            setSpeakNote("");
          }
        };
        synth.speak(u);
        return;
      }
    } catch { /* speech synthesis unavailable */ }
    if (token === playTokenRef.current) {
      setVState("idle");
      setSpeakNote("");
    }
  }

  const askByVoice = useCallback(async () => {
    if (vStateRef.current === "listening" || vStateRef.current === "thinking") return;
    stopSpeaking();
    setErrorMsg("");
    setAudioBlocked(false);
    unlockAudio();

    if (!podRef.current) {
      setErrorMsg("Please select an active pod first.");
      return;
    }

    setVState("listening");
    try {
      const { wav, heardSpeech } = await mic.listen(1400);
      if (!wav || !heardSpeech) {
        setVState("idle");
        setErrorMsg("No voice heard. Hold or tap the mic and speak clearly.");
        return;
      }

      setVState("thinking");
      setSpeakNote("Transcribing and analyzing pod data…");

      const res = await fetch(`/api/voice?podId=${encodeURIComponent(podRef.current)}&lang=${encodeURIComponent(langRef.current)}`, {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: wav,
      });

      const j = await res.json();
      if (!res.ok) {
        throw new Error(j.error || "Could not process voice request.");
      }

      setHeard(j.transcript || "Spoken question");
      setAnswer(j.answer || "No response received.");
      setAnswerSource(j.source || "template");
      setCitations(j.citations || []);
      setLastAudioB64(j.audio || null);

      if (j.audio || j.answer) {
        await playVoiceResponse(j.audio, j.answer);
      } else {
        setVState("idle");
      }
    } catch (e: any) {
      setVState("idle");
      setSpeakNote("");
      setErrorMsg(String(e?.message ?? e));
    }
  }, [mic]);

  const activeNode = nodes.find((n) => n.id === podId);
  const langObj = LANGS.find((l) => l.id === language) ?? LANGS[0];

  return (
    <div className="wrap">
      <header className="top">
        <span className="brand">EcoVital Voice Center</span>
        <span className="crumb">Hands-free Nigerian voice Q&amp;A grounded in your real pod data</span>
      </header>

      {audioBlocked && (
        <div className="banner info" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Autoplay was blocked by your browser. Tap to hear the spoken answer.</span>
          <button
            className="btn small primary"
            onClick={() => {
              unlockAudio();
              setAudioBlocked(false);
              if (lastAudioB64 && answer) playVoiceResponse(lastAudioB64, answer);
            }}
          >
            🔊 Tap to hear
          </button>
        </div>
      )}

      {errorMsg && <div className="banner warn" role="alert">{errorMsg}</div>}

      <div className="cols">
        <main>
          <section className="card" style={{ textAlign: "center", padding: "28px 20px" }}>
            <div style={{ display: "flex", justifyContent: "center", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
              <label style={{ fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
                <b>Active Pod:</b>
                <select className="select" value={podId} onChange={(e) => setPodId(e.target.value)}>
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>{n.name} ({n.id})</option>
                  ))}
                </select>
              </label>

              <label style={{ fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
                <b>Spoken Language:</b>
                <select className="select" value={language} onChange={(e) => selectLanguage(e.target.value)}>
                  {LANGS.map((l) => (
                    <option key={l.id} value={l.id}>{l.flag} {l.label}</option>
                  ))}
                </select>
              </label>
            </div>

            <div style={{ margin: "24px 0" }}>
              <button
                type="button"
                className={`vc-mic ${vState}`}
                onClick={vState === "listening" ? mic.stop : askByVoice}
                disabled={!podId || vState === "thinking"}
                aria-label={vState === "listening" ? "Listening... click to stop" : "Start speaking"}
                style={{
                  width: 96,
                  height: 96,
                  fontSize: 38,
                  borderRadius: "50%",
                  border: "none",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  boxShadow: vState === "listening"
                    ? `0 0 0 ${8 + mic.level * 32}px color-mix(in srgb, var(--brand-leaf, #16a34a) 25%, transparent)`
                    : "0 4px 14px rgba(0,0,0,0.12)",
                }}
              >
                {vState === "speaking" ? "🔊" : vState === "thinking" ? "…" : vState === "listening" ? "⏹" : "🎤"}
              </button>

              <p style={{ marginTop: 14, fontSize: 16, fontWeight: 600, color: "var(--brand-deep)" }}>
                {vState === "listening"
                  ? "Listening… speak your question now"
                  : vState === "thinking"
                  ? "Thinking & analyzing pod data…"
                  : vState === "speaking"
                  ? "Speaking answer out loud…"
                  : "Tap the microphone to speak"}
              </p>
              {speakNote && <p className="note" style={{ fontSize: 13 }}>{speakNote}</p>}
            </div>

            {heard && (
              <div style={{ margin: "16px auto", maxWidth: 520, padding: 12, background: "var(--panel-alt)", borderRadius: 10 }}>
                <span style={{ fontSize: 12, textTransform: "uppercase", fontWeight: 700, color: "var(--ink2)" }}>You Asked:</span>
                <p style={{ margin: "4px 0 0", fontSize: 16, fontStyle: "italic" }}>&ldquo;{heard}&rdquo;</p>
              </div>
            )}

            {answer && (
              <div style={{ margin: "20px auto 0", maxWidth: 600, textAlign: "left", padding: 16, border: "1px solid var(--border)", borderRadius: 12, background: "var(--panel)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                  <span style={{ fontSize: 12, textTransform: "uppercase", fontWeight: 700, color: "var(--ink2)" }}>
                    {activeNode?.name || "EcoVital Pod"} Answer:
                  </span>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {answerSource === "gemini" ? (
                      <span className="chip good">Gemini Voice</span>
                    ) : (
                      <span className="chip warn" style={{ background: "color-mix(in srgb, var(--brand-rust, #e65100) 15%, transparent)", color: "var(--brand-rust, #e65100)", fontWeight: 600 }}>
                        AI unavailable, using built-in advice
                      </span>
                    )}
                    {langObj.machine && (
                      <span className="chip">Machine-spoken ({langObj.label})</span>
                    )}
                  </div>
                </div>

                <p style={{ fontSize: 15, lineHeight: 1.6, margin: "6px 0 12px" }}>{answer}</p>

                {citations.length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                    {citations.map((c, i) => (
                      <span key={i} className="chip" style={{ background: "var(--panel-alt)" }}>📎 {c.label}: <b>{c.detail}</b></span>
                    ))}
                  </div>
                )}

                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <button
                    type="button"
                    className="btn small primary"
                    onClick={() => {
                      unlockAudio();
                      playVoiceResponse(lastAudioB64, answer);
                    }}
                  >
                    🔊 Replay voice
                  </button>
                  {vState === "speaking" && (
                    <button type="button" className="btn small" onClick={stopSpeaking}>
                      ⏹ Stop voice
                    </button>
                  )}
                  <Link href={`/ask?pod=${encodeURIComponent(podId)}`} className="btn small">
                    Open in Ask Chat ↗
                  </Link>
                </div>
              </div>
            )}

            <div style={{ marginTop: 28, textAlign: "left" }}>
              <div className="note" style={{ marginBottom: 8 }}>Or try asking out loud:</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {SUGGESTED_VOICE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="btn small"
                    disabled={vState !== "idle"}
                    onClick={async () => {
                      setHeard(q);
                      setVState("thinking");
                      setSpeakNote("Looking up real pod readings…");
                      try {
                        const res = await fetch("/api/ask", {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ podId, question: q, language }),
                        });
                        const j = await res.json();
                        setAnswer(j.answer || j.error);
                        setAnswerSource(j.source || "template");
                        setCitations(j.citations || []);
                        setLastAudioB64(null);
                        await playVoiceResponse(null, j.answer);
                      } catch (err: any) {
                        setErrorMsg(String(err?.message ?? err));
                        setVState("idle");
                      }
                    }}
                  >
                    💬 {q}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </main>

        <aside className="side">
          <section className="card">
            <h2>Voice Center Guide</h2>
            <ul style={{ paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6, color: "var(--ink2)" }}>
              <li><b>Real Grounded Answers:</b> Uses the pod&rsquo;s actual 24-hour readings, temperature, dust, humidity and air freshness.</li>
              <li><b>Nigerian Languages:</b> Supports English, Naija Pidgin, Igbo, Yoruba and Hausa.</li>
              <li><b>Speech Synthesis:</b> Speaks the answer aloud in high-clarity 24 kHz audio.</li>
              <li><b>Privacy Guaranteed:</b> Voice recordings are never stored on disk or database — only the text transcript is saved in your chat history.</li>
              <li><b>Safe &amp; Honest:</b> Air and dust are simple 0–100 scores; never gives fake units or medical diagnosis.</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

export default function VoiceCenterPage() {
  return (
    <Suspense fallback={<div className="wrap"><p>Loading Voice Center…</p></div>}>
      <VoiceCenterInner />
    </Suspense>
  );
}
