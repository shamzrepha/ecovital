import webpush from "web-push";
import { db } from "./db.ts";
import { sendFcmToUser } from "./fcm.ts";

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
  let fcmSent = 0;
  let fcmFailed = 0;

  // Always attempt FCM to registered Android phones first
  try {
    const fcmCause = opts.data?.cause || (opts.isGasAlarm ? (opts.body.toLowerCase().includes("smoke") ? "smoke" : "gas") : "dust");
    const fcmPodId = opts.data?.podId || (opts.tag ? opts.tag.replace(/^pod-/, "") : "");
    const fcmRes = await sendFcmToUser(opts.userId, {
      type: opts.isGasAlarm ? "alarm" : "alert",
      title: opts.title,
      body: opts.body,
      podId: fcmPodId,
      cause: fcmCause,
      ts: new Date().toISOString(),
    });
    fcmSent = fcmRes.sent;
    fcmFailed = fcmRes.failed;
  } catch (e) {
    console.error("[push] sendFcmToUser error:", e);
  }

  // Next, attempt Web Push if configured
  let webPushSent = 0;
  let webPushFailed = 0;
  try {
    const vapid = await ensureVapid().catch(() => null);
    if (vapid) {
      const sql = await db();

      // Check user quiet hours preference
      const userRows = opts.userId ? await sql`SELECT prefs FROM users WHERE id = ${opts.userId}` : [];
      const prefs = userRows[0]?.prefs || {};

      // Gas alarms bypass quiet hours completely!
      let inQuiet = false;
      if (!opts.isGasAlarm && prefs.quietEnabled) {
        const startHour = Number(prefs.quietStartHour ?? 22);
        const endHour = Number(prefs.quietEndHour ?? 7);
        const currentHour = new Date().getHours();

        if (startHour > endHour) {
          inQuiet = currentHour >= startHour || currentHour < endHour;
        } else {
          inQuiet = currentHour >= startHour && currentHour < endHour;
        }
      }

      if (!inQuiet) {
        const subs = opts.userId
          ? await sql`SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id = ${opts.userId}`
          : await sql`SELECT id, endpoint, keys FROM push_subscriptions`;

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

            await webpush.sendNotification(pushSub, payload, {
              TTL: opts.isGasAlarm ? 3600 : 600,
              urgency: opts.isGasAlarm ? "high" : "normal",
              timeout: 8000
            });
            webPushSent++;
          } catch (e: any) {
            webPushFailed++;
            if (e?.statusCode === 410 || e?.statusCode === 404 || e?.statusCode === 401 || e?.statusCode === 403) {
              await sql`DELETE FROM push_subscriptions WHERE id = ${sub.id}`.catch(() => {});
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("[push] web push error:", e);
  }

  return { sent: fcmSent + webPushSent, failed: fcmFailed + webPushFailed };
}
