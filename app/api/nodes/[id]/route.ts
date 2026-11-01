import { NextResponse } from "next/server";
import { getNodeDetail } from "@/lib/queries";
import { db } from "@/lib/db";
import { errorResponse, requirePodOwner } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const range = url.searchParams.get("range") ?? "1h";
  const share = url.searchParams.get("share");
  try {
    let shared = false;
    if (share) {
      const sql = await db();
      const ok = await sql`SELECT 1 FROM pods WHERE device_id = ${id} AND share_token = ${share}`;
      if (!ok.length) return NextResponse.json({ error: "This share link is not valid." }, { status: 404 });
      shared = true;
    } else {
      await requirePodOwner(req, id);
    }
    const data: any = await getNodeDetail(id, range);
    if (!data) return NextResponse.json({ error: "Unknown pod" }, { status: 404 });
    if (shared) {
      // Read-only viewers never see the pair code, MAC or the share token itself.
      if (data.device?.meta) { delete data.device.meta.claim; delete data.device.meta.mac; }
      if (data.device) { delete data.device.shareToken; data.device.claimedBy = null; }
      if (data.podState) { delete data.podState.shareToken; delete data.podState.claimCode; data.podState.claimedBy = null; }
      if (data.system) { delete data.system.claim; delete data.system.mac; }
    }
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
