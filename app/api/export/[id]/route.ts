import { NextRequest, NextResponse } from "next/server";
import { db, iso } from "@/lib/db";
import { classify } from "@/lib/config";

export const runtime = "nodejs";

const SPAN_MS: Record<string, number> = {
  "1h": 3600_000,
  "6h": 6 * 3600_000,
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const range = req.nextUrl.searchParams.get("range") || "24h";
  const span = SPAN_MS[range] ?? SPAN_MS["24h"];
  const since = iso(Date.now() - span);

  const sql = await db();
  const rows = await sql`
    SELECT (extract(epoch from ts) * 1000)::bigint AS ts_ms, ts, dust, air, temp, hum
    FROM readings
    WHERE device_id = ${id} AND ts >= ${since}::timestamptz
    ORDER BY ts ASC
    LIMIT 10000
  `;

  const lines = ["timestamp,iso_time,dust_index,air_index,temp_c,humidity_pct,flags"];
  for (const r of rows) {
    const d = r.dust != null ? Number(r.dust) : null;
    const a = r.air != null ? Number(r.air) : null;
    const t = r.temp != null ? Number(r.temp) : null;
    const h = r.hum != null ? Number(r.hum) : null;
    const flags: string[] = [];
    if (d != null && classify("dust", d) !== "good") flags.push(`dust_${classify("dust", d)}`);
    if (a != null && classify("air", a) !== "good") flags.push(`air_${classify("air", a)}`);
    if (t != null && classify("temp", t) !== "good") flags.push(`temp_${classify("temp", t)}`);
    if (h != null && classify("hum", h) !== "good") flags.push(`hum_${classify("hum", h)}`);
    lines.push(
      [
        r.ts_ms,
        iso(r.ts),
        d != null ? d.toFixed(1) : "",
        a != null ? a.toFixed(1) : "",
        t != null ? t.toFixed(1) : "",
        h != null ? h.toFixed(1) : "",
        flags.join("|") || "good",
      ].join(","),
    );
  }

  const csv = lines.join("\n");
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ecovital-${id}-${range}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
