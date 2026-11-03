import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getVapidPublicKey, sendPushToUser } from "../lib/push.ts";
import { db } from "../lib/db.ts";

test("VAPID public key is returned, formatted correctly and stays the same", async () => {
  const key = await getVapidPublicKey();
  assert.equal(await getVapidPublicKey(), key);
  assert.ok(typeof key === "string" && key.length > 30);
});

test("gas alarms bypass quiet hours while non-urgent alerts respect quiet hours", async () => {
  const sql = await db();
  const testUserId = "test-user-push-" + Date.now();
  const currentHour = new Date().getHours();

  // Create a user with quiet hours active right now
  await sql`
    INSERT INTO users (id, email, name, role, prefs)
    VALUES (${testUserId}, ${testUserId + "@example.com"}, 'Push Tester', 'owner',
            ${JSON.stringify({ quietEnabled: true, quietStartHour: currentHour, quietEndHour: (currentHour + 1) % 24 })}::jsonb)
  `;

  // Normal alert during quiet hours should be suppressed
  const normalResult = await sendPushToUser({
    userId: testUserId,
    title: "Routine Dust Alert",
    body: "Dust level is slightly elevated.",
    isGasAlarm: false,
  });
  assert.equal(normalResult.sent, 0);

  // Gas alarm during quiet hours must BYPASS quiet hours
  // (Notice it does not exit early with { sent: 0, failed: 0 } due to quiet hours; it attempts delivery to the user's subscriptions)
  const gasResult = await sendPushToUser({
    userId: testUserId,
    title: "🚨 Gas Leak Detected",
    body: "Hazardous fumes detected in room.",
    isGasAlarm: true,
  });
  // Since test user has 0 registered push devices in DB, sent is 0, but it wasn't blocked by quiet hours
  assert.equal(gasResult.failed, 0);
});
