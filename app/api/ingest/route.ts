import { NextResponse } from "next/server";
import { ingest } from "@/lib/ingest";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const ID_RE = /^[A-Za-z0-9_-]{3,40}$/;
const str = (x: unknown, max: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : null);
const numOrNull = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "Body must be JSON" }, { status: 400 }); }

  const id = typeof body?.deviceId === "string" ? body.deviceId : "";
  if (!ID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "deviceId must be 3-40 letters, digits, - or _" }, { status: 400 });
  }

  const expected = process.env.DEVICE_KEY;
  const provided = req.headers.get("x-device-key") ?? "";
  let authorized = !!expected && provided === expected;
  if (!authorized && provided.length >= 12) {
    try {
      const sql = await db();
      const rows = await sql`SELECT device_token FROM pods WHERE device_id = ${id}`;
      if (rows.length && rows[0].device_token && rows[0].device_token === provided) {
        authorized = true;
      }
    } catch { /* ignore */ }
  }
  if (!authorized) {
    if (!expected) return NextResponse.json({ ok: false, error: "DEVICE_KEY is not configured on the server" }, { status: 500 });
    return NextResponse.json({ ok: false, error: "Bad device key" }, { status: 401 });
  }

  const readings = Array.isArray(body.readings) ? body.readings.slice(0, 120) : [];
  if (!readings.length) return NextResponse.json({ ok: false, error: "readings[] is empty" }, { status: 400 });

  try {
    const result = await ingest(
      {
        id, name: str(body.name, 60), location: str(body.location, 80),
        lat: numOrNull(body.lat), lng: numOrNull(body.lng),
        meta: { fw: str(body.fw, 20), mac: str(body.mac, 20), claim: str(body.claim, 8), rssi: numOrNull(body.rssi), uptimeS: numOrNull(body.uptimeS), mqReady: body.mqReady === true },
      },
      readings,
    );
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("ingest failed", e);
    return NextResponse.json({ ok: false, error: String(e?.message ?? e).slice(0, 200) }, { status: 500 });
  }
}
