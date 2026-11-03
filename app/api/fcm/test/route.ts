import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { sendFcmToUser, isFcmConfigured } from "@/lib/fcm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const podId = String(body?.podId || "test-pod").trim();

    if (!isFcmConfigured()) {
      return NextResponse.json(
        { ok: false, error: "FCM is not configured on this server (missing FIREBASE_SERVICE_ACCOUNT_JSON)" },
        { status: 503 }
      );
    }

    const res = await sendFcmToUser(user.id, {
      type: "alarm",
      title: "🚨 Test Alarm: Emergency Siren Test",
      body: "Emergency test alert from EcoVital. Siren will sound over lock screen.",
      podId,
      cause: "gas",
      ts: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true, sent: res.sent, failed: res.failed });
  } catch (e: any) {
    const status = e.status || 500;
    return NextResponse.json({ ok: false, error: e.message }, { status });
  }
}
