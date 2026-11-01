import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const user = await getSessionUser(req);
    return NextResponse.json({ user }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ user: null });
  }
}
