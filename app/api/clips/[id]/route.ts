import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { OFFLINE_CLIPS } from "@/lib/config";
import { makeWav, synthesize } from "@/lib/ai";

export const runtime = "nodejs";

// Exact mu-law to 16-bit PCM decoder matching firmware/ecovital_pod/ecovital_pod.ino line 771
function ulaw2lin(u: number): number {
  u = ~u & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - t : t - 0x84;
}

let cachedClipsHeader: string | null = null;

function loadClipSamplesFromHeader(id: number): Int16Array | null {
  try {
    if (!cachedClipsHeader) {
      const candidatePaths = [
        path.resolve(process.cwd(), "..", "firmware", "ecovital_pod", "clips.h"),
        path.resolve(process.cwd(), "firmware", "ecovital_pod", "clips.h"),
      ];
      for (const p of candidatePaths) {
        if (fs.existsSync(/*turbopackIgnore: true*/ p)) {
          cachedClipsHeader = fs.readFileSync(/*turbopackIgnore: true*/ p, "utf8");
          break;
        }
      }
    }
    if (!cachedClipsHeader) return null;
    const regex = new RegExp(`clip_${id}\\[\\]\\s+PROGMEM\\s*=\\s*\\{([^}]+)\\}`);
    const match = cachedClipsHeader.match(regex);
    if (!match) return null;
    const tokens = match[1].split(",").map((s) => s.trim()).filter(Boolean);
    // Upsample 12 kHz mu-law to 24 kHz 16-bit PCM (linear interpolation, just like firmware playClip)
    const out = new Int16Array(tokens.length * 2);
    let prev = 0;
    for (let i = 0; i < tokens.length; i++) {
      const byteVal = Number.parseInt(tokens[i], 10) & 0xff;
      const s = ulaw2lin(byteVal);
      out[i * 2] = (prev + s) >> 1;
      out[i * 2 + 1] = s;
      prev = s;
    }
    return out;
  } catch {
    return null;
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const clipId = Number.parseInt(id, 10);
  const clipMeta = OFFLINE_CLIPS.find((c) => c.id === clipId);
  if (!clipMeta) {
    return NextResponse.json({ error: "Unknown clip ID" }, { status: 404 });
  }

  const pcm24k = loadClipSamplesFromHeader(clipId);
  let wav: Buffer;
  let source = "pod-flash-ulaw";
  if (pcm24k && pcm24k.length > 0) {
    const pcmBuf = Buffer.from(pcm24k.buffer, pcm24k.byteOffset, pcm24k.byteLength);
    wav = makeWav(pcmBuf, 24000);
  } else {
    try {
      const pcm = await synthesize(clipMeta.transcript);
      wav = makeWav(pcm, 24000);
      source = "gemini-tts";
    } catch {
      const silent = Buffer.alloc(24000 * 2);
      wav = makeWav(silent, 24000);
      source = "fallback-silent";
    }
  }

  return new NextResponse(new Uint8Array(wav), {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(wav.length),
      "X-Voice-Source": source,
      "Cache-Control": "public, max-age=3600",
    },
  });
}
