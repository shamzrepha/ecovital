import { NextResponse } from "next/server";
import { getNodes } from "@/lib/queries";
import { errorResponse, requireUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The signed-in user's own pods. Admin accounts may pass ?all=1 to see the whole fleet.
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const all = user.role === "admin" && new URL(req.url).searchParams.get("all") === "1";
    return NextResponse.json(await getNodes(all ? undefined : user.id), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
