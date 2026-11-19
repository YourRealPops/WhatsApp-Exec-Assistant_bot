import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hashPayload, type Db, type EventReference, type Proposal } from "@exec-assistant/db";
import { encryptToken } from "@exec-assistant/calendar";
import { proposeEventCancellation, proposeEventChange } from "./proposals.js";
import type { GoogleConfig } from "./calendar-access.js";

const UID = "6f1d5a3c-2b7e-4f5a-9c8d-0a1b2c3d4e5f";
const TOKEN_KEY = Buffer.alloc(32, 9);
const GOOGLE: GoogleConfig = {
  clientId: "id",
  clientSecret: "secret",
  tokenKey: TOKEN_KEY,
};

/** 21:00 Lagos (Future Africa) and 22:30 Lagos (L2E) on 19 Nov 2026. */
const EVENTS = [
  {
    id: "evt-future-africa",
    summary: "Future Africa meeting",
    start: { dateTime: "2026-11-19T21:00:00+01:00", timeZone: "Africa/Lagos" },
    end: { dateTime: "2026-11-19T22:00:00+01:00", timeZone: "Africa/Lagos" },
    etag: '"etag-fa"',
    organizer: { self: true },
    status: "confirmed",
  },
  {
    id: "evt-l2e",
    summary: "L2E meeting",
    start: { dateTime: "2026-11-19T22:30:00+01:00", timeZone: "Africa/Lagos" },
    end: { dateTime: "2026-11-19T23:30:00+01:00", timeZone: "Africa/Lagos" },
    etag: '"etag-l2e"',
    organizer: { self: true },
    status: "confirmed",
  },
];

interface ReferenceSeed {
  position: number;
  external_id: string;
  title: string;
  start_at: Date;
  end_at: Date;
  focused_at?: Date | null;
}

/**
 * Structural stand-in for the database: the queries these two proposal
 * functions run, backed by in-memory arrays. Anything unexpected returns [].
 */
function makeFakeDb(references: ReferenceSeed[] = []) {
  const proposals: Proposal[] = [];
  const refs: EventReference[] = references.map((seed) => ({
    id: randomUUID(),
    user_id: UID,
    listed_at: new Date(),
    focused_at: null,
    ...seed,
  }));
  const account = {
    id: randomUUID(),
    user_id: UID,
    provider: "google",
    access_token: encryptToken("access-token", TOKEN_KEY),
    refresh_token: null,
    expires_at: null,
    calendar_id: "primary",
    synced_at: null,
    account_email: null,
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    connected_at: new Date(),
    last_sync_error: null,
    reauth_required_at: null,
    created_at: new Date(),
    timezone: "Africa/Lagos",
  };

  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ");
    if (text.includes("from calendar_accounts where user_id")) {
      return Promise.resolve([account]);
    }
    if (text.includes("from event_references")) {
      return Promise.resolve([...refs].sort((a, b) => a.position - b.position));
    }
    if (text.includes("update event_references")) {
      const externalId = values[1] as string;
      for (const ref of refs) {
        if (ref.external_id === externalId) ref.focused_at = new Date();
      }
      return Promise.resolve([]);
    }
    if (text.includes("from events")) {
      return Promise.resolve([]);
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
    return Promise.resolve([]);
  }) as unknown as Db;
  (db as unknown as { json: (value: unknown) => unknown }).json = (value) => value;

  return { db, proposals, refs };
}

/** A Google API stand-in: list returns the events, a single GET filters by id. */
function makeGoogle(items: Record<string, unknown>[] = EVENTS) {
  const calls: string[] = [];
  const fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    const single = /\/events\/([^/?#]+)/.exec(url);
    if (single) {
      const id = decodeURIComponent(single[1]);
      const item = items.find((candidate) => candidate.id === id);
      if (!item) {
        return new Response(JSON.stringify({ error: { message: "Not Found" } }), {
          status: 404,
        });
      }
      return new Response(JSON.stringify(item), { status: 200 });
    }
    return new Response(JSON.stringify({ items }), { status: 200 });
  };
  return { fetch, calls };
}

const NOW = new Date("2026-11-19T12:00:00Z");

function context(db: Db) {
  return {
    db,
    userId: UID,
    timezone: "Africa/Lagos",
    google: GOOGLE,
    approvalTtlMinutes: 15,
    now: NOW,
  };
}

function withFetch(t: { after: (fn: () => void) => void }, stub: { fetch: unknown }) {
  const realFetch = globalThis.fetch;
  (globalThis.fetch as unknown) = stub.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
}

const LISTED: ReferenceSeed[] = [
  {
    position: 1,
    external_id: "evt-future-africa",
    title: "Future Africa meeting",
    start_at: new Date("2026-11-19T20:00:00Z"),
    end_at: new Date("2026-11-19T21:00:00Z"),
  },
  {
    position: 2,
    external_id: "evt-l2e",
    title: "L2E meeting",
    start_at: new Date("2026-11-19T21:30:00Z"),
    end_at: new Date("2026-11-19T22:30:00Z"),
  },
];

test("a cancellation by exact title proposes that event", async (t) => {
  const { db, proposals } = makeFakeDb(LISTED);
  withFetch(t, makeGoogle());
  const result = await proposeEventCancellation(context(db), {
    event: "Future Africa meeting",
  });
  assert.match(result.message, /Future Africa meeting/);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, "cancellation");
  assert.equal(proposals[0].payload.eventId, "evt-future-africa");
  assert.equal(proposals[0].payload_hash, hashPayload(proposals[0].payload));
});

