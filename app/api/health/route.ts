import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { aiStats } from "@/lib/gemini-models";
import { isFcmConfigured, countFcmPhones } from "@/lib/fcm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health: is the server set up for pods, and which pods has it heard from (or turned away)?
// Shows no secrets.
export async function GET(req: Request) {
  const me = await getSessionUser(req).catch(() => null);
  const effKey = process.env.DEVICE_KEY || "";
  const out: any = {
    ok: true,
    deviceKeyConfigured: !!effKey,
    adminKeyConfigured: true,
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    geminiLastOkAt: aiStats.lastOkAt ? new Date(aiStats.lastOkAt).toISOString() : null,
    geminiLastError: aiStats.lastError || null,
    lastGeminiError: aiStats.lastError || null,
    fcmConfigured: isFcmConfigured(),
    fcmPhones: 0,
    database: "unknown",
    contacts: [] as any[],
  };
  try {
    const sql = await db();
    try {
      out.fcmPhones = await countFcmPhones();
    } catch { /* fcm table not queried yet */ }
    const rows = await sql`SELECT device_id, result, fw, (extract(epoch from last_at) * 1000)::float8 AS t FROM pod_contact ORDER BY last_at DESC LIMIT 10`;
    out.database = "ok";
    if (me?.role === "admin") out.contacts = rows.map((r: any) => ({ deviceId: r.device_id, result: r.result, fw: r.fw, secondsAgo: Math.round((Date.now() - Number(r.t)) / 1000) }));

    // Persistent check in ai_logs
    try {
      const okRow = await sql`SELECT (extract(epoch from max(ts)) * 1000)::float8 AS last_ok FROM ai_logs WHERE source = 'gemini'`;
      if (okRow[0]?.last_ok) {
        const dbLastOk = new Date(Number(okRow[0].last_ok)).toISOString();
        if (!out.geminiLastOkAt || new Date(dbLastOk).getTime() > new Date(out.geminiLastOkAt).getTime()) {
          out.geminiLastOkAt = dbLastOk;
        }
      }
      const errRow = await sql`SELECT output->>'error' AS err FROM ai_logs WHERE output->>'error' IS NOT NULL ORDER BY ts DESC LIMIT 1`;
      if (errRow[0]?.err && !out.geminiLastError) {
        out.geminiLastError = errRow[0].err;
        out.lastGeminiError = errRow[0].err;
      }
    } catch { /* ai_logs not ready yet */ }
  } catch (e: any) {
    out.database = "error: " + String(e?.message ?? e).slice(0, 120);
    out.ok = false;
  }
  return NextResponse.json(out);
}
