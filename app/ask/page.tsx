"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useMic } from "@/components/useMic";

const SUGGESTED_QUESTIONS = [
  "Is the room comfortable right now?",
  "What will the room be like in the next hour?",
  "Does the weather outside matter today?",
  "Why did the pod speak earlier?",
  "When was the room dustiest in the last 24 hours?",
];

const LANGS: { id: string; label: string; rec: string; machine: boolean }[] = [
  { id: "en-NG", label: "English", rec: "en-NG", machine: false },
  { id: "pcm", label: "Naija Pidgin", rec: "en-NG", machine: true },
  { id: "ig", label: "Igbo", rec: "ig-NG", machine: true },
  { id: "yo", label: "Yoruba", rec: "yo-NG", machine: true },
  { id: "ha", label: "Hausa", rec: "ha-NG", machine: true },
];

type VoiceState = "idle" | "listening" | "thinking" | "speaking";
const newThreadId = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function recognizeNative(lang: string): Promise<string> {
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  return new Promise((resolve, reject) => {
    if (!SR) return reject(new Error("no speech recognition"));
    const r = new SR();
    r.lang = lang; r.interimResults = false; r.maxAlternatives = 1;
    r.onresult = (e: any) => resolve(String(e.results?.[0]?.[0]?.transcript ?? ""));
    r.onerror = () => resolve("");
    r.onend = () => resolve("");
    r.start();
  });
}

