import { NextRequest, NextResponse } from "next/server";
import { db, iso } from "@/lib/db";
import { errorResponse, requireUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const me = await requireUser(req);
    const sql = await db();
    const rows = await sql`SELECT id, email, name, role, prefs FROM users WHERE id = ${me.id}`;
    const notifs = await sql`
      SELECT id, device_id, channel, title, body, (extract(epoch from sent_at) * 1000)::float8 AS sent_ms
      FROM notifications_log WHERE user_id = ${me.id}
      ORDER BY sent_at DESC LIMIT 25
    `;
    const u = rows[0];
    const prefs = u.prefs || {};
    return NextResponse.json({
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        language: prefs.language || "en-NG",
        voice: prefs.voice || "Kore",
        voiceSpeed: prefs.voiceSpeed || "normal",
        quietEnabled: prefs.quietEnabled === true,
        quietStart: Number(prefs.quietStartHour ?? 22),
        quietEnd: Number(prefs.quietEndHour ?? 7),
        notifyMetrics: prefs.metrics || { dust: true, air: true, temp: true, hum: true },
      },
      notifications: notifs.map((n: any) => ({
        id: Number(n.id),
        podId: n.device_id,
        title: n.title,
        body: n.body,
        delivered: true,
        createdAt: iso(Number(n.sent_ms)),
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const me = await requireUser(req);
    const body = await req.json();
    const name = String(body.name || me.name).trim().slice(0, 60) || me.name;
    const language = ["en-NG", "ig", "yo", "ha"].includes(body.language) ? body.language : "en-NG";
    const voice = String(body.voice || "Kore");
    const voiceSpeed = ["slow", "normal", "fast"].includes(body.voiceSpeed) ? body.voiceSpeed : "normal";
    const quietStartHour = Math.max(0, Math.min(23, Number(body.quietStart ?? 22)));
    const quietEndHour = Math.max(0, Math.min(23, Number(body.quietEnd ?? 7)));
    const metrics = body.notifyMetrics || { dust: true, air: true, temp: true, hum: true };

    const prefs = {
      language,
      voice,
      voiceSpeed,
      quietEnabled: body.quietEnabled !== false,
      quietStartHour,
      quietEndHour,
      quietStart: `${String(quietStartHour).padStart(2, "0")}:00`,
      quietEnd: `${String(quietEndHour).padStart(2, "0")}:00`,
      metrics,
    };

    const sql = await db();
    await sql`UPDATE users SET name = ${name}, prefs = ${JSON.stringify(prefs)}::jsonb WHERE id = ${me.id}`;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const me = await requireUser(req);
    const userId = me.id;
    const sql = await db();
    await sql`UPDATE pods SET claimed_by = NULL, device_token = NULL, token_delivered = false, share_token = NULL WHERE claimed_by = ${userId}`;
    await sql`DELETE FROM chat_messages WHERE user_id = ${userId}`;
    await sql`DELETE FROM notifications_log WHERE user_id = ${userId}`;
    await sql`DELETE FROM push_subscriptions WHERE user_id = ${userId}`;
    await sql`DELETE FROM rooms WHERE owner_id = ${userId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    const res = NextResponse.json({ ok: true, message: "Account and personal data deleted; pods unlinked." });
    res.headers.set("set-cookie", "ecovital_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
