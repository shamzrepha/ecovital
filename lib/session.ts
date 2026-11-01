// Accounts: scrypt password hashes and a signed, HttpOnly session cookie. No external auth service.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "./db.ts";

export const COOKIE = "ecovital_session";
const MAX_AGE_S = 60 * 60 * 24 * 30;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

function secret(): string {
  const s = process.env.SESSION_SECRET || process.env.ADMIN_KEY || process.env.DEVICE_KEY;
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET is not configured on the server");
  return "ecovital-dev-only-secret";
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = scryptSync(password, Buffer.from(salt, "base64url"), want.length);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function makeSessionCookie(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  const payload = `${userId}.${exp}`;
  const value = `${payload}.${sign(payload)}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function userIdFromRequest(req: Request): string | null {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const last = raw.lastIndexOf(".");
  if (last < 0) return null;
  const payload = raw.slice(0, last);
  const given = Buffer.from(raw.slice(last + 1));
  const want = Buffer.from(sign(payload));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  const dot = payload.lastIndexOf(".");
  const exp = Number(payload.slice(dot + 1));
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return null;
  return payload.slice(0, dot);
}

export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const id = userIdFromRequest(req);
  if (!id) return null;
  const sql = await db();
  const rows = await sql`SELECT id, email, name FROM users WHERE id = ${id}`;
  return rows.length ? ({ id: rows[0].id, email: rows[0].email, name: rows[0].name, role: roleFor(rows[0].email as string) } as SessionUser) : null;
}

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The one owner account. Only this email can be admin; the role is never read from the database. */
export const rootEmail = () => (process.env.ROOT_ADMIN_EMAIL || "shamzypre14@gmail.com").trim().toLowerCase();
export const roleFor = (email: string) => (email.trim().toLowerCase() === rootEmail() ? "admin" : "user");

export async function requireUser(req: Request): Promise<SessionUser> {
  const u = await getSessionUser(req);
  if (!u) throw new HttpError(401, "Sign in to continue.");
  return u;
}

/** The signed-in user must own the pod. Admin accounts may open any pod. */
export async function requirePodOwner(req: Request, podId: string): Promise<SessionUser> {
  const u = await requireUser(req);
  const sql = await db();
  const rows = await sql`SELECT claimed_by FROM pods WHERE device_id = ${podId}`;
  if (!rows.length || (rows[0].claimed_by !== u.id && u.role !== "admin")) {
    throw new HttpError(404, "Pod not found in your account.");
  }
  return u;
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return Response.json({ ok: false, error: e.message, code: e.code }, { status: e.status });
  return Response.json({ ok: false, error: String((e as any)?.message ?? e).slice(0, 300) }, { status: 500 });
}

export async function createAccount(email: string, name: string, password: string, setupCode = ""): Promise<SessionUser> {
  const clean = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new HttpError(400, "Enter a valid email address.");
  if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
  if (roleFor(clean) === "admin") {
    // Anyone could type the owner's email, so the owner account needs a secret code that only the owner has (set on the server).
    const want = process.env.ADMIN_SETUP_CODE || "";
    const a = Buffer.from(setupCode), b = Buffer.from(want);
    if (!want || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HttpError(403, want ? "This email is reserved for the EcoVital owner. Enter the owner setup code." : "This email is reserved for the EcoVital owner, and the owner setup code is not configured on the server yet.", "setup-code");
    }
  }
  const sql = await db();
  const taken = await sql`SELECT id, password_hash FROM users WHERE email = ${clean}`;
  if (taken.length && taken[0].password_hash) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
  const id = taken.length ? (taken[0].id as string) : "usr-" + randomBytes(8).toString("hex");
  const display = name.trim().slice(0, 60) || clean.split("@")[0];
  const hash = hashPassword(password);
  if (taken.length) {
    await sql`UPDATE users SET name = ${display}, password_hash = ${hash} WHERE id = ${id}`;
  } else {
    await sql`INSERT INTO users (id, email, name, role, password_hash) VALUES (${id}, ${clean}, ${display}, ${roleFor(clean)}, ${hash})`;
  }
  return { id, email: clean, name: display, role: roleFor(clean) };
}

export async function loginAccount(email: string, password: string): Promise<SessionUser> {
  const sql = await db();
  const rows = await sql`SELECT id, email, name, role, password_hash FROM users WHERE email = ${email.trim().toLowerCase()}`;
  // Same message for unknown email and wrong password.
  if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
    throw new HttpError(401, "Email or password is not right.");
  }
  const { id, name } = rows[0];
  return { id, email: rows[0].email, name, role: roleFor(rows[0].email as string) };
}
