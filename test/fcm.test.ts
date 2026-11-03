import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { db } from "../lib/db.ts";
import {
  isFcmConfigured,
  saveFcmToken,
  deleteFcmToken,
  countFcmPhones,
  sendFcmToUser,
} from "../lib/fcm.ts";
import { sendPushToUser } from "../lib/push.ts";

// Generate a real ephemeral RSA key pair for testing JWT signing
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const fakeServiceAccount = {
  project_id: "ecovital-test-project",
  private_key: privateKey,
  client_email: "firebase-adminsdk@ecovital-test-project.iam.gserviceaccount.com",
  token_uri: "https://mock-oauth2.googleapis.com/token",
};

test("FCM configuration detection and count", async () => {
  const orig = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  assert.equal(isFcmConfigured(), false);

  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(fakeServiceAccount);
  assert.equal(isFcmConfigured(), true);

  if (orig !== undefined) {
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = orig;
  } else {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  }
});

test("saving, counting, and deleting FCM tokens", async () => {
  const sql = await db();
  const testUserId = "user-fcm-" + Date.now();
  const testToken1 = "token-" + Date.now() + "-1";
  const testToken2 = "token-" + Date.now() + "-2";

  const beforeCount = await countFcmPhones();

  await saveFcmToken(testUserId, testToken1, "android");
  await saveFcmToken(testUserId, testToken2, "android");

  const midCount = await countFcmPhones();
  assert.equal(midCount, beforeCount + 2);

  // Updating the token should not increase count (conflict update)
  await saveFcmToken(testUserId, testToken1, "android");
  assert.equal(await countFcmPhones(), beforeCount + 2);

  await deleteFcmToken(testToken1);
  await deleteFcmToken(testToken2);
  assert.equal(await countFcmPhones(), beforeCount);
});

test("sendPushToUser dispatches FCM data-only payload: alarm vs alert, and deletes dead tokens", async () => {
  const origSA = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(fakeServiceAccount);

  const testUserId = "fcm-user-" + Date.now();
  const activeToken = "valid-fcm-token-" + Date.now();
  const deadToken = "dead-fcm-token-" + Date.now();

  await saveFcmToken(testUserId, activeToken, "android");
  await saveFcmToken(testUserId, deadToken, "android");

  const sentRequests: Array<{ url: string; headers: Headers; body: any }> = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();

    // Mock OAuth2 token endpoint
    if (url.includes("mock-oauth2.googleapis.com") || url.includes("oauth2.googleapis.com")) {
      return new Response(
        JSON.stringify({
          access_token: "mock-google-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Mock FCM v1 send endpoint
    if (url.includes("fcm.googleapis.com")) {
      const parsedBody = JSON.parse(init?.body as string);
      sentRequests.push({ url, headers: new Headers(init?.headers), body: parsedBody });

      if (parsedBody.message?.token === deadToken) {
        return new Response(
          JSON.stringify({
            error: {
              code: 404,
              message: "Requested entity was not found.",
              status: "NOT_FOUND",
              details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }],
            },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ name: "projects/ecovital-test/messages/msg-12345" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return originalFetch(input, init);
  };

  try {
    // 1. Gas alarm -> sends type: "alarm"
    await sendPushToUser({
      userId: testUserId,
      title: "🚨 Gas alert",
      body: "Possible gas or fumes detected",
      isGasAlarm: true,
      tag: "pod-living-room",
    });

    const alarmReq = sentRequests.find((r) => r.body.message.token === activeToken);
    assert.ok(alarmReq, "FCM message was sent to active token");
    assert.equal(alarmReq.body.message.data.type, "alarm");
    assert.equal(alarmReq.body.message.android.priority, "HIGH");
    assert.equal(alarmReq.body.message.data.podId, "living-room");
    assert.equal(typeof alarmReq.body.message.notification, "undefined", "Must be data-only (no top-level notification)");

    // Verify dead token was deleted
    const sql = await db();
    const deadCheck = await sql`SELECT token FROM fcm_tokens WHERE token = ${deadToken}`;
    assert.equal(deadCheck.length, 0, "Dead token returning 404/UNREGISTERED was removed from database");

    // 2. Non-gas alert -> sends type: "alert"
    sentRequests.length = 0;
    await sendPushToUser({
      userId: testUserId,
      title: "Dust alert",
      body: "Dust level is slightly elevated",
      isGasAlarm: false,
      tag: "pod-living-room",
    });

    const alertReq = sentRequests.find((r) => r.body.message.token === activeToken);
    assert.ok(alertReq, "FCM message was sent for non-gas alert");
    assert.equal(alertReq.body.message.data.type, "alert");
    assert.equal(typeof alertReq.body.message.notification, "undefined", "Must be data-only");
  } finally {
    globalThis.fetch = originalFetch;
    if (origSA !== undefined) {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = origSA;
    } else {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    }
    await deleteFcmToken(activeToken);
    await deleteFcmToken(deadToken);
  }
});
