import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(req);
    const sql = await db();

    // Query any critical alarm within the last 2 minutes for this user's pods
    const recentAlarms = user
      ? await sql`
          SELECT e.id, e.device_id, e.kind, e.metric, e.status, e.message, e.data, e.ts,
                 p.nickname, d.name AS device_name
          FROM events e
          JOIN pods p ON p.device_id = e.device_id
          LEFT JOIN devices d ON d.id = e.device_id
          WHERE p.claimed_by = ${user.id}
            AND (
              (e.data->>'alarm' = 'gas')
              OR (e.metric = 'air' AND e.status = 'bad-low')
              OR (e.metric = 'dust' AND e.status = 'bad-high')
              OR (e.kind = 'sos')
            )
            AND e.ts > (NOW() - INTERVAL '2 minutes')
          ORDER BY e.ts DESC
          LIMIT 1
        `
      : [];

    if (recentAlarms.length > 0) {
      const alarm = recentAlarms[0];
      const podName = alarm.nickname || alarm.device_name || alarm.device_id;
      const isSmoke = (alarm.data?.cause === "smoke") || String(alarm.message || "").toLowerCase().includes("smoke");
      return NextResponse.json({
        active: true,
        alert: {
          id: alarm.id,
          podId: alarm.device_id,
          podName,
          cause: isSmoke ? "smoke" : "gas",
          title: isSmoke ? "🚨 Emergency: Smoke or Burning Likely" : "🚨 Emergency: Possible Gas or Fumes",
          message: alarm.message || "Dangerous air levels detected in room.",
          ts: new Date(alarm.ts).getTime(),
        },
      });
    }

    return NextResponse.json({ active: false, alert: null });
  } catch (e: any) {
    return NextResponse.json({ active: false, error: e?.message }, { status: 500 });
  }
}
