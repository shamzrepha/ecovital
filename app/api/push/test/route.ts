import { NextResponse } from "next/server";
import { sendPush } from "@/lib/push";
export const runtime = "nodejs";
// POST /api/push/test: sends a sample alarm to every saved phone so you can check it rings.
export async function POST() {
  const r = await sendPush(null, { title: "EcoVital TEST ALARM", body: "Possible gas or fumes detected. This is a test.", alarm: true, tag: "ev-test", url: "/" });
  return NextResponse.json(r);
}
