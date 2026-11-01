import { NextRequest, NextResponse } from "next/server";
import { db, iso } from "@/lib/db";
import { answerPodQuestion } from "@/lib/ai";
import { errorResponse, requirePodOwner } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const podId = req.nextUrl.searchParams.get("podId") || "";
  let user;
  try { user = await requirePodOwner(req, podId); } catch (e) { return errorResponse(e); }
  const sql = await db();
  const rows = await sql`
    SELECT id, device_id, role, text, data_refs, (extract(epoch from ts) * 1000)::float8 AS ts_ms
    FROM chat_messages
    WHERE device_id = ${podId} AND user_id = ${user.id}
    ORDER BY ts ASC
    LIMIT 40
  `;
  return NextResponse.json({
    messages: rows.map((r: any) => ({
      id: Number(r.id),
      podId: r.device_id,
      role: r.role,
      content: r.text,
      citations: r.data_refs ?? [],
      createdAt: iso(Number(r.ts_ms)),
    })),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const podId = String(body.podId || "");
    const question = String(body.question || "").trim().slice(0, 600);
    const userId = (await requirePodOwner(req, podId)).id;
    if (!question) {
      return NextResponse.json({ error: "Question is required" }, { status: 400 });
    }

    const sql = await db();
    const devRows = await sql`
      SELECT d.id, d.name, p.profile
      FROM devices d LEFT JOIN pods p ON p.device_id = d.id
      WHERE d.id = ${podId}
    `;
    const podName = devRows[0]?.name || podId;
    const profile = devRows[0]?.profile || "classroom";

    const latestRows = await sql`
      SELECT dust, air, temp, hum
      FROM readings WHERE device_id = ${podId}
      ORDER BY ts DESC LIMIT 1
    `;
    const bucketRows = await sql`
      SELECT extract(hour from ts)::int AS hr,
             avg(dust)::float8 AS dust, avg(air)::float8 AS air,
             avg(temp)::float8 AS temp, avg(hum)::float8 AS hum
      FROM readings WHERE device_id = ${podId} AND ts >= now() - interval '24 hours'
      GROUP BY 1 ORDER BY 1
    `;
    const evRows = await sql`
      SELECT (extract(epoch from ts) * 1000)::float8 AS ts_ms, kind, metric, COALESCE(spoken, message) AS text
      FROM events WHERE device_id = ${podId}
      ORDER BY ts DESC LIMIT 10
    `;

    await sql`INSERT INTO chat_messages (user_id, device_id, role, text, data_refs)
              VALUES (${userId}, ${podId}, 'user', ${question}, '[]'::jsonb)`;

    const latest = latestRows[0]
      ? {
          dust: latestRows[0].dust != null ? Number(latestRows[0].dust) : null,
          air: latestRows[0].air != null ? Number(latestRows[0].air) : null,
          temp: latestRows[0].temp != null ? Number(latestRows[0].temp) : null,
          hum: latestRows[0].hum != null ? Number(latestRows[0].hum) : null,
        }
      : {};

    const hourlyBuckets = bucketRows.map((b: any) => {
      const h = Number(b.hr);
      return {
        timeRange: `${String(h).padStart(2, "0")}:00-${String((h + 1) % 24).padStart(2, "0")}:00`,
        dust: b.dust != null ? +Number(b.dust).toFixed(1) : null,
        air: b.air != null ? +Number(b.air).toFixed(1) : null,
        temp: b.temp != null ? +Number(b.temp).toFixed(1) : null,
        hum: b.hum != null ? +Number(b.hum).toFixed(1) : null,
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
        kind: e.kind,
        metric: e.metric ?? null,
        text: e.text,
      })),
      forecasts: {},
    });

    const citationChips = ans.citations.map((c) => ({ label: "Grounded source", detail: c }));

    await sql`INSERT INTO chat_messages (user_id, device_id, role, text, data_refs)
              VALUES (${userId}, ${podId}, 'assistant', ${ans.answer}, ${JSON.stringify(citationChips)}::jsonb)`;

    return NextResponse.json({
      answer: ans.answer,
      citations: citationChips,
      source: ans.source,
    });
  } catch (e: any) {
    return errorResponse(e);
  }
}
