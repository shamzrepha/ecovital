import { NextRequest, NextResponse } from "next/server";
import { updatePodSettings } from "@/lib/pods";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const res = await updatePodSettings(id, {
      nickname: body.nickname,
      location: body.location,
      roomProfile: body.roomProfile,
      volume: body.volume !== undefined ? Number(body.volume) : undefined,
      mute: body.mute !== undefined ? Boolean(body.mute) : undefined,
      scoreWeights: body.scoreWeights,
      customThresholds: body.customThresholds,
      resetThresholds: Boolean(body.resetThresholds),
    });
    return NextResponse.json(res);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Failed to update pod" }, { status: 400 });
  }
}
