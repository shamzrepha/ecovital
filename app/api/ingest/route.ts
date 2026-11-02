import { NextResponse } from "next/server";
import { ingest } from "@/lib/ingest";
import { verifyPodIngestKey } from "@/lib/pods";

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

  const provided = req.headers.get("x-device-key") ?? "";
  const auth = await verifyPodIngestKey({
    deviceId: id,
    providedKey: provided,
    claim: str(body.claim, 8),
    fw: str(body.fw, 20),
  });
  if (!auth.authorized) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }
  const readings = Array.isArray(body.readings) ? body.readings.slice(0, 120) : [];
  if (!readings.length) return NextResponse.json({ ok: false, error: "readings[] is empty" }, { status: 400 });

  try {
    const result = await ingest(
      {
        id, name: str(body.name, 60), location: str(body.location, 80),
        lat: numOrNull(body.lat), lng: numOrNull(body.lng),
        meta: { fw: str(body.fw, 20), mac: str(body.mac, 20), claim: str(body.claim, 8), rssi: numOrNull(body.rssi), uptimeS: numOrNull(body.uptimeS), mqReady: body.mqReady === true, heap: numOrNull(body.heap), rst: str(body.rst, 12), drops: numOrNull(body.drops), dhtOk: body.dhtOk === false ? false : body.dhtOk === true ? true : null },
      },
      readings,
    );
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("ingest failed", e);
    return NextResponse.json({ ok: false, error: String(e?.message ?? e).slice(0, 200) }, { status: 500 });
  }
}
