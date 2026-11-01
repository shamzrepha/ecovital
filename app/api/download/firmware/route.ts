import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { adminOk } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/download/firmware           -> ecovital_pod.zip: the sketch folder (ecovital_pod/ with its 3 header files),
//                                         already pointing at this site, with this site's address filled in (no key is needed).
// GET /api/download/firmware?file=ino  -> just the .ino (needs logo.h, welcome.h and clips.h next to it)
const FILES = ["ecovital_pod.ino", "logo.h", "welcome.h", "clips.h"];

function readFw(name: string): Buffer | null {
  for (const base of [path.resolve(process.cwd(), "firmware", "ecovital_pod"), path.resolve(process.cwd(), "..", "firmware", "ecovital_pod")]) {
    const p = path.join(base, name);
    if (fs.existsSync(/*turbopackIgnore: true*/ p)) return fs.readFileSync(/*turbopackIgnore: true*/ p);
  }
  return null;
}

function preconfigure(src: string, origin: string): string {
  // Only the site address is filled in. The pod enrolls itself, so no key is put in the file.
  const out = src.replace(/^#define DEFAULT_BASE .*$/m, `#define DEFAULT_BASE "${origin}"`);
  return `// Pre-configured for EcoVital cloud: ${origin}
` + out;
}

// ---- minimal ZIP writer (stored, no compression) ----
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), crc = crc32(e.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(e.data.length, 18); h.writeUInt32LE(e.data.length, 22); h.writeUInt16LE(name.length, 26);
    parts.push(h, name, e.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(e.data.length, 20); c.writeUInt32LE(e.data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

export async function GET(req: NextRequest) {
  if (!(await adminOk(req))) return NextResponse.json({ error: "Sign in as the admin account." }, { status: 401 });
  const origin = req.nextUrl.origin;
  const ino = readFw("ecovital_pod.ino");
  if (!ino) return NextResponse.json({ error: "Firmware source is not bundled with this deployment." }, { status: 404 });
  const sketch = Buffer.from(preconfigure(ino.toString("utf8"), origin), "utf8");

  if (req.nextUrl.searchParams.get("file") === "ino") {
    return new NextResponse(new Uint8Array(sketch), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": 'attachment; filename="ecovital_pod.ino"', "Cache-Control": "no-store" },
    });
  }
  const entries = FILES.map((f) => ({ name: `ecovital_pod/${f}`, data: f === "ecovital_pod.ino" ? sketch : readFw(f) }))
    .filter((e): e is { name: string; data: Buffer } => !!e.data);
  const z = zip(entries);
  return new NextResponse(new Uint8Array(z), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="ecovital_pod.zip"', "Content-Length": String(z.length), "Cache-Control": "no-store" },
  });
}
