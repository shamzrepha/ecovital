import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin || "https://ecovital.vercel.app";
  let source = "";
  try {
    const candidatePaths = [
      path.resolve(process.cwd(), "..", "firmware", "ecovital_pod", "ecovital_pod.ino"),
      path.resolve(process.cwd(), "firmware", "ecovital_pod", "ecovital_pod.ino"),
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(/*turbopackIgnore: true*/ p)) {
        source = fs.readFileSync(/*turbopackIgnore: true*/ p, "utf8");
        break;
      }
    }
  } catch {}

  if (!source) {
    source = `// EcoVital ESP32 Pod Firmware v1.1 (Pre-configured for ${origin})\n// Flash with Arduino IDE -> ESP32 Dev Module\n#define DEFAULT_SERVER_URL "${origin}"\n`;
  } else {
    source = `// Pre-configured for EcoVital Remote Cloud: ${origin}\n` + source;
  }

  return new NextResponse(source, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="ecovital_pod.ino"`,
      "Cache-Control": "no-store",
    },
  });
}
