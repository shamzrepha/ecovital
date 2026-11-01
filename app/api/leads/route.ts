import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Public "request pods / talk to us" form on the business page.
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const name = String(b.name ?? "").trim().slice(0, 80);
    const email = String(b.email ?? "").trim().slice(0, 120);
    const organisation = String(b.organisation ?? "").trim().slice(0, 120) || null;
    const message = String(b.message ?? "").trim().slice(0, 1500) || null;
    const pods = Number.isFinite(Number(b.pods)) ? Math.max(0, Math.min(100000, Math.round(Number(b.pods)))) : null;
    if (!name) return NextResponse.json({ ok: false, error: "Tell us your name." }, { status: 400 });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ ok: false, error: "Enter a valid email address." }, { status: 400 });
    const sql = await db();
    const recent = await sql`SELECT count(*) AS n FROM leads WHERE email = ${email.toLowerCase()} AND created_at > now() - interval '1 hour'`;
    if (Number(recent[0]?.n ?? 0) >= 3) return NextResponse.json({ ok: false, error: "We already have your requests. We will reply by email." }, { status: 429 });
    await sql`INSERT INTO leads (name, email, organisation, message, pods) VALUES (${name}, ${email.toLowerCase()}, ${organisation}, ${message}, ${pods})`;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "Could not send. Try again." }, { status: 400 });
  }
}
