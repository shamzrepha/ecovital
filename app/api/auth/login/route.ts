import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { errorResponse, HttpError, loginAccount, makeSessionCookie } from "@/lib/session";

export const runtime = "nodejs";

const MAX_FAILS = 8;
const LOCK_MIN = 10;

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const email = String(b.email ?? "").trim().toLowerCase();
    const sql = await db();
    const key = `login:${email}`;
    const row = await sql`SELECT fails, (extract(epoch from locked_until) * 1000)::float8 AS lu FROM claim_attempts WHERE user_id = ${key} AND code = '__login__'`;
    if (row.length && row[0].lu && Number(row[0].lu) > Date.now()) {
      throw new HttpError(429, "Too many sign-in attempts. Wait a few minutes and try again.");
    }
    try {
      const user = await loginAccount(email, String(b.password ?? ""));
      await sql`DELETE FROM claim_attempts WHERE user_id = ${key} AND code = '__login__'`;
      const res = NextResponse.json({ ok: true, user });
      res.headers.set("set-cookie", makeSessionCookie(user.id));
      return res;
    } catch (e) {
      const fails = Number(row[0]?.fails ?? 0) + 1;
      const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60_000).toISOString() : null;
      await sql`INSERT INTO claim_attempts (user_id, code, fails, locked_until) VALUES (${key}, '__login__', ${fails}, ${lock}::timestamptz)
                ON CONFLICT (user_id, code) DO UPDATE SET fails = ${fails}, locked_until = ${lock}::timestamptz`;
      throw e;
    }
  } catch (e) {
    return errorResponse(e);
  }
}
