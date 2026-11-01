import { NextResponse } from "next/server";
import { runScenario, seedGlobal, type Scenario } from "@/lib/demo";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SCENARIOS = ["normal", "dry", "warning", "dusty", "stuffy", "recover", "reset", "seed"];

// Pitch/demo only. Disabled unless NEXT_PUBLIC_DEMO=1 is set on the server.
export async function POST(req: Request) {
  if (process.env.NEXT_PUBLIC_DEMO !== "1") {
    return NextResponse.json({ error: "Demo mode is off. Set NEXT_PUBLIC_DEMO=1." }, { status: 403 });
  }
  let scenario = "";
  try { scenario = String((await req.json()).scenario ?? ""); } catch { /* fall through */ }
  if (!SCENARIOS.includes(scenario)) {
    return NextResponse.json({ error: `scenario must be one of ${SCENARIOS.join(", ")}` }, { status: 400 });
  }
  try {
    if (scenario === "seed") return NextResponse.json({ message: await seedGlobal() });
    const out = await runScenario(scenario as Scenario);
    return NextResponse.json({
      message: out.message,
      speak: out.result?.speak ?? null,
      events: out.result?.events ?? [],
    });
  } catch (e: any) {
    console.error("demo failed", e);
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 500 });
  }
}
