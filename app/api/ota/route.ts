import { NextRequest, NextResponse } from "next/server";
import { createFirmwareRelease, listFirmwareState } from "@/lib/pods";

export const runtime = "nodejs";

export async function GET() {
  const state = await listFirmwareState();
  return NextResponse.json(state);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const version = String(body.version || "").trim();
    const url = String(body.url || "").trim();
    const notes = String(body.notes || "").trim();
    const channel = body.channel === "beta" ? "beta" : "stable";
    const targetPods = body.targetPods || "all";

    if (!version || !url) {
      return NextResponse.json({ ok: false, error: "Version and binary URL are required." }, { status: 400 });
    }
    const res = await createFirmwareRelease({ version, url, notes, channel, targetPods });
    return NextResponse.json(res);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Failed to create firmware release" }, { status: 400 });
  }
}
