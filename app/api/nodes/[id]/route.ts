import { NextResponse } from "next/server";
import { getNodeDetail } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const range = new URL(req.url).searchParams.get("range") ?? "1h";
  try {
    const data = await getNodeDetail(id, range);
    if (!data) return NextResponse.json({ error: "Unknown node" }, { status: 404 });
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
