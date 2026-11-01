import { NextRequest, NextResponse } from "next/server";
import { getInsightsAndComparison } from "@/lib/pods";
import { errorResponse, requirePodOwner } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requirePodOwner(req, id);
    return NextResponse.json(await getInsightsAndComparison(id));
  } catch (e) {
    return errorResponse(e);
  }
}
