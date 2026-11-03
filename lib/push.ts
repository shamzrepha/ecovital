import webpush from "web-push";
import { db } from "./db.ts";

// Web Push (phone notifications that arrive even when the app is closed).
// VAPID keys come from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) or, if not set, are made once and kept in the database.
let cached: { pub: string; priv: string } | null = null;

async function keys() {
  if (cached) return cached;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    cached = { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY };
    return cached;
  }
  const sql = await db();
  await sql`CREATE TABLE IF NOT EXISTS push_config (id int PRIMARY KEY, pub text NOT NULL, priv text NOT NULL)`;
  let rows = await sql`SELECT pub, priv FROM push_config WHERE id = 1`;
  if (!rows.length) {
    const k = webpush.generateVAPIDKeys();
    await sql`INSERT INTO push_config (id, pub, priv) VALUES (1, ${k.publicKey}, ${k.privateKey}) ON CONFLICT (id) DO NOTHING`;
    rows = await sql`SELECT pub, priv FROM push_config WHERE id = 1`;
  }
  cached = { pub: rows[0].pub, priv: rows[0].priv };
  return cached;
}

export async function vapidPublicKey() { return (await keys()).pub; }

export type PushPayload = { title: string; body: string; podId?: string; alarm?: boolean; tag?: string; url?: string };

// Sends to every saved phone (all of them when the pod has no owner yet). Dead subscriptions are removed.
export async function sendPush(userId: string | null, p: PushPayload): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  try {
    const k = await keys();
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:alerts@ecovital.app", k.pub, k.priv);
    const sql = await db();
    const subs = userId
      ? await sql`SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id = ${userId}`
      : await sql`SELECT id, endpoint, keys FROM push_subscriptions`;
    const body = JSON.stringify(p);
    await Promise.all(subs.map(async (s: any) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, {
          TTL: p.alarm ? 3600 : 600,
          urgency: p.alarm ? "high" : "normal",
          timeout: 8000,
        });
        out.sent++;
      } catch (e: any) {
        out.failed++;
        if (e?.statusCode === 404 || e?.statusCode === 410) await sql`DELETE FROM push_subscriptions WHERE id = ${s.id}`;
      }
    }));
  } catch { /* push must never break ingest */ }
  return out;
}
