import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { synthesize, makeWav } from "@/lib/ai";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

// GET /api/tts/<eventId>            -> raw 16-bit mono PCM at 24 kHz (for the ESP32)
// GET /api/tts/<eventId>?fmt=wav    -> WAV (for browsers)
// Speech is generated once per event, then cached in the database.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const eventId = Number(id);
  if (!Number.isInteger(eventId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const wav = new URL(req.url).searchParams.get("fmt") === "wav";

  try {
    const sql = await db();
    const rows = await sql`SELECT spoken, audio_b64 FROM events WHERE id = ${eventId}`;
    if (!rows.length || !rows[0].spoken) return NextResponse.json({ error: "No spoken line for this event" }, { status: 404 });

    let pcm: Buffer;
    if (rows[0].audio_b64) {
      pcm = Buffer.from(rows[0].audio_b64 as string, "base64");
    } else {
      pcm = await synthesize(rows[0].spoken as string);
      await sql`UPDATE events SET audio_b64 = ${pcm.toString("base64")} WHERE id = ${eventId}`;
    }
    const out = wav ? makeWav(pcm) : pcm;
    return new Response(new Uint8Array(out), {
      headers: {
        "content-type": wav ? "audio/wav" : "application/octet-stream",
        "content-length": String(out.length),
        "x-sample-rate": "24000",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
