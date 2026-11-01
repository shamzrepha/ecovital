// Accounts and pairing: sign-up/in, session cookies, the Add pod status check, and owner-only actions.
process.env.LOCAL_PGLITE = "1";
process.env.SESSION_SECRET = "test-session-secret";
delete process.env.GEMINI_API_KEY;

import { test } from "node:test";
import assert from "node:assert/strict";
import { ingest } from "../lib/ingest.ts";
import { claimPodByCode, pairStatus, unclaimPod } from "../lib/pods.ts";
import {
  createAccount, loginAccount, makeSessionCookie, userIdFromRequest, requirePodOwner, hashPassword, verifyPassword,
} from "../lib/session.ts";

const reqWith = (cookie?: string) => new Request("http://localhost/x", { headers: cookie ? { cookie } : {} });
const cookieValue = (setCookie: string) => setCookie.split(";")[0];

test("passwords are hashed and verified", () => {
  const h = hashPassword("correct horse");
  assert.notEqual(h, "correct horse");
  assert.equal(verifyPassword("correct horse", h), true);
  assert.equal(verifyPassword("wrong", h), false);
  assert.equal(verifyPassword("x", null), false);
});

test("sign up, sign in, and a tampered cookie is rejected", async () => {
  const a = await createAccount("Ada@Example.com", "Ada", "longenough1");
  assert.equal(a.email, "ada@example.com");
  await assert.rejects(() => createAccount("ada@example.com", "Again", "longenough1"), /already exists/);
  await assert.rejects(() => createAccount("short@example.com", "S", "short"), /8 characters/);
  await assert.rejects(() => loginAccount("ada@example.com", "nope-nope"), /not right/);
  const again = await loginAccount("ada@example.com", "longenough1");
  assert.equal(again.id, a.id);

  const c = cookieValue(makeSessionCookie(a.id));
  assert.equal(userIdFromRequest(reqWith(c)), a.id);
  assert.equal(userIdFromRequest(reqWith(c.slice(0, -2) + "xx")), null);
  assert.equal(userIdFromRequest(reqWith()), null);
});

test("pairing: not heard, then heard, claim, then owner-only", async () => {
  const ana = await createAccount("ana@example.com", "Ana", "longenough1");
  const ben = await createAccount("ben@example.com", "Ben", "longenough1");

  // Nothing has announced this code yet. Repeated checks while waiting must NOT lock the user out of claiming.
  for (let i = 0; i < 8; i++) assert.equal((await pairStatus("WAIT26", ana.id)).state, "not-heard");
  assert.equal((await pairStatus("bad", ana.id)).state, "invalid");

  await ingest({ id: "pod-pair-1", name: "Pod Pair", meta: { fw: "1.4", claim: "PAIR26" } }, [{ ageMs: 0, dust: 10, air: 90, temp: 26, hum: 48 }]);
  const heard = await pairStatus("pair26", ana.id);
  assert.equal(heard.state, "heard");
  assert.equal(heard.podId, "pod-pair-1");

  const claimed = await claimPodByCode({ code: "PAIR26", userId: ana.id, nickname: "Room 4", roomProfile: "lab" });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.name, "Room 4");
  assert.ok(claimed.deviceToken);

  // Entering the code again as the same owner is harmless and does not rotate the token.
  const again = await claimPodByCode({ code: "PAIR26", userId: ana.id });
  assert.equal(again.ok, true);
  assert.equal(again.deviceToken, undefined);

  assert.equal((await pairStatus("PAIR26", ana.id)).state, "yours");
  assert.equal((await pairStatus("PAIR26", ben.id)).state, "taken");
  const stolen = await claimPodByCode({ code: "PAIR26", userId: ben.id });
  assert.equal(stolen.ok, false);
  assert.match(stolen.error!, /another account/);

  // Only the owner can open or remove it.
  await requirePodOwner(reqWith(cookieValue(makeSessionCookie(ana.id))), "pod-pair-1");
  await assert.rejects(() => requirePodOwner(reqWith(cookieValue(makeSessionCookie(ben.id))), "pod-pair-1"), /not found/i);
  await assert.rejects(() => requirePodOwner(reqWith(), "pod-pair-1"), /Sign in/);
  assert.equal((await unclaimPod("pod-pair-1", ben.id)).ok, false);
  assert.equal((await unclaimPod("pod-pair-1", ana.id)).ok, true);
  assert.equal((await pairStatus("PAIR26", ben.id)).state, "heard");
});

test("wrong-code guessing still locks claiming after 5 tries", async () => {
  const cy = await createAccount("cy@example.com", "Cy", "longenough1");
  for (let i = 0; i < 4; i++) assert.equal((await claimPodByCode({ code: "ZZZZ9" + i, userId: cy.id })).locked, false);
  assert.equal((await claimPodByCode({ code: "ZZZZ95", userId: cy.id })).locked, true);
  assert.equal((await claimPodByCode({ code: "ZZZZ96", userId: cy.id })).locked, true);
});

