import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health: is the server set up for pods, and which pods has it heard from (or turned away)?
// Shows no secrets.
export async function GET() {
  const out: any = {
    ok: true,
    deviceKeyConfigured: !!process.env.DEVICE_KEY,
    adminKeyConfigured: !!(process.env.ADMIN_KEY || process.env.DEVICE_KEY),
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    database: "unknown",
    contacts: [] as any[],
  };
  try {
    const sql = await db();
    const rows = await sql`SELECT device_id, result, fw, (extract(epoch from last_at) * 1000)::float8 AS t FROM pod_contact ORDER BY last_at DESC LIMIT 10`;
    out.database = "ok";
    out.contacts = rows.map((r: any) => ({ deviceId: r.device_id, result: r.result, fw: r.fw, secondsAgo: Math.round((Date.now() - Number(r.t)) / 1000) }));
  } catch (e: any) {
    out.database = "error: " + String(e?.message ?? e).slice(0, 120);
    out.ok = false;
  }
  return NextResponse.json(out);
}
