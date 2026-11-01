import { NextRequest, NextResponse } from "next/server";
import { claimPodByCode, pairStatus, unclaimPod } from "@/lib/pods";
import { errorResponse, requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/claim?code=K7Q2MX : has the cloud heard from a pod showing this code? (does not claim)
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const status = await pairStatus(req.nextUrl.searchParams.get("code") ?? "", user.id);
    return NextResponse.json({ ok: true, ...status }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/claim : link the pod showing this code to the signed-in account
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json();
    const res = await claimPodByCode({
      code: String(body.code ?? ""),
      userId: user.id,
      nickname: body.nickname ? String(body.nickname).slice(0, 60) : undefined,
      location: body.location ? String(body.location).slice(0, 80) : undefined,
      roomProfile: body.roomProfile ? String(body.roomProfile) : undefined,
      roomName: body.roomName ? String(body.roomName).slice(0, 60) : undefined,
    });
    return NextResponse.json(res, { status: res.ok ? 200 : res.locked ? 429 : 400 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json();
    if (!body?.podId) return NextResponse.json({ ok: false, error: "podId required" }, { status: 400 });
    const res = await unclaimPod(String(body.podId), user.id);
    return NextResponse.json(res, { status: res.ok ? 200 : 403 });
  } catch (e) {
    return errorResponse(e);
  }
}
