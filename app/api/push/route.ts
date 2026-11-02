import { NextRequest, NextResponse } from "next/server";
import { getVapidPublicKey, sendPushToUser } from "@/lib/push";
import { db } from "@/lib/db";
import { errorResponse, requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/push: returns the VAPID public key
export async function GET(req: NextRequest) {
  try {
    const key = getVapidPublicKey();
    return NextResponse.json({ vapidPublicKey: key });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/push: saves a web push subscription for the signed-in user
export async function POST(req: NextRequest) {
  try {
    const me = await requireUser(req);
    const body = await req.json();
    const { endpoint, keys, prefs, testSend } = body;

    const sql = await db();

    if (testSend) {
      const res = await sendPushToUser({
        userId: me.id,
        title: "EcoVital Alert Test",
        body: "Web Push alerts are active. You will receive notifications even with the app closed.",
        tag: "test-alert",
        isGasAlarm: false,
      });
      return NextResponse.json({ ok: true, sent: res.sent });
    }

    if (!endpoint) {
      return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
    }

    await sql`
      INSERT INTO push_subscriptions (user_id, endpoint, keys, prefs)
      VALUES (${me.id}, ${endpoint}, ${JSON.stringify(keys || {})}::jsonb, ${JSON.stringify(prefs || {})}::jsonb)
      ON CONFLICT (endpoint) DO UPDATE SET
        user_id = ${me.id},
        keys = ${JSON.stringify(keys || {})}::jsonb,
        prefs = ${JSON.stringify(prefs || {})}::jsonb
    `;

    return NextResponse.json({ ok: true, subscribed: true });
  } catch (e) {
    return errorResponse(e);
  }
}

// DELETE /api/push: removes a web push subscription
export async function DELETE(req: NextRequest) {
  try {
    const me = await requireUser(req);
    const endpoint = req.nextUrl.searchParams.get("endpoint");
    const sql = await db();

    if (endpoint) {
      await sql`DELETE FROM push_subscriptions WHERE user_id = ${me.id} AND endpoint = ${endpoint}`;
    } else {
      await sql`DELETE FROM push_subscriptions WHERE user_id = ${me.id}`;
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
