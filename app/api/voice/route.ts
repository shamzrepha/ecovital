import { NextResponse } from "next/server";
import { geminiAudioToText, answerPodQuestion, synthesize, normLang } from "@/lib/ai";
import { aiStats } from "@/lib/gemini-models";
import { db } from "@/lib/db";
import { errorResponse, requireUser, requirePodOwner } from "@/lib/session";
import { forecastForAsk, generateAiPredictions } from "@/lib/ai-predict";

export const runtime = "nodejs";
export const maxDuration = 45;
export const dynamic = "force-dynamic";

const MAX_BYTES = 4_000_000; // 4 MB audio limit
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

// POST /api/voice?lang=ig&podId=... : handles speech transcription and full grounded voice Q&A
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ ok: false, error: "Voice processing requires GEMINI_API_KEY." }, { status: 503 });
    }
    if (limited(user.id)) {
      return NextResponse.json({ ok: false, error: "Too many voice messages. Wait a moment and try again." }, { status: 429 });
    }

    const url = new URL(req.url);
    const podId = url.searchParams.get("podId");
    const lang = normLang(url.searchParams.get("lang"));
    const transcribeOnly = url.searchParams.get("transcribeOnly") === "1" || !podId;

    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: "Recording is too large. Limit is 4 MB." }, { status: 413 });
    }

    let transcript = "";
    if (buf.length >= 2000) {
      const mime = req.headers.get("content-type") || "audio/wav";
      transcript = (await geminiAudioToText(buf, mime, lang).catch(() => "")).slice(0, 600).trim();
    }

    // Transcribe-only mode (used by the Ask page voice mic)
    if (transcribeOnly) {
      return NextResponse.json({ ok: true, text: transcript, transcript });
    }

    // Full Voice Center mode with grounded pod data and audio answer
    if (!transcript) {
      const fallbackAns = "I did not catch that, please repeat.";
      let audioB64: string | null = null;
      try {
        const pcm = await synthesize(fallbackAns, lang);
        audioB64 = pcm.toString("base64");
      } catch { /* TTS fallback handled on client */ }

      return NextResponse.json({
        ok: true,
        transcript: "",
        text: "",
        answer: fallbackAns,
        audio: audioB64,
        source: "template",
        language: lang,
      });
    }

    // Grounded answer with pod's real data
    await requirePodOwner(req, podId);
    const sql = await db();
    const devRows = await sql`
      SELECT d.id, d.name, p.profile FROM devices d LEFT JOIN pods p ON p.device_id = d.id WHERE d.id = ${podId}`;
    const podName = devRows[0]?.name || podId;
    const profile = devRows[0]?.profile || "classroom";

    const latestRows = await sql`SELECT dust, air, temp, hum FROM readings WHERE device_id = ${podId} ORDER BY ts DESC LIMIT 1`;
    const bucketRows = await sql`
      SELECT extract(hour from ts)::int AS hr, avg(dust)::float8 AS dust, avg(air)::float8 AS air, avg(temp)::float8 AS temp, avg(hum)::float8 AS hum
      FROM readings WHERE device_id = ${podId} AND ts >= now() - interval '24 hours'
      GROUP BY 1 ORDER BY 1 DESC LIMIT 24`;
    const evRows = await sql`
      SELECT (extract(epoch from ts) * 1000)::float8 AS ts_ms, kind, metric, COALESCE(spoken, message) AS text
      FROM events WHERE device_id = ${podId} ORDER BY ts DESC LIMIT 10`;

    const l = latestRows[0];
    const latest = l ? { dust: l.dust != null ? Number(l.dust) : null, air: l.air != null ? Number(l.air) : null, temp: l.temp != null ? Number(l.temp) : null, hum: l.hum != null ? Number(l.hum) : null } : {};
    const hourlyBuckets = bucketRows.map((b: any) => {
      const h = Number(b.hr);
      return {
        timeRange: `${String(h).padStart(2, "0")}:00-${String((h + 1) % 24).padStart(2, "0")}:00`,
        dust: b.dust != null ? +Number(b.dust).toFixed(1) : null, air: b.air != null ? +Number(b.air).toFixed(1) : null,
        temp: b.temp != null ? +Number(b.temp).toFixed(1) : null, hum: b.hum != null ? +Number(b.hum).toFixed(1) : null,
      };
    });

    const ans = await answerPodQuestion({
      question: transcript,
      deviceName: podName,
      profile,
      latest,
      hourlyBuckets,
      recentEvents: evRows.map((e: any) => ({
        time: new Date(Number(e.ts_ms)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        kind: e.kind, metric: e.metric ?? null, text: e.text,
      })),
      forecasts: {},
      prediction: await generateAiPredictions(podId).then(forecastForAsk).catch(() => undefined),
      language: lang,
    });

    // Store only the transcript in chat_messages (no audio stored!)
    const thread = "voice";
    await sql`INSERT INTO chat_messages (user_id, device_id, role, text, data_refs, thread)
              VALUES (${user.id}, ${podId}, 'user', ${transcript}, '[]'::jsonb, ${thread})`;

    const citationChips = ans.citations.map((c) => ({ label: "Grounded source", detail: c }));
    const metaRef = { label: "meta", source: ans.source, model: ans.source === "gemini" ? aiStats.textModel : null, machine: !!ans.machineTranslated };
    await sql`INSERT INTO chat_messages (user_id, device_id, role, text, data_refs, thread)
              VALUES (${user.id}, ${podId}, 'assistant', ${ans.answer}, ${JSON.stringify([metaRef, ...citationChips])}::jsonb, ${thread})`;

    // Record in ai_logs
    await sql`INSERT INTO ai_logs (device_id, kind, inputs, output, source)
              VALUES (${podId}, 'voice', ${JSON.stringify({ transcript, podName, language: lang })}::jsonb,
                      ${JSON.stringify({ answer: ans.answer, error: ans.source === "template" ? (aiStats.lastError || "template fallback") : null })}::jsonb,
                      ${ans.source})`.catch(() => {});

    // Synthesize audio answer
    let audioB64: string | null = null;
    try {
      const pcm = await synthesize(ans.answer, lang);
      audioB64 = pcm.toString("base64");
    } catch { /* client falls back to browser voice */ }

    return NextResponse.json({
      ok: true,
      transcript,
      text: transcript,
      answer: ans.answer,
      audio: audioB64,
      source: ans.source,
      language: ans.language ?? lang,
      machineTranslated: !!ans.machineTranslated,
      citations: citationChips,
      model: ans.source === "gemini" ? aiStats.textModel : null,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
