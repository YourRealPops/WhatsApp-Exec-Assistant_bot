import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  addDaysToDateStr,
  parseWhen,
  todayInTz,
  encryptToken,
} from "@exec-assistant/calendar";
import type { Db, Proposal } from "@exec-assistant/db";
import type { Button, Sender } from "@exec-assistant/whatsapp";
import { proposalButtons, handleUserText, type PipelineDeps } from "./pipeline.js";

const UID = "6f1d5a3c-2b7e-4f5a-9c8d-0a1b2c3d4e5f";
const PHONE = "+2348012345678";
const LAGOS = "Africa/Lagos";
const TOKEN_KEY = Buffer.alloc(32, 5);
const GOOGLE = { clientId: "id", clientSecret: "secret", tokenKey: TOKEN_KEY };

/** Two upcoming Lagos-time events, so the test never depends on the clock. */
const tomorrow = addDaysToDateStr(todayInTz(LAGOS), 1);
const FUTURE_AFRICA_START = parseWhen(`${tomorrow}T21:00`, LAGOS);
const FUTURE_AFRICA_END = parseWhen(`${tomorrow}T22:00`, LAGOS);
const L2E_START = parseWhen(`${tomorrow}T22:30`, LAGOS);
const L2E_END = parseWhen(`${tomorrow}T23:30`, LAGOS);

/**
 * A Db stand-in for a whole pipeline turn: history, proposals, the Google
 * account row, listing context and the local event copy. It records writes so
 * "nothing changed before approval" is observable rather than assumed.
 */
function makeDb() {
  const messages: Array<{
    id: string;
    user_id: string;
    direction: "inbound" | "outbound";
    body: string;
    channel: string;
    created_at: Date;
  }> = [];
  const proposals: Proposal[] = [];
  const references: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const user = {
    id: UID,
    phone: PHONE,
    name: "Ada",
    designation: "CTO",
    timezone: LAGOS,
    created_at: new Date(),
  };
  const account = {
    id: randomUUID(),
    user_id: UID,
    provider: "google",
    access_token: encryptToken("access-token", TOKEN_KEY),
    refresh_token: null,
    expires_at: null,
    calendar_id: "primary",
    synced_at: null,
    account_email: "ada@example.com",
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    connected_at: new Date(),
    last_sync_error: null,
    reauth_required_at: null,
    created_at: new Date(),
    timezone: LAGOS,
  };

  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ");

    if (text.includes("insert into messages")) {
      messages.push({
        id: String(values[0]),
        user_id: String(values[1]),
        direction: values[2] as "inbound" | "outbound",
        body: String(values[3]),
        channel: "whatsapp",
        created_at: new Date(),
      });
      return Promise.resolve([{ id: values[0] }]);
    }
    if (text.includes("from messages")) {
      return Promise.resolve([...messages].reverse());
    }
    if (text.includes("from users")) return Promise.resolve([user]);
    if (text.includes("from calendar_accounts where user_id")) {
      return Promise.resolve([account]);
    }
    if (text.includes("from event_references")) {
      return Promise.resolve(
        [...references].sort(
          (a, b) => Number(a.position) - Number(b.position),
        ),
      );
    }
    if (text.includes("update event_references")) {
      for (const ref of references) {
        if (ref.external_id === values[1]) ref.focused_at = new Date();
      }
      return Promise.resolve([]);
    }
    if (text.includes("from events")) {
      return Promise.resolve(events);
    }
    if (text.includes("insert into proposals")) {
      const row: Proposal = {
        id: randomUUID(),
        user_id: values[0] as string,
        kind: (values[1] as string) ?? "reschedule",
        payload:
          typeof values[2] === "string"
            ? JSON.parse(values[2] as string)
            : (values[2] as Proposal["payload"]),
        payload_hash: values[3] as string,
        status: "pending",
        expires_at: values[4] as Date,
        created_at: new Date(),
        decided_at: null,
        executed_at: null,
        provider_result: null,
        error: null,
      };
      proposals.push(row);
      return Promise.resolve([row]);
    }
    if (text.includes("select * from proposals where id =")) {
      return Promise.resolve([
        proposals.find((p) => p.id === values[0]) ?? null,
      ]);
    }
    if (
      text.includes("select * from proposals where user_id") &&
      text.includes("status = 'pending'")
    ) {
      const now = values[1] as Date;
      return Promise.resolve(
        proposals
          .filter(
            (p) =>
              p.user_id === values[0] && p.status === "pending" && p.expires_at > now,
          )
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime()),
      );
    }
    if (text.includes("update proposals set status = 'executing'")) {
      const p = proposals.find((x) => x.id === values[0]);
      if (
        !p ||
        p.user_id !== values[1] ||
        p.status !== "pending" ||
        p.expires_at <= (values[2] as Date)
      ) {
        return Promise.resolve([]);
      }
      p.status = "executing";
      return Promise.resolve([p]);
    }
    if (text.includes("update proposals set status = 'rejected'")) {
      const p = proposals.find((x) => x.id === values[0]);
      if (!p || p.user_id !== values[1] || p.status !== "pending") {
        return Promise.resolve([]);
      }
      p.status = "rejected";
      return Promise.resolve([p]);
    }
    if (text.includes("update proposals set status = 'expired'")) {
      const p = proposals.find((x) => x.id === values[0]);
      if (!p || p.status !== "pending") return Promise.resolve([]);
      p.status = "expired";
      return Promise.resolve([p]);
    }
    if (text.includes("update proposals set status = ")) {
      const p = proposals.find((x) => x.id === values[3]);
      if (p && p.status === "executing") {
        p.status = values[0] as Proposal["status"];
        p.provider_result = (values[1] as Record<string, unknown> | null) ?? null;
        p.error = (values[2] as string | null) ?? null;
      }
      return Promise.resolve([]);
    }
    if (text.includes("insert into events")) {
      const row = {
        id: randomUUID(),
        user_id: values[0],
        external_id: values[1],
        title: values[2],
        start_at: values[3],
        end_at: values[4],
        all_day: values[5],
        location: values[6],
        description: values[7],
        status: values[8],
        updated_at: new Date(),
      };
      events.push(row);
      return Promise.resolve([row]);
    }
    return Promise.resolve([]);
  }) as unknown as Db;
  (db as unknown as { json: (value: unknown) => unknown }).json = (value) => value;

  return { db, messages, proposals, references, events, user };
}

