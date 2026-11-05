import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyState } from "@exec-assistant/calendar";
import type { CalendarAccount } from "@exec-assistant/db";
import type { Sender } from "@exec-assistant/whatsapp";
import { notifyReauth, type WorkerConfig } from "./sync.js";

const SECRET = "s".repeat(32);
const UID = "6f1d5a3c-2b7e-4f5a-9c8d-0a1b2c3d4e5f";
const PHONE = "+2348012345678";

function fakeSender(onSend?: () => void): { sent: Array<{ to: string; text: string }>; sender: Sender } {
  const sent: Array<{ to: string; text: string }> = [];
  return {
    sent,
    sender: {
      kind: "test",
      async sendText(to, text) {
        onSend?.();
        sent.push({ to, text });
        return "test:1";
      },
      async sendTemplate() {
        return "test:2";
      },
    },
  };
}

function account(overrides: Partial<CalendarAccount> = {}): CalendarAccount {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    user_id: UID,
    provider: "google",
    access_token: "access-token",
    refresh_token: null,
    expires_at: null,
    calendar_id: "primary",
    synced_at: null,
    reauth_required_at: new Date("2026-11-05T12:00:00Z"),
    created_at: new Date("2026-11-01T00:00:00Z"),
    phone: PHONE,
    timezone: "Africa/Lagos",
    ...overrides,
  };
}

function config(sender: Sender, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    db: null as unknown as WorkerConfig["db"],
    sender,
    alarm: null,
    offsets: [15, 10, 5, 0],
    maxOffsetMinutes: 15,
    lookaheadDays: 14,
    syncIntervalMs: 300_000,
    maxSendAttempts: 3,
    batchSize: 50,
    devCalendar: false,
    google: {},
    template: { language: "en" },
    ...overrides,
  };
}

test("a dead grant messages the user a fresh signed connect link", async () => {
  const { sent, sender } = fakeSender();
  await notifyReauth(
    config(sender, {
      publicBaseUrl: "https://ecos.example.com/",
      oauthStateSecret: SECRET,
    }),
    account(),
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, PHONE, "goes to the user's own number");
  const link = sent[0].text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(link, "the message carries a link");
  const url = new URL(link);
  assert.equal(url.origin + url.pathname, "https://ecos.example.com/auth/google");
  assert.equal(url.searchParams.get("user"), null, "no raw user id in the link");
  const payload = verifyState({
    secret: SECRET,
    token: url.searchParams.get("token") ?? "",
    purpose: "connect",
  });
  assert.equal(payload?.uid, UID, "the link is signed for this user");
  assert.ok(sent[0].text.split("\n").length === 1, "one short message");
  assert.ok(!sent[0].text.includes("access-token"), "never leaks the token");
});

test("without PUBLIC_BASE_URL or OAUTH_STATE_SECRET nothing is sent", async () => {
  const missing = fakeSender();
  await notifyReauth(config(missing.sender, { oauthStateSecret: SECRET }), account());
  assert.equal(missing.sent.length, 0, "no base URL → no link");

  const missingSecret = fakeSender();
  await notifyReauth(
    config(missingSecret.sender, { publicBaseUrl: "https://ecos.example.com" }),
    account(),
  );
  assert.equal(missingSecret.sent.length, 0, "no secret → no link");
});

test("a send outside the 24h window is logged, not thrown", async () => {
  const { sender } = fakeSender(() => {
    throw new Error("WhatsApp send failed (131047): re-engagement required");
  });
  await assert.doesNotReject(
    notifyReauth(
      config(sender, {
        publicBaseUrl: "https://ecos.example.com",
        oauthStateSecret: SECRET,
      }),
      account(),
    ),
  );
});

test("an account with no phone is silently skipped", async () => {
  const { sent, sender } = fakeSender();
  await notifyReauth(
    config(sender, {
      publicBaseUrl: "https://ecos.example.com",
      oauthStateSecret: SECRET,
    }),
    account({ phone: null }),
  );
  assert.equal(sent.length, 0);
});
