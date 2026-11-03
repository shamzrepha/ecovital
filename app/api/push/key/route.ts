import { NextResponse } from "next/server";
import { vapidPublicKey } from "@/lib/push";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return NextResponse.json({ key: await vapidPublicKey() }); }
  catch (e: any) { return NextResponse.json({ error: String(e?.message ?? e).slice(0, 120) }, { status: 500 }); }
}
