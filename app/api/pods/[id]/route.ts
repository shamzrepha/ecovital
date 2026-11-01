import { NextRequest, NextResponse } from "next/server";
import { updatePodSettings } from "@/lib/pods";
import { errorResponse, requirePodOwner } from "@/lib/session";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requirePodOwner(req, id);
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
  } catch (e) {
    return errorResponse(e);
  }
}
