import { NextRequest, NextResponse } from "next/server";
import { generateAiPredictions } from "@/lib/ai-predict";
import { db, iso } from "@/lib/db";
import { errorResponse, requirePodOwner } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { await requirePodOwner(req, id); } catch (e) { return errorResponse(e); }
  const report = await generateAiPredictions(id);
  return NextResponse.json(report);
}

// POST allows creating a spoken predictive event on demand so the user/pod can hear the AI prediction out loud
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { await requirePodOwner(req, id); } catch (e) { return errorResponse(e); }
  const report = await generateAiPredictions(id);
  const sql = await db();
  const ins = await sql`
    INSERT INTO events (device_id, ts, kind, metric, status, severity, message, spoken, spoken_flag, source, data)
    VALUES (
      ${id},
      ${iso(Date.now())}::timestamptz,
      'predictive',
      'hum',
      'ok',
      1,
      ${report.headline},
      ${report.spokenForecast},
      true,
      ${report.aiSource === "gemini" ? "gemini" : "template"},
      ${JSON.stringify({ action: "open_window", tags: ["measured", "estimate"], horizons: report.horizons })}::jsonb
    )
    RETURNING id
  `;
  return NextResponse.json({
    ...report,
    eventId: Number(ins[0].id),
  });
}
