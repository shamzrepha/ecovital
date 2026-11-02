"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { speakText, stopSpeaking, useSpeechInput } from "@/components/useSpeech";

const SUGGESTED_QUESTIONS = [
  "Why did the pod speak earlier today?",
  "When was the room dustiest in the last 24 hours?",
  "Is the classroom comfortable right now?",
  "What is the CO2 or PM2.5 in ug/m3 right now?",
  "Does this air quality cause asthma or cure headaches?",
];

function AskInner() {
  const searchParams = useSearchParams();
  const initialPod = searchParams.get("pod") || "demo-node";

  const [nodes, setNodes] = useState<any[]>([]);
  const [podId, setPodId] = useState(initialPod);
  const [messages, setMessages] = useState<any[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [lang, setLang] = useState("en-NG");
  const [readAloud, setReadAloud] = useState(false);
  const speech = useSpeechInput((text) => { setQuestion(text); askQuestion(text); }, lang);

  useEffect(() => {
    try { setReadAloud(localStorage.getItem("ecovital-ask-read") === "1"); setLang(localStorage.getItem("ecovital-ask-lang") || "en-NG"); } catch { /* storage unavailable */ }
    return () => stopSpeaking();
  }, []);

  const loadHistory = useCallback(async (id: string) => {
    const [nRes, cRes] = await Promise.all([
      fetch("/api/nodes", { cache: "no-store" }),
      fetch(`/api/ask?podId=${encodeURIComponent(id)}`, { cache: "no-store" }),
    ]);
    const nJson = await nRes.json();
    const cJson = await cRes.json();
    if (nJson.nodes) setNodes(nJson.nodes);
    setMessages(cJson.messages ?? []);
  }, []);

  useEffect(() => {
    loadHistory(podId);
  }, [podId, loadHistory]);

  async function askQuestion(qText: string) {
    const q = qText.trim();
    if (!q || busy) return;
    setBusy(true);
    setQuestion("");
    const optimistic = [
      ...messages,
      { id: Date.now(), role: "user", content: q, citations: [] },
    ];
    setMessages(optimistic);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ podId, question: q }),
      });
      const j = await res.json();
      if (readAloud && (j.answer || j.error)) speakText(String(j.answer || j.error), lang);
      setMessages([
        ...optimistic,
        {
          id: Date.now() + 1,
          role: "assistant",
          content: j.answer || j.error || "Could not answer right now.",
          citations: j.citations || [],
          source: j.source,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <header className="top">
        <span className="brand">Ask EcoVital (Grounded Room Q&amp;A)</span>
        <span className="crumb">Answers strictly grounded in your pod&rsquo;s measured sensor rows and spoken events</span>
        <span className="spacer" />
        {nodes.length > 0 && (
          <select
            aria-label="Select pod to ask about"
            className="select"
            style={{ width: "auto", fontWeight: 600 }}
            value={podId}
            onChange={(e) => setPodId(e.target.value)}
          >
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} ({n.id})
              </option>
            ))}
          </select>
        )}
        <Link className="btn small" href={`/node/${encodeURIComponent(podId)}`}>
          Open Pod Charts →
        </Link>
      </header>

      <div className="cols">
        <main>
          <section className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>Chat with {podId}</h2>
              <span className="tag-estimated">Grounded AI + Honesty Guard</span>
            </div>

            <div className="chat-box" role="log" aria-live="polite">
              {messages.length === 0 && (
                <div className="note" style={{ padding: 12 }}>
                  Ask anything about <b>{podId}</b>&rsquo;s recent readings or spoken alerts. Try one of the suggested questions below — including the honesty guard tests for CO₂/PM2.5 or medical advice!
                </div>
              )}
              {messages.map((m) => (
                <div key={m.id} className={`chat-msg ${m.role}`}>
                  <div>{m.content}</div>
                  {m.citations && m.citations.length > 0 && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                      {m.citations.map((c: any, idx: number) => (
                        <span key={idx} className="chip" style={{ background: "var(--panel-alt)" }}>
                          📎 {c.label}: <b>{c.detail}</b>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {busy && <div className="note">Checking pod readings and event log...</div>}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                askQuestion(question);
              }}
              style={{ display: "flex", gap: 8, marginTop: 12 }}
            >
              <input
                className="input"
                placeholder={speech.listening ? "Listening... speak now" : "Ask about dust, air index, temperature, humidity, or why the pod spoke..."}
                value={speech.listening && speech.interim ? speech.interim : question}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <button
                type="button"
                className={`btn${speech.listening ? " primary" : ""}`}
                aria-label={speech.listening ? "Stop listening" : "Ask by voice"}
                aria-pressed={speech.listening}
                disabled={busy || !speech.supported}
                title={speech.supported ? "Ask by voice" : "This browser has no speech input. Use Chrome or type."}
                onClick={() => { stopSpeaking(); speech.listening ? speech.stop() : speech.start(); }}
              >
                {speech.listening ? "■ Stop" : "🎤 Speak"}
              </button>
              <button type="submit" className="btn primary" disabled={busy || !question.trim()}>
                Ask
              </button>
            </form>

            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
              <label className="note" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                Voice language
                <select
                  className="select"
                  style={{ width: "auto" }}
                  value={lang}
                  onChange={(e) => { setLang(e.target.value); try { localStorage.setItem("ecovital-ask-lang", e.target.value); } catch { /* ignore */ } }}
                >
                  <option value="en-NG">English (Nigeria), also for Pidgin</option>
                  <option value="ha-NG">Hausa</option>
                  <option value="yo-NG">Yoruba</option>
                  <option value="ig-NG">Igbo</option>
                </select>
              </label>
              <label className="note" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={readAloud}
                  onChange={(e) => { setReadAloud(e.target.checked); if (!e.target.checked) stopSpeaking(); try { localStorage.setItem("ecovital-ask-read", e.target.checked ? "1" : "0"); } catch { /* ignore */ } }}
                />
                Read answers aloud
              </label>
            </div>
            {!speech.supported && (
              <div className="note" style={{ marginTop: 8 }}>This browser has no speech input. Open the app in Chrome, or type your question.</div>
            )}
            {speech.error && <div className="note" role="alert" style={{ marginTop: 8, color: "var(--bad)" }}>{speech.error}</div>}
            <div className="note" style={{ marginTop: 6 }}>Speech is recognised by your browser. Hausa, Yoruba and Igbo recognition depends on the browser and may not be available; if it fails, use English or type.</div>

            <div style={{ marginTop: 14 }}>
              <div className="note" style={{ marginBottom: 6 }}>Suggested questions (click to test):</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {SUGGESTED_QUESTIONS.map((sq) => (
                  <button
                    key={sq}
                    type="button"
                    className="btn small"
                    disabled={busy}
                    onClick={() => askQuestion(sq)}
                  >
                    {sq}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </main>

        <aside className="side">
          <section className="card">
            <h2>How Grounding &amp; Honesty Work</h2>
            <ul style={{ paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6, color: "var(--ink2)" }}>
              <li>
                <b>Only cites real pod rows:</b> Every answer receives only the selected pod&rsquo;s last 24 hours of{" "}
                <code>readings</code> and <code>events</code>.
              </li>
              <li>
                <b>No fake units:</b> Dust and Air quality are always reported as a 0–100% index, never <code>µg/m³</code> or <code>ppm</code>.
              </li>
              <li>
                <b>Sensor honesty guard:</b> If you ask about CO₂, Radon, or PM2.5 mass concentration, EcoVital explicitly replies:{" "}
                <i>&ldquo;I don&rsquo;t have data for that — this pod only measures dust index (0–100%), air index (0–100%), temperature (°C), and humidity (%).&rdquo;</i>
              </li>
              <li>
                <b>Medical safety guard:</b> EcoVital never diagnoses or makes medical claims.
              </li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

export default function AskPage() {
  return (
    <Suspense fallback={<div className="wrap"><div className="skeleton">Loading Ask EcoVital...</div></div>}>
      <AskInner />
    </Suspense>
  );
}