interface EventItem {
  id: string;
  summary: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  etag: string;
  organizer: { self: boolean };
  status: string;
}

/** A mutable Google calendar: PATCH moves the stored event, GET reads it back. */
function makeGoogle() {
  const items: EventItem[] = [
    {
      id: "evt-future-africa",
      summary: "Future Africa meeting",
      start: { dateTime: FUTURE_AFRICA_START.toISOString(), timeZone: LAGOS },
      end: { dateTime: FUTURE_AFRICA_END.toISOString(), timeZone: LAGOS },
      etag: '"etag-fa"',
      organizer: { self: true },
      status: "confirmed",
    },
    {
      id: "evt-l2e",
      summary: "L2E meeting",
      start: { dateTime: L2E_START.toISOString(), timeZone: LAGOS },
      end: { dateTime: L2E_END.toISOString(), timeZone: LAGOS },
      etag: '"etag-l2e"',
      organizer: { self: true },
      status: "confirmed",
    },
  ];
  const writes: string[] = [];

  const fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const single = /\/events\/([^/?#]+)/.exec(url);
    if (method !== "GET") writes.push(method);
    if (!single) {
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    const item = items.find((c) => c.id === decodeURIComponent(single[1]));
    if (!item) {
      return new Response(JSON.stringify({ error: { message: "Not Found" } }), {
        status: 404,
      });
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        start?: { dateTime?: string };
        end?: { dateTime?: string };
      };
      if (body.start?.dateTime) item.start = { ...item.start, dateTime: body.start.dateTime };
      if (body.end?.dateTime) item.end = { ...item.end, dateTime: body.end.dateTime };
    }
    if (method === "DELETE") {
      items.splice(items.indexOf(item), 1);
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(item), { status: 200 });
  };

  return { fetch, writes, items };
}

function makeSender() {
  const texts: string[] = [];
  const buttonSends: Array<{ text: string; buttons: Button[] }> = [];
  const sender: Sender = {
    kind: "test",
    async sendText(_to, text) {
      texts.push(text);
      return `t:${texts.length}`;
    },
    async sendButtons(_to, text, buttons) {
      buttonSends.push({ text, buttons });
      return `b:${buttonSends.length}`;
    },
    async sendTemplate() {
      return "template";
    },
  };
  return { sender, texts, buttonSends };
}

function withFetch(t: { after: (fn: () => void) => void }, stub: { fetch: unknown }) {
  const realFetch = globalThis.fetch;
  (globalThis.fetch as unknown) = stub.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
}

test("a compound request sends one button pair per proposal and changes nothing yet", async (t) => {
  const { db, messages, proposals, references, user } = makeDb();
  // Existing user with history: no first-contact greeting.
  user.name = "Ada";
  messages.push(
    {
      id: "wamid.old1",
      user_id: UID,
      direction: "inbound",
      body: "what's on tomorrow?",
      channel: "whatsapp",
      created_at: new Date(Date.now() - 60_000),
    },
    {
      id: "out:old1",
      user_id: UID,
      direction: "outbound",
      body: "- 21:00 Future Africa meeting\n- 22:30 L2E meeting",
      channel: "whatsapp",
      created_at: new Date(Date.now() - 59_000),
    },
  );
  references.push(
    {
      position: 1,
      external_id: "evt-future-africa",
      title: "Future Africa meeting",
      start_at: FUTURE_AFRICA_START,
      end_at: FUTURE_AFRICA_END,
      listed_at: new Date(),
      focused_at: null,
    },
    {
      position: 2,
      external_id: "evt-l2e",
      title: "L2E meeting",
      start_at: L2E_START,
      end_at: L2E_END,
      listed_at: new Date(),
      focused_at: null,
    },
  );

  const google = makeGoogle();
  withFetch(t, google);
  const { sender, buttonSends } = makeSender();
  const deps: PipelineDeps = {
    db,
    sender,
    llm: null,
    devCalendar: false,
    defaultTimezone: LAGOS,
    google: GOOGLE,
    approvalTtlMinutes: 15,
  };

  const first = await handleUserText(deps, {
    userId: UID,
    phone: PHONE,
    text: "Cancel Future Africa meeting and move L2E meeting to 10 AM tomorrow.",
  });

  // Two proposals, two distinct button pairs.
  assert.equal(proposals.length, 2);
  assert.equal(buttonSends.length, 2);
  const cancellation = proposals.find((p) => p.kind === "cancellation");
  const reschedule = proposals.find((p) => p.kind === "reschedule");
  assert.ok(cancellation);
  assert.ok(reschedule);
  assert.equal(cancellation.payload.eventId, "evt-future-africa");
  assert.equal(reschedule.payload.eventId, "evt-l2e");
  assert.equal(reschedule.payload.after?.start, "2026-11-20T09:00:00.000Z".replace("2026-11-20", tomorrow));

  const sentIds = buttonSends.flatMap((send) => send.buttons.map((b) => b.id));
  assert.deepEqual(
    sentIds.sort(),
    [
      `appr:${cancellation.id}`,
      `rej:${cancellation.id}`,
      `appr:${reschedule.id}`,
      `rej:${reschedule.id}`,
    ].sort(),
  );
  for (const send of buttonSends) {
    assert.deepEqual(
      send.buttons.map((b) => b.title),
      ["Approve", "Reject"],
    );
  }
  // Each message names its own event, so the buttons are never confused.
  const cancelMessage = buttonSends.find((s) => s.text.includes("cancellation"));
  assert.ok(cancelMessage);
  assert.match(cancelMessage.text, /Future Africa meeting/);
  assert.doesNotMatch(cancelMessage.text, /L2E meeting/);
  const moveMessage = buttonSends.find((s) => s.text.includes("Proposed change"));
  assert.ok(moveMessage);
  assert.match(moveMessage.text, /L2E meeting/);
  assert.doesNotMatch(moveMessage.text, /Future Africa meeting/);

  // Nothing was written to the calendar before approval.
  assert.deepEqual(google.writes, []);
  assert.ok(proposals.every((p) => p.status === "pending"));
  assert.match(first.reply, /Proposed/);

  // Typed "yes" with two pending proposals must not guess.
  const ambiguous = await handleUserText(deps, {
    userId: UID,
    phone: PHONE,
    text: "yes",
  });
  assert.match(ambiguous.reply, /2 changes waiting|won't guess|Tap Approve/i);
  assert.deepEqual(google.writes, []);
  assert.ok(proposals.every((p) => p.status === "pending"));

  // Approve the move only — the cancellation must stay pending.
  const approved = await handleUserText(deps, {
    userId: UID,
    phone: PHONE,
    text: "Approve",
    replyId: `appr:${reschedule.id}`,
  });
  assert.match(approved.reply, /Done/i);
  assert.equal(reschedule.status, "succeeded");
  assert.equal(cancellation.status, "pending");
  assert.deepEqual(google.writes, ["PATCH"]);
  assert.equal(
    google.items.find((i) => i.id === "evt-future-africa")?.status,
    "confirmed",
    "the other event was not touched",
  );

  // A repeated tap never replays the move.
  const again = await handleUserText(deps, {
    userId: UID,
    phone: PHONE,
    text: "Approve",
    replyId: `appr:${reschedule.id}`,
  });
  assert.match(again.reply, /already applied|no longer pending/i);
  assert.deepEqual(google.writes, ["PATCH"]);

  // Reject the cancellation explicitly — the move stays done.
  const rejected = await handleUserText(deps, {
    userId: UID,
    phone: PHONE,
    text: "Reject",
    replyId: `rej:${cancellation.id}`,
  });
  assert.match(rejected.reply, /nothing was changed/i);
  assert.equal(cancellation.status, "rejected");
  assert.equal(reschedule.status, "succeeded");
  assert.deepEqual(google.writes, ["PATCH"]);
});

test("button payloads are bound to one proposal id, with plain labels", () => {
  const id = "9a7c1f0e-1c2b-4d3e-8f90-123456789abc";
  assert.deepEqual(proposalButtons(id), [
    { id: `appr:${id}`, title: "Approve" },
    { id: `rej:${id}`, title: "Reject" },
  ]);
  // Different proposals never share a payload.
  assert.notEqual(
    proposalButtons(id)[0].id,
    proposalButtons("11111111-2222-4333-8444-555555555555")[0].id,
  );
});
