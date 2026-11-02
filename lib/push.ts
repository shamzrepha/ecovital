import webpush from "web-push";
import { db } from "./db.ts";

// Standard VAPID credentials for EcoVital Web Push alerts.
// Can be customized via environment variables.
const DEFAULT_VAPID_PUBLIC = "BOSaF49_j32E2T0z36vO5JqNlD9ZvZvZ_GgK3B9_H6UqGZp5a6q5PjZ5kZ0L7Q8R9S0T1U2V3W4X5Y6Z7A8B9C0";
const DEFAULT_VAPID_PRIVATE = "z4X1c2V3b4N5m6A7s8D9f0G1h2J3k4L5z6X7c8V9b0N";

let vapidConfigured = false;

function ensureVapid(): { publicKey: string; privateKey: string } {
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;

  if (!pub || !priv) {
    // Generate or use consistent fallback keys
    const generated = webpush.generateVAPIDKeys();
    pub = pub || generated.publicKey;
    priv = priv || generated.privateKey;
  }

  if (!vapidConfigured) {
    try {
      webpush.setVapidDetails(
        "mailto:shamzypre14@gmail.com",
        pub,
        priv
      );
      vapidConfigured = true;
    } catch { /* ignore if already set */ }
  }

  return { publicKey: pub, privateKey: priv };
}

export function getVapidPublicKey(): string {
  return ensureVapid().publicKey;
}

export interface PushOptions {
  userId: string;
  title: string;
  body: string;
  tag?: string;
  isGasAlarm?: boolean;
  data?: Record<string, any>;
}

export async function sendPushToUser(opts: PushOptions): Promise<{ sent: number; failed: number }> {
  ensureVapid();
  const sql = await db();

  // Check user quiet hours preference
  const userRows = await sql`SELECT prefs FROM users WHERE id = ${opts.userId}`;
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

  const subs = await sql`SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id = ${opts.userId}`;
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

      await webpush.sendNotification(pushSub, payload);
      sent++;
    } catch (e: any) {
      failed++;
      // If subscription has expired or unsubscribed, remove it
      if (e?.statusCode === 410 || e?.statusCode === 404) {
        await sql`DELETE FROM push_subscriptions WHERE id = ${sub.id}`.catch(() => {});
      }
    }
  }

  return { sent, failed };
}
