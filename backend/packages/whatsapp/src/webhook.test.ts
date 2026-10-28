import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInboundMessages, verifyHandshake } from "./webhook.js";

const payload = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "1029384756",
      changes: [
        {
          field: "messages",
          value: {
            metadata: {
              display_phone_number: "15550001111",
              phone_number_id: "222333444",
            },
            contacts: [{ profile: { name: "Ada" }, wa_id: "15551234567" }],
            messages: [
              {
                from: "15551234567",
                id: "wamid.AAA1",
                timestamp: "1730000000",
                type: "text",
                text: { body: "what's on my calendar today?" },
              },
              {
                from: "15551234567",
                id: "wamid.AAA2",
                timestamp: "1730000005",
                type: "image",
                image: { id: "media123", mime_type: "image/jpeg" },
              },
              {
                from: "15551234567",
                id: "wamid.AAA3",
                timestamp: "1730000009",
                type: "interactive",
                interactive: {
                  button_reply: { id: "yes", title: "Yes, remind me" },
                },
              },
            ],
          },
        },
      ],
    },
  ],
};

test("extracts text, button and interactive messages", () => {
  const messages = parseInboundMessages(payload);
  assert.equal(messages.length, 3);

  const [text, image, interactive] = messages;
  assert.deepEqual(
    { id: text.id, from: text.from, type: text.type, text: text.text },
    { id: "wamid.AAA1", from: "15551234567", type: "text", text: "what's on my calendar today?" },
  );
  assert.equal(text.timestamp.getTime(), 1_730_000_000_000);
  assert.equal(image.text, null, "media carries no text body");
  assert.equal(interactive.text, "Yes, remind me");
});

test("is idempotent-safe: message ids are preserved for dedupe", () => {
  const first = parseInboundMessages(payload);
  const second = parseInboundMessages(payload);
  assert.deepEqual(
    first.map((m) => m.id),
    second.map((m) => m.id),
  );
});

test("never throws on malformed payloads", () => {
  assert.deepEqual(parseInboundMessages(null), []);
  assert.deepEqual(parseInboundMessages("nope"), []);
  assert.deepEqual(parseInboundMessages({}), []);
  assert.deepEqual(parseInboundMessages({ entry: [{ changes: [{ value: {} }] }] }), []);
  assert.deepEqual(
    parseInboundMessages({ entry: [{ changes: [{ value: { messages: [{ id: 5 }] } }] }] }),
    [],
  );
});

test("verify handshake checks mode + token", () => {
  const token = "verify_me";
  assert.equal(
    verifyHandshake(
      { "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "12345" },
      token,
    ),
    true,
  );
  assert.equal(verifyHandshake({ "hub.mode": "unsubscribe", "hub.verify_token": token }, token), false);
  assert.equal(verifyHandshake({ "hub.mode": "subscribe", "hub.verify_token": "wrong" }, token), false);
  assert.equal(verifyHandshake({ "hub.mode": "subscribe" }, ""), false);
});
