import { NextRequest, NextResponse } from "next/server";
import { getInsightsAndComparison } from "@/lib/pods";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getInsightsAndComparison(id);
  return NextResponse.json(data);
}
