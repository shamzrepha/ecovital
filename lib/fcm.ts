import { createSign } from "node:crypto";
import { db } from "./db.ts";

export interface FcmDataPayload {
  type: "alarm" | "alert";
  title: string;
  body: string;
  podId: string;
  cause: string;
  ts: string;
}

interface ServiceAccount {
  project_id: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

export function getServiceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed.project_id && parsed.private_key && parsed.client_email) {
      return parsed as ServiceAccount;
    }
  } catch {
    // Malformed JSON
  }
  return null;
}

export function isFcmConfigured(): boolean {
  return getServiceAccount() !== null;
}

export async function countFcmPhones(): Promise<number> {
  const sql = await db();
  const rows = await sql`SELECT count(*)::int AS count FROM fcm_tokens`;
  return Number(rows[0]?.count ?? 0);
}

export async function saveFcmToken(userId: string, token: string, platform = "android"): Promise<void> {
  const sql = await db();
  await sql`
    INSERT INTO fcm_tokens (user_id, token, platform, last_seen)
    VALUES (${userId}, ${token}, ${platform}, now())
    ON CONFLICT (token) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          platform = EXCLUDED.platform,
          last_seen = now()
  `;
}

export async function deleteFcmToken(token: string): Promise<void> {
  const sql = await db();
  await sql`DELETE FROM fcm_tokens WHERE token = ${token}`;
}

export async function deleteUserFcmTokens(userId: string): Promise<void> {
  const sql = await db();
  await sql`DELETE FROM fcm_tokens WHERE user_id = ${userId}`;
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const nowMs = Date.now();
  if (cachedToken && cachedToken.expiresAt > nowMs + 60_000) {
    return cachedToken.token;
  }

  const nowSec = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64(header)}.${b64(payload)}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(sa.private_key, "base64url");
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`FCM OAuth request failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const token = data.access_token as string;
  const expiresIn = Number(data.expires_in ?? 3600);
  cachedToken = {
    token,
    expiresAt: nowMs + (expiresIn - 60) * 1000,
  };
  return token;
}

export async function sendFcmMessage(
  token: string,
  payload: FcmDataPayload,
  sa?: ServiceAccount
): Promise<boolean> {
  const account = sa || getServiceAccount();
  if (!account) return false;

  const accessToken = await getAccessToken(account);
  const url = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;

  const body = {
    message: {
      token,
      android: {
        priority: "HIGH",
        ttl: "3600s",
      },
      data: {
        type: String(payload.type),
        title: String(payload.title),
        body: String(payload.body),
        podId: String(payload.podId ?? ""),
        cause: String(payload.cause ?? "dust"),
        ts: String(payload.ts ?? new Date().toISOString()),
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.ok) {
    return true;
  }

  const errText = await res.text();
  const isDead =
    res.status === 404 ||
    res.status === 410 ||
    errText.includes("UNREGISTERED") ||
    errText.includes("NOT_FOUND") ||
    errText.includes("INVALID_ARGUMENT");

  if (isDead) {
    await deleteFcmToken(token).catch(() => {});
  }
  return false;
}

export async function sendFcmToUser(
  userId: string | null,
  data: FcmDataPayload
): Promise<{ sent: number; failed: number }> {
  const sa = getServiceAccount();
  if (!sa) {
    return { sent: 0, failed: 0 };
  }

  const sql = await db();
  const rows = userId
    ? await sql`SELECT token FROM fcm_tokens WHERE user_id = ${userId}`
    : await sql`SELECT token FROM fcm_tokens`;

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const ok = await sendFcmMessage(row.token, data, sa).catch(() => false);
    if (ok) {
      sent++;
    } else {
      failed++;
    }
  }

  return { sent, failed };
}
