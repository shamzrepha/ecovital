import { NextResponse } from "next/server";
import { createAccount, errorResponse, makeSessionCookie } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const user = await createAccount(String(b.email ?? ""), String(b.name ?? ""), String(b.password ?? ""), String(b.setupCode ?? ""));
    const res = NextResponse.json({ ok: true, user });
    res.headers.set("set-cookie", makeSessionCookie(user.id));
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
