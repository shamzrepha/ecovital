import { NextRequest, NextResponse } from "next/server";
import { db, iso } from "@/lib/db";
import { DEFAULT_USER, ensureDefaultUser } from "@/lib/pods";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") || DEFAULT_USER.id;
  await ensureDefaultUser(userId);
  const sql = await db();
  const rows = await sql`SELECT id, email, name, role, prefs FROM users WHERE id = ${userId}`;
  const notifs = await sql`
    SELECT id, device_id, channel, title, body, (extract(epoch from sent_at) * 1000)::float8 AS sent_ms
    FROM notifications_log
    ORDER BY sent_at DESC LIMIT 25
  `;
  const u = rows[0] || { id: DEFAULT_USER.id, email: DEFAULT_USER.email, name: DEFAULT_USER.name, prefs: {} };
  const prefs = u.prefs || {};
  return NextResponse.json({
    user: {
      id: u.id,
      email: u.email,
      name: u.name,
      language: prefs.language || "en-NG",
      voice: prefs.voice || "Kore",
      voiceSpeed: prefs.voiceSpeed || "normal",
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
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const id = String(body.id || DEFAULT_USER.id);
    const email = String(body.email || DEFAULT_USER.email).trim();
    const name = String(body.name || DEFAULT_USER.name).trim();
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
      quietEnabled: true,
      quietStartHour,
      quietEndHour,
      quietStart: `${String(quietStartHour).padStart(2, "0")}:00`,
      quietEnd: `${String(quietEndHour).padStart(2, "0")}:00`,
      metrics,
    };

    const sql = await db();
    await sql`
      INSERT INTO users (id, email, name, role, prefs)
      VALUES (${id}, ${email}, ${name}, 'owner', ${JSON.stringify(prefs)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        prefs = EXCLUDED.prefs
    `;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Failed to save settings" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") || DEFAULT_USER.id;
  const sql = await db();
  await sql`UPDATE pods SET claimed_by = NULL, device_token = NULL, token_delivered = false WHERE claimed_by = ${userId}`;
  await sql`DELETE FROM chat_messages WHERE user_id = ${userId}`;
  await sql`DELETE FROM notifications_log WHERE user_id = ${userId}`;
  await sql`DELETE FROM push_subscriptions WHERE user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
  return NextResponse.json({ ok: true, message: "Account and personal data deleted; pods unclaimed." });
}
