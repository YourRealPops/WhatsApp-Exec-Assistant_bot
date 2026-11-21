import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloudApiSender } from "./sender.js";

interface Captured {
  url: string;
  init: RequestInit;
}

function stubFetch(
  t: { after: (fn: () => void) => void },
  body: unknown = { messages: [{ id: "wamid.out" }] },
): Captured[] {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url: string }).url);
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function sender() {
  return createCloudApiSender({
    accessToken: "token",
    phoneNumberId: "phone-id",
    apiVersion: "v21.0",
  });
}

test("the typing indicator marks the inbound message read, tied to its wamid", async (t) => {
  const calls = stubFetch(t, { success: true });
  await sender().sendTypingIndicator!("wamid.inbound.1");

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://graph.facebook.com/v21.0/phone-id/messages",
  );
  const payload = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(payload, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: "wamid.inbound.1",
    typing_indicator: { type: "text" },
  });
});

test("media upload posts multipart form data to the media endpoint", async (t) => {
  const calls = stubFetch(t, { id: "media-123" });
  const mediaId = await sender().uploadMedia!({
    data: Buffer.from("%PDF-1.4 test"),
    mimeType: "application/pdf",
    filename: "summary.pdf",
  });

  assert.equal(mediaId, "media-123");
  assert.equal(
    calls[0].url,
    "https://graph.facebook.com/v21.0/phone-id/media",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.ok(calls[0].init.body instanceof FormData);
});

test("a document message is sent only with an uploaded media id", async (t) => {
  const calls = stubFetch(t, { messages: [{ id: "wamid.doc" }] });
  const messageId = await sender().sendDocument!(
    "+2348012345678",
    "media-123",
    "summary.pdf",
    "Calendar summary",
  );

  assert.equal(messageId, "wamid.doc");
  const payload = JSON.parse(String(calls[0].init.body));
  assert.equal(payload.type, "document");
  assert.equal(payload.to, "+2348012345678");
  assert.deepEqual(payload.document, {
    id: "media-123",
    filename: "summary.pdf",
    caption: "Calendar summary",
  });
});

test("a rejected upload surfaces the WhatsApp error code", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ error: { code: 131047, message: "Re-engagement required" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  await assert.rejects(
    sender().uploadMedia!({
      data: Buffer.from("x"),
      mimeType: "application/pdf",
      filename: "x.pdf",
    }),
    /131047/,
  );
});
