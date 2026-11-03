import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { DEFAULT_USER, ensureDefaultUser } from "@/lib/pods";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const sub = b.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return NextResponse.json({ error: "Bad subscription" }, { status: 400 });
    const userId = String(b.userId || DEFAULT_USER.id);
    await ensureDefaultUser(userId);
    const sql = await db();
    await sql`INSERT INTO push_subscriptions (user_id, endpoint, keys) VALUES (${userId}, ${sub.endpoint}, ${JSON.stringify(sub.keys)}::jsonb)
              ON CONFLICT (endpoint) DO UPDATE SET user_id = ${userId}, keys = ${JSON.stringify(sub.keys)}::jsonb`;
    return NextResponse.json({ ok: true });
  } catch (e: any) { return NextResponse.json({ error: String(e?.message ?? e).slice(0, 120) }, { status: 500 }); }
}

export async function DELETE(req: NextRequest) {
  try {
    const b = await req.json();
    const sql = await db();
    await sql`DELETE FROM push_subscriptions WHERE endpoint = ${String(b.endpoint || "")}`;
    return NextResponse.json({ ok: true });
  } catch { return NextResponse.json({ ok: false }, { status: 500 }); }
}
