import { NextResponse } from "next/server";
import { runAiEvaluationSuite } from "@/lib/ai";

export const runtime = "nodejs";

export async function GET() {
  const res = await runAiEvaluationSuite();
  return NextResponse.json(res);
}

export async function POST() {
  const res = await runAiEvaluationSuite();
  return NextResponse.json(res);
}
