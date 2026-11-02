// Version 2.0: app commands to the pod, quiet hours, pod health numbers, and time in the comfortable range.
process.env.LOCAL_PGLITE = "1";
process.env.SESSION_SECRET = "test-session-secret";
delete process.env.GEMINI_API_KEY;

import { test } from "node:test";
import assert from "node:assert/strict";
import { ingest, inQuietHours } from "../lib/ingest.ts";
import { claimPodByCode, computeComfort, updatePodSettings } from "../lib/pods.ts";
import { createAccount } from "../lib/session.ts";
import { db } from "../lib/db.ts";

const sample = (over: Record<string, number> = {}) => [{ ageMs: 0, dust: 10, air: 90, temp: 26, hum: 48, ...over }];

test("quiet hours: same-day and overnight windows, in the owner's time zone", () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 10, 2, h, m);
  // Lagos is UTC+1 (60 minutes). 22:00 to 06:00 local.
  assert.equal(inQuietHours(at(21, 30), 22, 6, 60), true);    // 22:30 local
  assert.equal(inQuietHours(at(3), 22, 6, 60), true);         // 04:00 local
  assert.equal(inQuietHours(at(5, 30), 22, 6, 60), false);    // 06:30 local
  assert.equal(inQuietHours(at(12), 22, 6, 60), false);
  assert.equal(inQuietHours(at(13), 12, 14, 0), true);        // a same-day window
  assert.equal(inQuietHours(at(15), 12, 14, 0), false);
  assert.equal(inQuietHours(at(12), null, null, 60), false);  // off
  assert.equal(inQuietHours(at(12), 5, 5, 60), false);        // empty window
});

test("app commands reach the pod once, and a stale command is dropped", async () => {
  const u = await createAccount("cmd@example.com", "Cmd", "longenough1");
  await ingest({ id: "pod-cmd-1", name: "P", meta: { fw: "2.0", claim: "CMDX26" } }, sample());
  assert.equal((await claimPodByCode({ code: "CMDX26", userId: u.id })).ok, true);
  const sql = await db();

  await sql`UPDATE pods SET cmd = 'identify', cmd_at = now() WHERE device_id = 'pod-cmd-1'`;
  assert.equal((await ingest({ id: "pod-cmd-1", name: "P", meta: {} }, sample())).cmd, "identify");
  assert.equal((await ingest({ id: "pod-cmd-1", name: "P", meta: {} }, sample())).cmd, undefined);

  await sql`UPDATE pods SET cmd = 'restart', cmd_at = now() - interval '10 minutes' WHERE device_id = 'pod-cmd-1'`;
  assert.equal((await ingest({ id: "pod-cmd-1", name: "P", meta: {} }, sample())).cmd, undefined);

  await sql`UPDATE pods SET cmd = 'format-disk', cmd_at = now() WHERE device_id = 'pod-cmd-1'`;
  assert.equal((await ingest({ id: "pod-cmd-1", name: "P", meta: {} }, sample())).cmd, undefined);   // unknown commands never go out
});

test("quiet hours mute the pod and suppress spoken lines, and leaving them restores it", async () => {
  const u = await createAccount("quiet@example.com", "Quiet", "longenough1");
  await ingest({ id: "pod-quiet-1", name: "P", meta: { fw: "2.0", claim: "QUIE26" } }, sample());
  await claimPodByCode({ code: "QUIE26", userId: u.id });

  const h = new Date().getUTCHours();
  await updatePodSettings("pod-quiet-1", { quietStart: h, quietEnd: (h + 2) % 24, tzMin: 0 });
  assert.equal((await ingest({ id: "pod-quiet-1", name: "P", meta: {} }, sample())).mute, true);

  await updatePodSettings("pod-quiet-1", { quietStart: null, quietEnd: null });
  assert.equal((await ingest({ id: "pod-quiet-1", name: "P", meta: {} }, sample())).mute, false);
});

test("pod health numbers are kept with the device", async () => {
  await ingest({ id: "pod-health-1", name: "P", meta: { fw: "2.0", heap: 180000, rst: "power", drops: 2, dhtOk: true } }, sample());
  const sql = await db();
  const r = await sql`SELECT meta FROM devices WHERE id = 'pod-health-1'`;
  assert.equal(r[0].meta.heap, 180000);
  assert.equal(r[0].meta.rst, "power");
  assert.equal(r[0].meta.drops, 2);
});

test("time in the comfortable range counts only the time spent comfortable", async () => {
  const now = Date.now();
  // 60 five-minute steps over the last 5 hours: the first 45 comfortable, the last 15 too dry
  await ingest({ id: "pod-comfort-1", name: "P", meta: { fw: "2.0" } },
    Array.from({ length: 60 }, (_, i) => ({ ageMs: (59 - i) * 5 * 60_000, dust: 10, air: 90, temp: 26, hum: i < 45 ? 50 : 20 })), { now });
  const c = await computeComfort("pod-comfort-1", now);
  assert.ok(c.last24h.hours >= 4.5, `hours ${c.last24h.hours}`);
  assert.equal(c.last24h.dust, 100);
  assert.equal(c.last24h.air, 100);
  assert.ok(c.last24h.hum! >= 70 && c.last24h.hum! <= 80, `humidity ${c.last24h.hum}`);
  assert.equal(c.last24h.overall, c.last24h.hum);       // only humidity was ever outside its range
});
