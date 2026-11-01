"use client";
import { useState } from "react";

export default function LeadForm() {
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setState("sending");
    setError("");
    try {
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(f.entries())),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Could not send. Try again.");
      setState("done");
    } catch (err: any) {
      setError(err.message);
      setState("idle");
    }
  }

  if (state === "done") {
    return (
      <div className="banner info" role="status" style={{ margin: 0 }}>
        Thank you. We have your request and will reply by email.
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="lead-form">
      {error && <div className="banner" role="alert" style={{ margin: 0 }}>{error}</div>}
      <div className="form-row"><label htmlFor="lf-name">Your name</label><input id="lf-name" name="name" className="input" required maxLength={80} autoComplete="name" /></div>
      <div className="form-row"><label htmlFor="lf-email">Email</label><input id="lf-email" name="email" type="email" className="input" required autoComplete="email" /></div>
      <div className="form-row"><label htmlFor="lf-org">School, clinic or company (optional)</label><input id="lf-org" name="organisation" className="input" maxLength={120} autoComplete="organization" /></div>
      <div className="form-row"><label htmlFor="lf-pods">How many pods do you need?</label><input id="lf-pods" name="pods" type="number" min={1} className="input" /></div>
      <div className="form-row"><label htmlFor="lf-msg">Anything we should know?</label><textarea id="lf-msg" name="message" className="input" rows={3} maxLength={1500} /></div>
      <button className="btn primary" disabled={state === "sending"}>{state === "sending" ? "Sending…" : "Request pods"}</button>
    </form>
  );
}
