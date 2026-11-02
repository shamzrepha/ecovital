import { NextResponse } from "next/server";
import { geminiText, synthesize } from "@/lib/ai";
import { aiStats, listModels, pickText, pickTts, resetModelCache } from "@/lib/gemini-models";
import { errorResponse, requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Owner only: which Gemini models the app will use, and a real test of the text and speech calls.
export async function GET(req: Request) {
  try {
    const me = await requireUser(req);
    if (me.role !== "admin") return NextResponse.json({ ok: false, error: "Owner access only." }, { status: 403 });
    if (!process.env.GEMINI_API_KEY) return NextResponse.json({ ok: true, keySet: false });
    resetModelCache();
    const models = await listModels();

    const out: any = {
      ok: true,
      keySet: true,
      listedModels: models ? models.length : null,
      listError: models ? null : aiStats.lastError,
      envTextModel: process.env.GEMINI_TEXT_MODEL || null,
      textChoices: pickText(models).slice(0, 5),
      speechChoices: pickTts(models).slice(0, 5),
      text: null as any,
      speech: null as any,
    };

    let t0 = Date.now();
    try {
      const reply = await geminiText("Reply with exactly the word: ok", "You answer in one word.", 20);
      out.text = { ok: true, model: aiStats.textModel, ms: Date.now() - t0, reply: reply.trim().slice(0, 40) };
    } catch (e: any) {
      out.text = { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 300), detail: aiStats.lastError };
    }

    t0 = Date.now();
    try {
      const pcm = await synthesize("Testing the EcoVital voice.");
      out.speech = { ok: true, model: aiStats.ttsModel, ms: Date.now() - t0, seconds: +(pcm.length / 2 / 24000).toFixed(1) };
    } catch (e: any) {
      out.speech = { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 500) };
    }
    return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
