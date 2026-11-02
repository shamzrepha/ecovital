import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/alarms: pod gas/fumes alarms raised in the last 3 minutes (the app shows a banner and sounds a siren).
export async function GET() {
  const sql = await db();
  const rows = await sql`
    SELECT e.id, e.device_id, e.message, (extract(epoch from e.ts) * 1000)::float8 AS t, d.name
    FROM events e LEFT JOIN devices d ON d.id = e.device_id
    WHERE e.data->>'alarm' = 'gas' AND e.ts > now() - interval '3 minutes'
    ORDER BY e.ts DESC LIMIT 10`;
  return NextResponse.json({
    alarms: rows.map((r: any) => ({ id: Number(r.id), podId: r.device_id, name: r.name || r.device_id, message: r.message, t: Number(r.t) })),
  });
}
