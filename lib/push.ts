import webpush from "web-push";
import { db } from "./db.ts";

// VAPID keys must stay the same forever: a phone subscribed with one key pair only accepts pushes signed by that pair.
// Serverless instances restart often, so the pair comes from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) or is created
// once and kept in the database. (Making new keys on each start silently broke every subscription.)
let keyCache: { publicKey: string; privateKey: string } | null = null;
let vapidConfigured = false;

async function ensureVapid(): Promise<{ publicKey: string; privateKey: string }> {
  if (!keyCache) {
    const envPub = process.env.VAPID_PUBLIC_KEY, envPriv = process.env.VAPID_PRIVATE_KEY;
    if (envPub && envPriv) {
      keyCache = { publicKey: envPub, privateKey: envPriv };
    } else {
      const sql = await db();
      await sql`CREATE TABLE IF NOT EXISTS push_config (id int PRIMARY KEY, pub text NOT NULL, priv text NOT NULL)`;
      let rows = await sql`SELECT pub, priv FROM push_config WHERE id = 1`;
      if (!rows.length) {
        const g = webpush.generateVAPIDKeys();
        await sql`INSERT INTO push_config (id, pub, priv) VALUES (1, ${g.publicKey}, ${g.privateKey}) ON CONFLICT (id) DO NOTHING`;
        rows = await sql`SELECT pub, priv FROM push_config WHERE id = 1`;
      }
      keyCache = { publicKey: String(rows[0].pub), privateKey: String(rows[0].priv) };
    }
  }
  if (!vapidConfigured) {
    webpush.setVapidDetails("mailto:shamzypre14@gmail.com", keyCache.publicKey, keyCache.privateKey);
    vapidConfigured = true;
  }
  return keyCache;
}

export async function getVapidPublicKey(): Promise<string> {
  return (await ensureVapid()).publicKey;
}

export interface PushOptions {
  userId: string | null;   // null = every saved phone (pod not claimed yet)
  title: string;
  body: string;
  tag?: string;
  isGasAlarm?: boolean;
  data?: Record<string, any>;
}

export async function sendPushToUser(opts: PushOptions): Promise<{ sent: number; failed: number }> {
  try { await ensureVapid(); } catch { return { sent: 0, failed: 0 }; }
  const sql = await db();

  // Check user quiet hours preference
  const userRows = opts.userId ? await sql`SELECT prefs FROM users WHERE id = ${opts.userId}` : [];
  const prefs = userRows[0]?.prefs || {};

  // Gas alarms bypass quiet hours completely!
  if (!opts.isGasAlarm && prefs.quietEnabled) {
    const startHour = Number(prefs.quietStartHour ?? 22);
    const endHour = Number(prefs.quietEndHour ?? 7);
    const currentHour = new Date().getHours();

    let inQuiet = false;
    if (startHour > endHour) {
      inQuiet = currentHour >= startHour || currentHour < endHour;
    } else {
      inQuiet = currentHour >= startHour && currentHour < endHour;
    }

    if (inQuiet) {
      return { sent: 0, failed: 0 };
    }
  }

  const subs = opts.userId
    ? await sql`SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id = ${opts.userId}`
    : await sql`SELECT id, endpoint, keys FROM push_subscriptions`;
  let sent = 0;
  let failed = 0;

  const payload = JSON.stringify({
    title: opts.title,
    body: opts.body,
    tag: opts.tag || "ecovital-alert",
    isGasAlarm: !!opts.isGasAlarm,
    icon: "/assets/logo.png",
    data: opts.data || { url: "/" },
  });

  for (const sub of subs) {
    try {
      const pushSub = {
        endpoint: sub.endpoint,
        keys: typeof sub.keys === "string" ? JSON.parse(sub.keys) : sub.keys,
      };

      await webpush.sendNotification(pushSub, payload, { TTL: opts.isGasAlarm ? 3600 : 600, urgency: opts.isGasAlarm ? "high" : "normal", timeout: 8000 });
      sent++;
    } catch (e: any) {
      failed++;
      // If subscription has expired or unsubscribed, remove it
      if (e?.statusCode === 410 || e?.statusCode === 404 || e?.statusCode === 401 || e?.statusCode === 403) {
        await sql`DELETE FROM push_subscriptions WHERE id = ${sub.id}`.catch(() => {});
      }
    }
  }

  return { sent, failed };
}
