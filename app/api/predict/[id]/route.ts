import { NextRequest, NextResponse } from "next/server";
import { generateAiPredictions } from "@/lib/ai-predict";
import { db, iso } from "@/lib/db";
import { errorResponse, requirePodOwner } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requirePodOwner(req, id);
    return NextResponse.json(await generateAiPredictions(id), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST records the forecast as a spoken event so it can be replayed in the app.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requirePodOwner(req, id);
    const report = await generateAiPredictions(id, { fresh: true });
    const sql = await db();
    const ins = await sql`
      INSERT INTO events (device_id, ts, kind, metric, status, severity, message, spoken, spoken_flag, source, data)
      VALUES (${id}, ${iso(Date.now())}::timestamptz, 'predictive', NULL, 'ok', ${report.riskLevel === "high" ? 2 : report.riskLevel === "medium" ? 1 : 0},
              ${report.headline}, ${report.spokenForecast}, true, ${report.aiSource === "gemini" ? "gemini" : "template"},
              ${JSON.stringify({ action: "none", tags: ["measured", "estimate"], flags: report.flags.map((f) => f.id) })}::jsonb)
      RETURNING id`;
    return NextResponse.json({ ...report, eventId: Number(ins[0].id) });
  } catch (e) {
    return errorResponse(e);
  }
}
