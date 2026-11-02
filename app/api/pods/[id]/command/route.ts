import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { errorResponse, requirePodOwner } from "@/lib/session";

export const runtime = "nodejs";

const COMMANDS: Record<string, { label: string; done: string }> = {
  identify: { label: "Find this pod", done: "The pod will beep and show its code within about 5 seconds." },
  calibrate: { label: "Recalibrate the air and dust sensors", done: "The pod will recalibrate within about 5 seconds. This only gives good results in clean, fresh air." },
  restart: { label: "Restart the pod", done: "The pod will restart within about 5 seconds and reconnect by itself." },
};

// POST /api/pods/<id>/command {cmd: "identify" | "calibrate" | "restart"} : runs on the pod's next check-in
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await requirePodOwner(req, id);
    const body = await req.json();
    const cmd = String(body.cmd ?? "");
    const info = COMMANDS[cmd];
    if (!info) return NextResponse.json({ ok: false, error: "Unknown command." }, { status: 400 });
    const sql = await db();
    const recent = await sql`SELECT 1 FROM events WHERE device_id = ${id} AND kind = 'command' AND ts > now() - interval '8 seconds'`;
    if (recent.length) return NextResponse.json({ ok: false, error: "A command was just sent. Wait a few seconds." }, { status: 429 });
    const dev = await sql`SELECT last_seen FROM devices WHERE id = ${id}`;
    const lastSeen = dev[0]?.last_seen ? new Date(dev[0].last_seen as string).getTime() : 0;
    const online = Date.now() - lastSeen < 60_000;
    await sql`UPDATE pods SET cmd = ${cmd}, cmd_at = now() WHERE device_id = ${id}`;
    await sql`INSERT INTO events (device_id, kind, status, severity, message, spoken_flag, source)
              VALUES (${id}, 'command', 'ok', 0, ${`${info.label}: sent from the app by ${user.name}.`}, false, 'app')`;
    return NextResponse.json({
      ok: true, online,
      message: online ? info.done : "The pod is offline right now. The command runs only if it reconnects within 3 minutes.",
    });
  } catch (e) {
    return errorResponse(e);
  }
}
