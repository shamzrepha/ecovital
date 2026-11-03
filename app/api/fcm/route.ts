import { NextResponse } from "next/server";
import { getSessionUser, requireUser } from "@/lib/session";
import { saveFcmToken, deleteFcmToken, deleteUserFcmTokens } from "@/lib/fcm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const user = await getSessionUser(req).catch(() => null);
    const body = await req.json().catch(() => ({}));
    const token = String(body.token || "").trim();
    if (!token) {
      return NextResponse.json({ ok: false, error: "Missing FCM token" }, { status: 400 });
    }
    const platform = String(body.platform || "android").trim();
    await saveFcmToken(user ? user.id : null, token, platform);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e.status || 500;
    return NextResponse.json({ ok: false, error: e.message }, { status });
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await getSessionUser(req).catch(() => null);
    let token: string | undefined;
    try {
      const body = await req.json();
      token = body?.token;
    } catch {
      // Body might be empty
    }
    if (!token) {
      const url = new URL(req.url);
      token = url.searchParams.get("token") || undefined;
    }

    if (token) {
      await deleteFcmToken(token);
    } else {
      if (user) await deleteUserFcmTokens(user.id);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e.status || 500;
    return NextResponse.json({ ok: false, error: e.message }, { status });
  }
}