test("app settings and SOS reach the pod in the ingest reply, SOS only once", async () => {
  const dee = await createAccount("dee@example.com", "Dee", "longenough1");
  const sample = [{ ageMs: 0, dust: 10, air: 90, temp: 26, hum: 48 }];
  await ingest({ id: "pod-sos-1", name: "Pod", meta: { fw: "1.6", claim: "SOSX26" } }, sample);
  assert.equal((await claimPodByCode({ code: "SOSX26", userId: dee.id, nickname: 'Room "7"' })).ok, true);

  const first = await ingest({ id: "pod-sos-1", name: "Pod", meta: { fw: "1.6", claim: "SOSX26" } }, sample);
  assert.equal(first.name, "Room 7");                       // quotes are stripped so the pod can parse it
  assert.equal(first.lim?.length, 16);
  assert.equal(first.sos, undefined);

  const { db } = await import("../lib/db.ts");
  const sql = await db();
  await sql`UPDATE pods SET sos_at = now() WHERE device_id = 'pod-sos-1'`;
  assert.equal((await ingest({ id: "pod-sos-1", name: "Pod", meta: {} }, sample)).sos, true);
  assert.equal((await ingest({ id: "pod-sos-1", name: "Pod", meta: {} }, sample)).sos, undefined);

  await sql`UPDATE pods SET sos_at = now() - interval '5 minutes' WHERE device_id = 'pod-sos-1'`;
  assert.equal((await ingest({ id: "pod-sos-1", name: "Pod", meta: {} }, sample)).sos, undefined);   // stale SOS is dropped
});

test("a pod enrolls itself with no key, gets a private token, and only the token works afterwards", async () => {
  process.env.DEVICE_KEY = "shared-test-key";
  const { verifyPodIngestKey } = await import("../lib/pods.ts");
  const { db } = await import("../lib/db.ts");
  const sql = await db();
  const ev = (key: string) => verifyPodIngestKey({ deviceId: "pod-enroll-1", providedKey: key, claim: "ENRL26", fw: "1.7" });

  assert.equal((await ev("")).authorized, true);                       // first contact, no key in the firmware
  const row = await sql`SELECT device_token, token_delivered FROM pods WHERE device_id = 'pod-enroll-1'`;
  const tok = row[0].device_token as string;
  assert.match(tok, /^evtok_/);

  const first = await ingest({ id: "pod-enroll-1", name: "P", meta: { fw: "1.7", claim: "ENRL26" } }, [{ ageMs: 0, dust: 10, air: 90, temp: 26, hum: 48 }]);
  assert.equal(first.deviceToken, tok);                                // handed to the pod in the reply

  assert.equal((await ev("")).authorized, true);                       // still allowed until the pod proves it has the token
  assert.equal((await ev(tok)).authorized, true);
  assert.equal((await ev("")).authorized, false);                      // now keyless contact is refused
  assert.equal((await ev("wrong")).authorized, false);

  // Owner removes the pod: the token is cleared and the pod can enroll again with a new one.
  const u = await createAccount("eve@example.com", "Eve", "longenough1");
  assert.equal((await claimPodByCode({ code: "ENRL26", userId: u.id })).ok, true);
  assert.equal((await unclaimPod("pod-enroll-1", u.id)).ok, true);
  assert.equal((await ev(tok)).authorized, false);
  assert.equal((await ev("")).authorized, true);
});

test("a queued firmware update never downgrades a pod, and a stale order is dropped", async () => {
  const { compareVersions } = await import("../lib/ingest.ts");
  const { createFirmwareRelease } = await import("../lib/pods.ts");
  const { db } = await import("../lib/db.ts");
  assert.ok(compareVersions("1.10", "1.9") > 0);
  assert.ok(compareVersions("1.6", "1.7") < 0);
  assert.equal(compareVersions("1.7", "1.7"), 0);

  const sample = [{ ageMs: 0, dust: 10, air: 90, temp: 26, hum: 48 }];
  await createFirmwareRelease({ version: "1.6", url: "https://example.test/1.6.bin", targetPods: ["pod-ota-1"] });
  // The pod was flashed over USB with 1.7 after the 1.6 update was queued.
  const same = await ingest({ id: "pod-ota-1", name: "P", meta: { fw: "1.7" } }, sample);
  assert.equal(same.otaVersion, undefined);
  const sql = await db();
  assert.equal((await sql`SELECT 1 FROM pod_firmware_target WHERE device_id = 'pod-ota-1'`).length, 0);

  await createFirmwareRelease({ version: "1.8", url: "https://example.test/1.8.bin", targetPods: ["pod-ota-1"] });
  const up = await ingest({ id: "pod-ota-1", name: "P", meta: { fw: "1.7" } }, sample);
  assert.equal(up.otaVersion, "1.8");
});
