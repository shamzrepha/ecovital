import { NextRequest, NextResponse } from "next/server";
import { uploadFirmwareBlob } from "@/lib/pods";
import { adminOk } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// POST /api/ota/upload?version=1.4&notes=...&channel=stable&target=all|<deviceId>
// Body: the raw compiled ESP32 app image (Arduino IDE > Sketch > Export Compiled Binary, the file ending .ino.bin).
// Vercel allows request bodies up to 4.5 MB, which fits this firmware (about 1.3 MB).
export async function POST(req: NextRequest) {
  if (!(await adminOk(req))) {
    return NextResponse.json({ ok: false, error: "Sign in as the admin account." }, { status: 401 });
  }
  const q = req.nextUrl.searchParams;
  const buf = Buffer.from(await req.arrayBuffer());
  const res = await uploadFirmwareBlob({
    version: q.get("version") || "",
    buf,
    origin: req.nextUrl.origin,
    notes: q.get("notes") || "",
    channel: q.get("channel") === "beta" ? "beta" : "stable",
    target: q.get("target") || "all",
  });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: res.status });
  }
  return NextResponse.json(res);
}
