import { NextResponse } from "next/server";
import { makeWav, normLang, synthesize } from "@/lib/ai";
import { errorResponse, requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const hits = new Map<string, number[]>();

function limited(user: string): boolean {
  const now = Date.now();
  const recent = (hits.get(user) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(user, recent);
  return recent.length > 30;
}

// POST /api/speak {text, lang} : the assistant's reply as a spoken WAV, for the signed-in user
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = await req.json();
    const text = String(body.text ?? "").replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim().slice(0, 600);
    if (!text) return NextResponse.json({ ok: false, error: "Nothing to say." }, { status: 400 });
    if (!process.env.GEMINI_API_KEY) return NextResponse.json({ ok: false, error: "The server voice is not switched on." }, { status: 503 });
    if (limited(user.id)) return NextResponse.json({ ok: false, error: "Slow down a little." }, { status: 429 });
    const pcm = await synthesize(text, normLang(body.lang));
    const wav = makeWav(pcm);
    return new Response(new Uint8Array(wav), {
      headers: { "content-type": "audio/wav", "content-length": String(wav.length), "cache-control": "private, no-store" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
