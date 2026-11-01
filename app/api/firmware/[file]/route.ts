import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

// GET /api/firmware/1.4.bin -> the uploaded firmware image, with Content-Length so the pod can show progress.
export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const version = decodeURIComponent(file).replace(/\.bin$/i, "");
  const sql = await db();
  const rows = await sql`SELECT data_b64 FROM firmware_blobs WHERE version = ${version}`;
  if (!rows.length) return NextResponse.json({ error: "No such firmware" }, { status: 404 });
  const buf = Buffer.from(rows[0].data_b64 as string, "base64");
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(buf.length),
      "Content-Disposition": `attachment; filename="ecovital-${version}.bin"`,
      "Cache-Control": "no-store",
    },
  });
}
