import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { errorResponse, requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner only: every account, how many pods each has, and the "Get pods" requests from the business page.
export async function GET(req: Request) {
  try {
    const me = await requireUser(req);
    if (me.role !== "admin") return NextResponse.json({ ok: false, error: "Owner access only." }, { status: 403 });
    const sql = await db();
    const users = await sql`
      SELECT u.id, u.email, u.name, (extract(epoch from u.created_at) * 1000)::float8 AS created_ms,
             (SELECT count(*) FROM pods p WHERE p.claimed_by = u.id) AS pods
      FROM users u WHERE u.password_hash IS NOT NULL ORDER BY u.created_at DESC LIMIT 500`;
    const leads = await sql`
      SELECT id, name, email, organisation, message, pods, (extract(epoch from created_at) * 1000)::float8 AS created_ms
      FROM leads ORDER BY created_at DESC LIMIT 200`;
    return NextResponse.json({
      ok: true,
      users: users.map((u: any) => ({ id: u.id, email: u.email, name: u.name, createdAt: Number(u.created_ms), pods: Number(u.pods) })),
      leads: leads.map((l: any) => ({ id: Number(l.id), name: l.name, email: l.email, organisation: l.organisation, message: l.message, pods: l.pods, createdAt: Number(l.created_ms) })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