test("a cancellation by unique partial title proposes that event", async (t) => {
  const { db, proposals } = makeFakeDb(LISTED);
  withFetch(t, makeGoogle());
  await proposeEventCancellation(context(db), { event: "L2e" });
  assert.equal(proposals[0].payload.eventId, "evt-l2e");
});

test("a cancellation by time uses the last listing", async (t) => {
  const { db, proposals } = makeFakeDb(LISTED);
  withFetch(t, makeGoogle());
  const result = await proposeEventCancellation(context(db), {
    event: "",
    time: "9 PM",
  });
  assert.match(result.message, /Future Africa meeting/);
  assert.equal(proposals[0].payload.eventId, "evt-future-africa");
});

test("a cancellation using the displayed description strips its noise", async (t) => {
  const { db, proposals } = makeFakeDb(LISTED);
  withFetch(t, makeGoogle());
  await proposeEventCancellation(context(db), {
    event: "21:00 Future Africa meeting (22:00 UTC)",
  });
  assert.equal(proposals[0].payload.eventId, "evt-future-africa");
});

test("an ordinal refers to the last listing, not to search order", async (t) => {
  const { db, proposals } = makeFakeDb(LISTED);
  withFetch(t, makeGoogle());
  await proposeEventCancellation(context(db), { event: "", ordinal: 2 });
  assert.equal(proposals[0].payload.eventId, "evt-l2e");
});

test("a pronoun uses the focused event from the conversation", async (t) => {
  const { db, proposals } = makeFakeDb([
    { ...LISTED[0], focused_at: new Date("2026-11-19T11:55:00Z") },
    LISTED[1],
  ]);
  withFetch(t, makeGoogle());
  const result = await proposeEventChange(context(db), {
    event: "it",
    start: "4 PM",
  });
  assert.match(result.message, /Future Africa meeting/);
  assert.equal(proposals[0].payload.eventId, "evt-future-africa");
});

test("multiple matching events ask instead of changing anything", async (t) => {
  const { db, proposals } = makeFakeDb(LISTED);
  const duplicate = {
    ...EVENTS[0],
    id: "evt-future-africa-2",
    summary: "Future Africa meeting",
    start: { dateTime: "2026-11-21T21:00:00+01:00", timeZone: "Africa/Lagos" },
    end: { dateTime: "2026-11-21T22:00:00+01:00", timeZone: "Africa/Lagos" },
  };
  const google = makeGoogle([...EVENTS, duplicate]);
  withFetch(t, google);
  await assert.rejects(
    proposeEventCancellation(context(db), { event: "Future Africa" }),
    /matches 2 events/i,
  );
  // Nothing stored, and no write was attempted: only reads.
  assert.equal(proposals.length, 0);
  assert.ok(google.calls.every((call) => call.startsWith("GET ")));
});

test("an unknown event is refused without a proposal", async (t) => {
  const { db, proposals } = makeFakeDb(LISTED);
  withFetch(t, makeGoogle());
  await assert.rejects(
    proposeEventCancellation(context(db), { event: "budget review" }),
    /couldn't find an event/i,
  );
  assert.equal(proposals.length, 0);
});

test("'10 AM tomorrow' resolves in Africa/Lagos, not UTC", async (t) => {
  const { db, proposals } = makeFakeDb(LISTED);
  withFetch(t, makeGoogle());
  const result = await proposeEventChange(context(db), {
    event: "L2E meeting",
    start: "10 AM tomorrow",
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].payload.after?.start, "2026-11-20T09:00:00.000Z");
  assert.equal(proposals[0].payload.after?.end, "2026-11-20T10:00:00.000Z");
  assert.equal(proposals[0].payload.timezone, "Africa/Lagos");
  // The confirmation is local and offset-labeled; it never shows a UTC time.
  assert.match(result.message, /New: .*10:00.+\+01:00/);
  assert.doesNotMatch(result.message, /\bUTC\b/);
});

test("a day-only move keeps the event's clock time", async (t) => {
  const { db, proposals } = makeFakeDb(LISTED);
  withFetch(t, makeGoogle());
  await proposeEventChange(context(db), {
    event: "",
    ordinal: 2,
    start: "tomorrow",
  });
  // L2E ran 22:30–23:30 Lagos, so tomorrow keeps that time of day.
  assert.equal(proposals[0].payload.after?.start, "2026-11-20T21:30:00.000Z");
  assert.equal(proposals[0].payload.after?.end, "2026-11-20T22:30:00.000Z");
});
