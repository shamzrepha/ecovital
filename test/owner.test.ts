// Only the owner email can be admin, and only with the owner setup code.
process.env.LOCAL_PGLITE = "1";
process.env.SESSION_SECRET = "test-session-secret";
process.env.ADMIN_SETUP_CODE = "owner-secret-code";
delete process.env.ROOT_ADMIN_EMAIL;
delete process.env.GEMINI_API_KEY;

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccount, loginAccount, getSessionUser, makeSessionCookie, roleFor } from "../lib/session.ts";
import { db } from "../lib/db.ts";

const asCookie = (id: string) => new Request("http://localhost/x", { headers: { cookie: makeSessionCookie(id).split(";")[0] } });

test("the owner email needs the setup code; nobody else can take it", async () => {
  await assert.rejects(() => createAccount("shamzypre14@gmail.com", "Imposter", "longenough1"), /reserved/);
  await assert.rejects(() => createAccount("shamzypre14@gmail.com", "Imposter", "longenough1", "wrong-code"), /reserved/);
  const owner = await createAccount("ShamzyPre14@Gmail.com", "Shamaryah", "longenough1", "owner-secret-code");
  assert.equal(owner.role, "admin");
  assert.equal((await loginAccount("shamzypre14@gmail.com", "longenough1")).role, "admin");
  assert.equal((await getSessionUser(asCookie(owner.id)))?.role, "admin");
});

test("everyone else is a normal user, even if the database says admin", async () => {
  const u = await createAccount("someone@example.com", "Someone", "longenough1");
  assert.equal(u.role, "user");
  const sql = await db();
  await sql`UPDATE users SET role = 'admin' WHERE id = ${u.id}`;      // a leftover "first user is admin" row
  assert.equal((await getSessionUser(asCookie(u.id)))?.role, "user");
  assert.equal((await loginAccount("someone@example.com", "longenough1")).role, "user");
  assert.equal(roleFor("SOMEONE@example.com"), "user");
});
