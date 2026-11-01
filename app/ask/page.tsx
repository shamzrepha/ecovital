"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

const SUGGESTED_QUESTIONS = [
  "Why did the pod speak earlier today?",
  "When was the room dustiest in the last 24 hours?",
  "Is the classroom comfortable right now?",
  "What is the CO2 or PM2.5 in ug/m3 right now?",
  "Does this air quality cause asthma or cure headaches?",
];

function AskInner() {
  const searchParams = useSearchParams();
  const initialPod = searchParams.get("pod") || "";

  const [nodes, setNodes] = useState<any[]>([]);
  const [podId, setPodId] = useState(initialPod);
  const [messages, setMessages] = useState<any[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);

  const loadHistory = useCallback(async (id: string) => {
    const nJson = await fetch("/api/nodes", { cache: "no-store" }).then((r) => r.json());
    if (nJson.nodes) {
      setNodes(nJson.nodes);
      if (!id && nJson.nodes.length) { setPodId(nJson.nodes[0].id); return; }
    }
    if (!id) return;
    const cJson = await fetch(`/api/ask?podId=${encodeURIComponent(id)}`, { cache: "no-store" }).then((r) => r.json());
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
                placeholder="Ask about dust, air index, temperature, humidity, or why the pod spoke..."
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <button type="submit" className="btn primary" disabled={busy || !question.trim()}>
                Ask
              </button>
            </form>

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
