"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SignupPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [needCode, setNeedCode] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: f.get("name"), email: f.get("email"), password: f.get("password"), setupCode: f.get("setupCode") ?? "" }),
      });
      const j = await res.json();
      if (!res.ok) { if (j.code === "setup-code") setNeedCode(true); throw new Error(j.error || "Could not create the account."); }
      router.replace("/add");
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Create your account</h1>
        <p>Your name, email and a password. That is all we need.</p>
        {error && <div className="banner" role="alert" style={{ margin: 0 }}>{error}</div>}
        <div className="form-row"><label htmlFor="name">Your name</label><input id="name" name="name" className="input" required maxLength={60} autoComplete="name" /></div>
        <div className="form-row"><label htmlFor="email">Email</label><input id="email" name="email" type="email" className="input" required autoComplete="email" /></div>
        <div className="form-row"><label htmlFor="password">Password (8 or more characters)</label><input id="password" name="password" type="password" className="input" required minLength={8} autoComplete="new-password" /></div>
        {needCode && <div className="form-row"><label htmlFor="setupCode">Owner setup code</label><input id="setupCode" name="setupCode" type="password" className="input" autoComplete="off" /></div>}
        <button className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
        <p>Already have an account? <Link href="/login" style={{ textDecoration: "underline" }}>Sign in</Link></p>
      </form>
    </div>
  );
}
