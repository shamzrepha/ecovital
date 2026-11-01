import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { errorResponse, requirePodOwner } from "@/lib/session";

export const runtime = "nodejs";

// POST /api/pods/<id>/sos : sound the SOS alarm on the pod. It plays on the pod's next check-in (within about 5 s).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await requirePodOwner(req, id);
    const sql = await db();
    const recent = await sql`SELECT 1 FROM events WHERE device_id = ${id} AND kind = 'sos' AND ts > now() - interval '10 seconds'`;
    if (recent.length) return NextResponse.json({ ok: false, error: "The SOS alarm was just sent. Wait a few seconds." }, { status: 429 });
    const dev = await sql`SELECT last_seen, name FROM devices WHERE id = ${id}`;
    const lastSeen = dev[0]?.last_seen ? new Date(dev[0].last_seen as string).getTime() : 0;
    const online = Date.now() - lastSeen < 60_000;
    await sql`UPDATE pods SET sos_at = now() WHERE device_id = ${id}`;
    await sql`INSERT INTO events (device_id, kind, status, severity, message, spoken_flag, source)
              VALUES (${id}, 'sos', 'bad', 2, ${`SOS alarm sent from the app by ${user.name}.`}, false, 'app')`;
    return NextResponse.json({
      ok: true,
      online,
      message: online
        ? "SOS alarm sent. The pod will sound it within about 5 seconds."
        : "The pod is offline right now. The alarm sounds only if it reconnects within 2 minutes. Use the pod directly if this is an emergency.",
    });
  } catch (e) {
    return errorResponse(e);
  }
}
