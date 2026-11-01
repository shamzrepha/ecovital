"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: f.get("email"), password: f.get("password") }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Could not sign in.");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Sign in</h1>
        <p>Welcome back. See your rooms and what your pods have been saying.</p>
        {error && <div className="banner" role="alert" style={{ margin: 0 }}>{error}</div>}
        <div className="form-row"><label htmlFor="email">Email</label><input id="email" name="email" type="email" className="input" required autoComplete="email" /></div>
        <div className="form-row"><label htmlFor="password">Password</label><input id="password" name="password" type="password" className="input" required autoComplete="current-password" /></div>
        <button className="btn primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p>New here? <Link href="/signup" style={{ textDecoration: "underline" }}>Create an account</Link></p>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
