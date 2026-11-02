import { NextResponse } from "next/server";
import { geminiAudioToText, normLang } from "@/lib/ai";
import { errorResponse, requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const MAX_BYTES = 1_500_000;           // about 45 seconds of 16 kHz mono WAV
const hits = new Map<string, number[]>();

function limited(user: string): boolean {
  const now = Date.now();
  const recent = (hits.get(user) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(user, recent);
  return recent.length > 20;
}

// GET /api/voice : can this server turn speech into text? (needs the Gemini key)
export async function GET(req: Request) {
  try {
    await requireUser(req);
    return NextResponse.json({ available: !!process.env.GEMINI_API_KEY });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/voice?lang=ig : body is a short WAV recording, reply is the words that were spoken
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    if (!process.env.GEMINI_API_KEY) return NextResponse.json({ ok: false, error: "Voice typing is not switched on for this server." }, { status: 503 });
    if (limited(user.id)) return NextResponse.json({ ok: false, error: "Too many voice messages. Wait a moment and try again." }, { status: 429 });
    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length < 2000) return NextResponse.json({ ok: true, text: "" });
    if (buf.length > MAX_BYTES) return NextResponse.json({ ok: false, error: "That recording is too long. Keep it under about 40 seconds." }, { status: 413 });
    const lang = normLang(new URL(req.url).searchParams.get("lang"));
    const text = await geminiAudioToText(buf, req.headers.get("content-type") || "audio/wav", lang);
    return NextResponse.json({ ok: true, text: text.slice(0, 600) });
  } catch (e) {
    return errorResponse(e);
  }
}
