import { NextRequest, NextResponse } from "next/server";
import { db, iso } from "@/lib/db";
import { answerPodQuestion, normLang } from "@/lib/ai";
import { aiStats } from "@/lib/gemini-models";
import { errorResponse, requirePodOwner } from "@/lib/session";
import { forecastForAsk, generateAiPredictions } from "@/lib/ai-predict";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

const THREAD_RE = /^[A-Za-z0-9_-]{1,40}$/;
const YES = /^(yes|yeah|yea|yep|yup|ya|ok|okay|sure|please|go ahead|do it|tell me|yes please|sure thing|alright|abeg|oya|ehen|eeh|ee|ihe|e|ya)\b[\s.!,]*$/i;
const NO = /^(no|nope|nah|not now|no thanks|no thank you|i'm good|im good|nothing|never mind|nevermind)\b[\s.!,]*$/i;

// GET /api/ask?podId=...&thread=...   messages in one chat
// GET /api/ask?podId=...&threads=1    the list of earlier chats for this pod
export async function GET(req: NextRequest) {
  const podId = req.nextUrl.searchParams.get("podId") || "";
  let user;
  try { user = await requirePodOwner(req, podId); } catch (e) { return errorResponse(e); }
  const sql = await db();

  if (req.nextUrl.searchParams.get("threads")) {
    const rows = await sql`
      SELECT thread, count(*) AS n, (extract(epoch from max(ts)) * 1000)::float8 AS last_ms,
             (array_agg(text ORDER BY ts) FILTER (WHERE role = 'user'))[1] AS title
      FROM chat_messages WHERE device_id = ${podId} AND user_id = ${user.id}
      GROUP BY thread ORDER BY max(ts) DESC LIMIT 30`;
    return NextResponse.json({
      threads: rows.map((r: any) => ({ id: r.thread, title: String(r.title ?? "New chat").slice(0, 60), count: Number(r.n), lastAt: iso(Number(r.last_ms)) })),
    });
  }

  const thread = req.nextUrl.searchParams.get("thread") || "main";
  if (!THREAD_RE.test(thread)) return NextResponse.json({ messages: [] });
  const rows = await sql`
    SELECT id, device_id, role, text, data_refs, (extract(epoch from ts) * 1000)::float8 AS ts_ms
    FROM chat_messages
    WHERE device_id = ${podId} AND user_id = ${user.id} AND thread = ${thread}
    ORDER BY ts ASC LIMIT 60`;
  return NextResponse.json({
    messages: rows.map((r: any) => ({
      id: Number(r.id), podId: r.device_id, role: r.role, content: r.text, citations: r.data_refs ?? [], createdAt: iso(Number(r.ts_ms)),
    })),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const podId = String(body.podId || "");
    const question = String(body.question || "").trim().slice(0, 600);
    const thread = THREAD_RE.test(String(body.thread ?? "")) ? String(body.thread) : "main";
    const language = normLang(body.language);
    const user = await requirePodOwner(req, podId);
    if (!question) return NextResponse.json({ error: "Question is required" }, { status: 400 });

    const sql = await db();
    const devRows = await sql`
      SELECT d.id, d.name, p.profile FROM devices d LEFT JOIN pods p ON p.device_id = d.id WHERE d.id = ${podId}`;
    const podName = devRows[0]?.name || podId;
    const profile = devRows[0]?.profile || "classroom";

    // The conversation so far, so "yes" or "why?" is understood as a reply and not a brand new question
    const prior = await sql`
      SELECT role, text FROM chat_messages
      WHERE device_id = ${podId} AND user_id = ${user.id} AND thread = ${thread}
      ORDER BY ts DESC LIMIT 8`;
    const history = prior.reverse().map((m: any) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: String(m.text) }));
    let followUp: { answer: "yes" | "no"; question: string } | undefined;
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    if (lastAssistant && (YES.test(question) || NO.test(question))) {
      const qs = lastAssistant.text.match(/[^.!?]*\?/g);
      followUp = { answer: NO.test(question) ? "no" : "yes", question: (qs ? qs[qs.length - 1] : lastAssistant.text).trim() };
    }

    const latestRows = await sql`SELECT dust, air, temp, hum FROM readings WHERE device_id = ${podId} ORDER BY ts DESC LIMIT 1`;
    const bucketRows = await sql`
      SELECT extract(hour from ts)::int AS hr, avg(dust)::float8 AS dust, avg(air)::float8 AS air, avg(temp)::float8 AS temp, avg(hum)::float8 AS hum
      FROM readings WHERE device_id = ${podId} AND ts >= now() - interval '24 hours'
      GROUP BY 1 ORDER BY 1 DESC LIMIT 24`;
    const evRows = await sql`
      SELECT (extract(epoch from ts) * 1000)::float8 AS ts_ms, kind, metric, COALESCE(spoken, message) AS text
      FROM events WHERE device_id = ${podId} ORDER BY ts DESC LIMIT 10`;

    await sql`INSERT INTO chat_messages (user_id, device_id, role, text, data_refs, thread)
              VALUES (${user.id}, ${podId}, 'user', ${question}, '[]'::jsonb, ${thread})`;

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
      question,
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
      history,
      language,
      followUp,
    });

    const citationChips = ans.citations.map((c) => ({ label: "Grounded source", detail: c }));
    await sql`INSERT INTO chat_messages (user_id, device_id, role, text, data_refs, thread)
              VALUES (${user.id}, ${podId}, 'assistant', ${ans.answer}, ${JSON.stringify(citationChips)}::jsonb, ${thread})`;

    return NextResponse.json({
      answer: ans.answer, citations: citationChips, source: ans.source, thread,
      language: ans.language ?? "en-NG", machineTranslated: !!ans.machineTranslated,
      model: ans.source === "gemini" ? aiStats.textModel : null,
    });
  } catch (e: any) {
    return errorResponse(e);
  }
}

// DELETE /api/ask?podId=...&thread=... removes one chat
export async function DELETE(req: NextRequest) {
  try {
    const podId = req.nextUrl.searchParams.get("podId") || "";
    const thread = req.nextUrl.searchParams.get("thread") || "";
    const user = await requirePodOwner(req, podId);
    if (!THREAD_RE.test(thread)) return NextResponse.json({ ok: false, error: "Unknown chat" }, { status: 400 });
    const sql = await db();
    await sql`DELETE FROM chat_messages WHERE device_id = ${podId} AND user_id = ${user.id} AND thread = ${thread}`;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
