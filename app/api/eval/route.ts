import { NextResponse } from "next/server";
import { runAiEvaluationSuite } from "@/lib/ai";
import { errorResponse, requireUser } from "@/lib/session";

export const runtime = "nodejs";

// Runs the fixed AI scenarios. Admin accounts only (it can call the AI provider).
async function run(req: Request) {
  try {
    const u = await requireUser(req);
    if (u.role !== "admin") return NextResponse.json({ error: "Admin account required." }, { status: 403 });
    return NextResponse.json(await runAiEvaluationSuite());
  } catch (e) {
    return errorResponse(e);
  }
}
export const GET = run;
export const POST = run;
