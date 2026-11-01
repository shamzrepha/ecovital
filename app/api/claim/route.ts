import { NextRequest, NextResponse } from "next/server";
import { claimPodByCode, unclaimPod } from "@/lib/pods";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await claimPodByCode({
      code: String(body.code ?? ""),
      userId: body.userId ? String(body.userId) : "default-owner",
      nickname: body.nickname ? String(body.nickname) : undefined,
      location: body.location ? String(body.location) : undefined,
      roomProfile: body.roomProfile ? String(body.roomProfile) : undefined,
      roomName: body.roomName ? String(body.roomName) : undefined,
    });
    return NextResponse.json(res, { status: res.ok ? 200 : res.locked ? 429 : 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Invalid request" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body?.podId) return NextResponse.json({ ok: false, error: "podId required" }, { status: 400 });
    const res = await unclaimPod(String(body.podId), body.userId ? String(body.userId) : undefined);
    return NextResponse.json(res, { status: res.ok ? 200 : 403 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Invalid request" }, { status: 400 });
  }
}