function AskInner() {
  const searchParams = useSearchParams();
  const initialPod = searchParams.get("pod") || "";

  const [nodes, setNodes] = useState<any[]>([]);
  const [podId, setPodId] = useState(initialPod);
  const [thread, setThread] = useState<string>("");
  const [threads, setThreads] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);

  // Voice
  const [language, setLanguage] = useState("en-NG");
  const [readAloud, setReadAloud] = useState(false);
  const [live, setLive] = useState(false);
  const [vState, setVState] = useState<VoiceState>("idle");
  const [heard, setHeard] = useState("");
  const [voiceMsg, setVoiceMsg] = useState("");
  const [sttAvailable, setSttAvailable] = useState<boolean | null>(null);
  const mic = useMic();
  const liveRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const threadRef = useRef("");
  const langRef = useRef("en-NG");
  const podRef = useRef("");
  threadRef.current = thread; langRef.current = language; podRef.current = podId;

  useEffect(() => {
    try {
      setLanguage(localStorage.getItem("ev-ask-lang") || "en-NG");
      setReadAloud(localStorage.getItem("ev-ask-read") === "1");
    } catch { /* storage unavailable */ }
    fetch("/api/voice", { cache: "no-store" }).then((r) => r.json()).then((j) => setSttAvailable(!!j.available)).catch(() => setSttAvailable(false));
  }, []);
  const pickLang = (v: string) => { setLanguage(v); try { localStorage.setItem("ev-ask-lang", v); } catch {} };
  const pickRead = (v: boolean) => { setReadAloud(v); try { localStorage.setItem("ev-ask-read", v ? "1" : "0"); } catch {} };

  // Pods, then the chats for the chosen pod
  useEffect(() => {
    fetch("/api/nodes", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (j.nodes) {
        setNodes(j.nodes);
        if (!podId && j.nodes.length) setPodId(j.nodes[0].id);
      }
    });
  }, [podId]);

  const loadThreads = useCallback(async (id: string) => {
    const j = await fetch(`/api/ask?podId=${encodeURIComponent(id)}&threads=1`, { cache: "no-store" }).then((r) => r.json());
    setThreads(j.threads ?? []);
    return (j.threads ?? []) as any[];
  }, []);

  const openThread = useCallback(async (id: string, tid: string) => {
    setThread(tid);
    const j = await fetch(`/api/ask?podId=${encodeURIComponent(id)}&thread=${encodeURIComponent(tid)}`, { cache: "no-store" }).then((r) => r.json());
    setMessages(j.messages ?? []);
  }, []);

  useEffect(() => {
    if (!podId) return;
    (async () => {
      const list = await loadThreads(podId);
      if (list.length) await openThread(podId, list[0].id);
      else { setThread(newThreadId()); setMessages([]); }
    })();
  }, [podId, loadThreads, openThread]);

  // Keep the newest message in view
  useEffect(() => {
    const box = chatRef.current;
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  function newChat() {
    stopAll();
    setThread(newThreadId());
    setMessages([]);
    setHeard("");
  }

  async function deleteChat() {
    if (!thread || !confirm("Delete this chat?")) return;
    await fetch(`/api/ask?podId=${encodeURIComponent(podId)}&thread=${encodeURIComponent(thread)}`, { method: "DELETE" });
    const list = await loadThreads(podId);
    if (list.length) await openThread(podId, list[0].id);
    else newChat();
  }

  // ----- speaking -----
  function stopSpeaking() {
    try { audioRef.current?.pause(); audioRef.current = null; window.speechSynthesis?.cancel(); } catch {}
  }

  async function speak(text: string) {
    setVState("speaking");
    try {
      const res = await fetch("/api/speak", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, lang: langRef.current }),
      });
      if (!res.ok) throw new Error("speech unavailable");
      const url = URL.createObjectURL(await res.blob());
      await new Promise<void>((resolve, reject) => {
        const a = new Audio(url);
        audioRef.current = a;
        a.onended = () => resolve();
        a.onerror = () => reject(new Error("playback failed"));
        a.play().catch(reject);
      });
      URL.revokeObjectURL(url);
    } catch {
      // The server voice is not available: use the browser's own voice so it still talks.
      await new Promise<void>((resolve) => {
        try {
          const u = new SpeechSynthesisUtterance(text);
          u.lang = LANGS.find((l) => l.id === langRef.current)?.rec ?? "en-NG";
          u.onend = () => resolve(); u.onerror = () => resolve();
          window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
        } catch { resolve(); }
      });
    } finally {
      audioRef.current = null;
      setVState((s) => (s === "speaking" ? "idle" : s));
    }
  }

  // ----- asking -----
  async function askQuestion(qText: string, spokenAloud = false): Promise<string | null> {
    const q = qText.trim();
    if (!q || busy) return null;
    setBusy(true);
    setQuestion("");
    const tid = threadRef.current || newThreadId();
    if (!threadRef.current) setThread(tid);
    setMessages((m) => [...m, { id: "u" + Date.now(), role: "user", content: q, citations: [] }]);
    let answer: string | null = null;
    try {
      const res = await fetch("/api/ask", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ podId: podRef.current, question: q, thread: tid, language: langRef.current }),
      });
      const j = await res.json();
      answer = j.answer || j.error || "Could not answer right now.";
      setMessages((m) => [...m, { id: "a" + Date.now(), role: "assistant", content: answer, citations: j.citations || [], source: j.source, machine: !!j.machineTranslated }]);
      loadThreads(podRef.current);
    } catch {
      answer = "I could not reach the server. Check your connection and try again.";
      setMessages((m) => [...m, { id: "a" + Date.now(), role: "assistant", content: answer, citations: [] }]);
    } finally {
      setBusy(false);
    }
    if (answer && (readAloud || spokenAloud || liveRef.current)) await speak(answer);
    else setVState("idle");
    return answer;
  }

  // ----- listening -----
  async function listenOnce(): Promise<string> {
    stopSpeaking();
    setVoiceMsg("");
    setHeard("");
    setVState("listening");
    try {
      let text = "";
      if (sttAvailable === false) {
        text = await recognizeNative(LANGS.find((l) => l.id === langRef.current)?.rec ?? "en-NG");
      } else {
        const { wav } = await mic.listen();
        if (!wav) { setVState("idle"); return ""; }
        setVState("thinking");
        const res = await fetch(`/api/voice?lang=${encodeURIComponent(langRef.current)}`, { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "I could not understand that recording.");
        text = String(j.text ?? "");
      }
      setHeard(text);
      if (!text.trim()) setVState("idle");
      return text.trim();
    } catch (e: any) {
      setVoiceMsg(
        e?.name === "NotAllowedError" ? "The microphone is blocked. Allow microphone access for this site and try again."
          : e?.message === "no speech recognition" ? "Voice typing needs the Gemini key on the server, or a browser with speech recognition such as Chrome."
          : e?.message || "Could not use the microphone.",
      );
      setVState("idle");
      return "";
    }
  }

  async function talkOnce() {
    if (vState === "listening") { mic.stop(); return; }
    if (vState === "speaking") { stopSpeaking(); setVState("idle"); return; }
    const text = await listenOnce();
    if (text) await askQuestion(text, true);
    else if (!voiceMsg) setVoiceMsg("I did not hear anything. Tap the microphone and speak.");
  }

  async function startLive() {
    liveRef.current = true; setLive(true);
    let quiet = 0;
    while (liveRef.current) {
      const text = await listenOnce();
      if (!liveRef.current) break;
      if (!text) { if (++quiet >= 2) { setVoiceMsg("I did not hear anything, so I stopped listening."); break; } continue; }
      quiet = 0;
      await askQuestion(text, true);
    }
    stopAll();
  }

  function stopAll() {
    liveRef.current = false; setLive(false);
    mic.stop(); stopSpeaking(); setVState("idle");
  }
  useEffect(() => () => { liveRef.current = false; }, []);

  const podName = nodes.find((n) => n.id === podId)?.name ?? "your pod";
  const stateLabel = { idle: "Tap the microphone and talk", listening: "Listening… talk now", thinking: "Thinking…", speaking: "Speaking… tap to stop" }[vState];
  const langInfo = LANGS.find((l) => l.id === language);

  return (
    <div className="wrap">
      <header className="top">
        <span className="brand">Ask EcoVital</span>
        <span className="crumb">Plain answers about {podName}, from its own readings and forecast</span>
        <span className="spacer" />
        {nodes.length > 1 && (
          <select aria-label="Select pod to ask about" className="select" style={{ width: "auto", fontWeight: 600 }} value={podId} onChange={(e) => setPodId(e.target.value)}>
            {nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
        )}
        {podId && <Link className="btn small" href={`/node/${encodeURIComponent(podId)}`}>Open pod charts →</Link>}
      </header>

      <div className="cols">
        <main>
          <section className="card vc" aria-label="Voice">
            <div className="vc-top">
              <h2 style={{ margin: 0 }}>Talk to EcoVital</h2>
              <div className="vc-opts">
                <label className="vc-lang">
                  <span>Language</span>
                  <select className="select" value={language} onChange={(e) => pickLang(e.target.value)}>
                    {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </select>
                </label>
                <label className="vc-check">
                  <input type="checkbox" checked={readAloud} onChange={(e) => pickRead(e.target.checked)} /> Read answers aloud
                </label>
              </div>
            </div>

            <div className="vc-stage">
              <button
                type="button"
                className={`vc-mic ${vState}`}
                onClick={talkOnce}
                disabled={!podId || busy || live}
                aria-label={vState === "listening" ? "Stop listening" : "Start talking"}
                style={vState === "listening" ? { boxShadow: `0 0 0 ${6 + mic.level * 26}px color-mix(in srgb, var(--brand-leaf) 22%, transparent)` } : undefined}
              >
                {vState === "speaking" ? "🔊" : vState === "thinking" ? "…" : "🎤"}
              </button>
              <p className="vc-state" role="status">{live && vState === "idle" ? "Live conversation is on" : stateLabel}</p>
              {heard && <p className="vc-heard">You said: <q>{heard}</q></p>}
              {voiceMsg && <p className="vc-err" role="alert">{voiceMsg}</p>}
            </div>

            <div className="vc-actions">
              {!live ? (
                <button type="button" className="btn primary" onClick={startLive} disabled={!podId || busy}>Start a live conversation</button>
              ) : (
                <button type="button" className="btn danger" onClick={stopAll}>Stop live conversation</button>
              )}
              <span className="note">
                {live ? "I will keep listening after each answer. Stop whenever you like." : "In a live conversation I listen, answer out loud, then listen again, hands free."}
                {langInfo?.machine && " Answers in this language are machine-written and may have mistakes."}
              </span>
            </div>
          </section>

          <section className="card" style={{ marginTop: 16 }}>
            <div className="chat-bar">
              <select className="select" aria-label="Earlier chats" value={threads.some((t) => t.id === thread) ? thread : "__new"} onChange={(e) => e.target.value !== "__new" && (stopAll(), openThread(podId, e.target.value))}>
                {!threads.some((t) => t.id === thread) && <option value="__new">New chat</option>}
                {threads.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
              <button type="button" className="btn small primary" onClick={newChat}>＋ New chat</button>
              <button type="button" className="btn small" onClick={deleteChat} disabled={!threads.some((t) => t.id === thread)}>Delete chat</button>
            </div>

            <div className="chat-box" role="log" aria-live="polite" ref={chatRef}>
              {messages.length === 0 && (
                <div className="note" style={{ padding: 12 }}>
                  Ask anything about {podName}&rsquo;s recent readings, what will happen next, or the weather outside. Type below, or use the microphone above.
                </div>
              )}
              {messages.map((m) => (
                <div key={m.id} className={`chat-msg ${m.role}`}>
                  <div>{m.content}</div>
                  {m.role === "assistant" && m.machine && <div className="note" style={{ marginTop: 4 }}>Machine-written in {langInfo?.label}. It may have mistakes.</div>}
                  {m.citations && m.citations.length > 0 && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                      {m.citations.map((c: any, idx: number) => (
                        <span key={idx} className="chip" style={{ background: "var(--panel-alt)" }}>📎 {c.label}: <b>{c.detail}</b></span>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" && (
                    <button type="button" className="btn small" style={{ marginTop: 8 }} onClick={() => speak(m.content)}>🔊 Listen</button>
                  )}
                </div>
              ))}
              {busy && <div className="note">Looking at your pod&rsquo;s readings…</div>}
            </div>

            <form onSubmit={(e) => { e.preventDefault(); askQuestion(question); }} style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <input className="input" placeholder="Ask about the air, what happens next, or why the pod spoke…" value={question} onChange={(e) => setQuestion(e.target.value)} />
              <button type="submit" className="btn primary" disabled={busy || !question.trim() || !podId}>Ask</button>
            </form>

            <div style={{ marginTop: 14 }}>
              <div className="note" style={{ marginBottom: 6 }}>Try asking:</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {SUGGESTED_QUESTIONS.map((sq) => (
                  <button key={sq} type="button" className="btn small" disabled={busy || !podId} onClick={() => askQuestion(sq)}>{sq}</button>
                ))}
              </div>
            </div>
          </section>
        </main>

        <aside className="side">
          <section className="card">
            <h2>How answers are made</h2>
            <ul style={{ paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6, color: "var(--ink2)" }}>
              <li><b>From your pod&rsquo;s real data:</b> the last 24 hours of readings, what the pod said, and its forecast for the next hour.</li>
              <li><b>The forecast and the weather</b> are estimates, and are always called that.</li>
              <li><b>Follow-ups work.</b> Say &ldquo;yes&rdquo; or &ldquo;why?&rdquo; and it carries on from its last answer.</li>
              <li><b>Dust and air are 0 to 100 scores,</b> never µg/m³ or ppm, and nothing here is medical advice.</li>
              <li><b>Languages:</b> Pidgin, Igbo, Yoruba and Hausa are machine-written and spoken, so they may have mistakes.</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

export default function AskPage() {
  return (
    <Suspense fallback={<div className="wrap"><div className="skeleton">Loading Ask EcoVital…</div></div>}>
      <AskInner />
    </Suspense>
  );
}
