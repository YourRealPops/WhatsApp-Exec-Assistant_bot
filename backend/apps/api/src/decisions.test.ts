import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getProposal,
  listPendingProposals,
  createProposal,
  claimProposal,
  rejectProposal,
  failProposal,
  expireProposal,
  finishProposal,
  logProposalEvent,
  upsertEvents,
  materializeReminders,
  hashPayload,
  type Proposal,
  type CalEvent,
  type Db,
} from "@exec-assistant/db";
import {
  CalendarAuthError,
  EventConflictError,
  TransientCalendarError,
  GoogleEventDetail,
  mapGoogleEventDetail,
} from "@exec-assistant/calendar";
import { handleDecision, parseDecision } from "./decisions.js";

const SECRET = "s".repeat(32);
const UID = "6f1d5a3c-2b7e-4f5a-9c8d-0a1b2c3d4e5f";
const OTHER_UID = "2b7e4f5a-9c8d-0a1b-2c3d-4e5f6a7b8c9d";

/**
 * A structural stand-in for `postgres` (the `Db` type alias) that records
 * every statement. Only the queries `handleDecision` performs are handled;
 * anything else returns [] or null so a wrong call fails immediately.
 */
function makeFakeDb() {
  const proposals: Proposal[] = [];
  const calendarAccounts: Record<string, unknown>[] = [];
  const events: CalEvent[] = [];
  const localEvents: { id: string; userId: string; startAt: Date; allDay: boolean }[] = [];

  function findProposalById(id: string): Proposal | undefined {
    return proposals.find((p) => p.id === id);
  }

  const db = ((sql: TemplateStringsArray, ...values: unknown[]) => {
    const text = sql.join("?");
    const v = values.map((x) =>
      typeof x === "bigint" ? x.toString() : x ?? null,
    ) as unknown[];

    if (text.includes("select * from proposals where id = ")) {
      const id = v[0] as string;
      return Promise.resolve([findProposalById(id) ?? null]);
    }
    if (
      text.includes("select * from proposals where user_id") &&
      text.includes("and status = 'pending'")
    ) {
      const userId = v[0] as string;
      const now = v[1] as Date;
      return Promise.resolve(
        proposals
          .filter((p) => p.user_id === userId && p.status === "pending" && p.expires_at > now)
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime()),
      );
    }
    if (text.includes("update proposals set status = 'executing'")) {
      const id = v[0] as string;
      const userId = v[1] as string;
      const now = v[2] as Date;
      const p = findProposalById(id);
      if (!p || p.user_id !== userId || p.status !== "pending" || p.expires_at <= now) return Promise.resolve([]);
      p.status = "executing";
      p.decided_at = now;
      return Promise.resolve([p]);
    }
    if (text.includes("update proposals set status = 'rejected'")) {
      const id = v[0] as string;
      const userId = v[1] as string;
      const now = v[2] as Date;
      const p = findProposalById(id);
      if (!p || p.user_id !== userId || p.status !== "pending" || p.expires_at <= now) return Promise.resolve([]);
      p.status = "rejected";
      p.decided_at = now;
      return Promise.resolve([p]);
    }
    if (text.includes("update proposals set status = 'failed'")) {
      const id = v[0] as string;
      const p = proposals.find((x) => x.id === id);
      if (!p) return Promise.resolve([]);
      if (p.status === "pending") p.status = "failed";
      if (p.status === "executing") p.status = "failed";
      return Promise.resolve([]);
    }
    if (text.includes("update proposals set status = 'expired'")) {
      const id = v[0] as string;
      const p = findProposalById(id);
      if (!p || p.status !== "pending") return Promise.resolve([]);
      p.status = "expired";
      p.decided_at = v[1] as Date;
      return Promise.resolve([p]);
    }
    if (text.includes("update proposals set status = ")) {
      // finishProposal / other updates.
      const id = v[0] as string;
      const p = findProposalById(id);
      if (p && text.includes("status = 'succeeded'")) p.status = "succeeded";
      if (p && text.includes("status = 'failed'")) p.status = "failed";
      return Promise.resolve([]);
    }
    if (text.includes("insert into proposals")) {
      const row = {
        id: v[0] as string,
        user_id: v[1] as string,
        kind: v[2] as string,
        payload: v[3] as unknown,
        payload_hash: v[4] as string,
        status: "pending" as const,
        expires_at: v[5] as Date,
        created_at: new Date(),
        decided_at: null,
        executed_at: null,
        provider_result: null,
        error: null,
      };
      proposals.push(row as Proposal);
      return Promise.resolve([row]);
    }
    if (text.includes("select * from user")) {
      const userId = v[0] as string;
      return Promise.resolve(calendarAccounts.filter((a) => a.user_id === userId));
    }
    if (text.includes("from calendar_accounts where user_id")) {
      const userId = v[0] as string;
      return Promise.resolve(calendarAccounts.filter((a) => a.user_id === userId));
    }
    if (text.includes("insert into calendar_accounts")) {
      const row = {
        id: v[0] as string,
        user_id: v[1] as string,
        provider: v[2] as string,
        access_token: v[3] as string,
        refresh_token: v[4] as string | null,
        expires_at: null,
        calendar_id: v[5] as string,
        synced_at: null,
        account_email: null,
        scopes: [],
        connected_at: null,
        last_sync_error: null,
        reauth_required_at: null,
        created_at: new Date(),
      };
      calendarAccounts.push(row);
      return Promise.resolve([row]);
    }
    if (text.includes("select * from events")) {
      const userId = v[0] as string;
      return Promise.resolve(events.filter((e) => e.user_id === userId));
    }
    if (text.includes("insert into events")) {
      const row: CalEvent = {
        id: v[0] as string,
        user_id: v[1] as string,
        external_id: v[2] as string,
        title: v[3] as string,
        start_at: v[4] as Date,
        end_at: v[5] as Date,
        location: v[6] as string | null,
        description: v[7] as string | null,
        status: v[8] as string,
        all_day: !!v[9],
        updated_at: new Date(),
      };
      events.push(row);
      return Promise.resolve([row]);
    }
    if (text.includes("upsertEvents")) {
      return Promise.resolve([]);
    }
    if (text.includes("materializeReminders")) {
      return Promise.resolve([0]);
    }
    if (text.includes("insert into proposal_events")) {
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Db;

  return { db, proposals, calendarAccounts, events };
}

/**
 * A fake Google API responding to a PATCH then a GET on one event.
 */
interface GoogleStub {
  fetch: (input: unknown, init?: RequestInit) => Promise<Response>;
  patchResult: (status: number, body: unknown) => void;
  getResult: (status: number, body: unknown) => void;
  events: Map<string, Record<string, unknown>>;
  _patch?: { status: number; body: unknown };
  _get?: { status: number; body: unknown };
}

function makeGoogleStub() {
  const s = {
    fetch: async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const eventId = url.match(/\/events\/([^/?#]+)/)?.[1];
      if (!eventId) throw new Error(`unexpected google url: ${url}`);
      if (method === "PATCH") {
        const res = s.patchResult;
        return new Response(JSON.stringify(res), { status: 200 });
      }
      const res = s.getResult;
      return new Response(JSON.stringify(res), { status: 200 });
    },
    patchResult: (status: number, body: unknown) => {
      s._patch = { status, body };
    },
    getResult: (status: number, body: unknown) => {
      s._get = { status, body };
    },
  } as unknown as GoogleStub;
  s._patch = { status: 200, body: {} };
  s._get = { status: 200, body: {} };
  return s;
}

function patchDetail(body: Record<string, unknown>): GoogleEventDetail {
  return mapGoogleEventDetail({
    id: body.id ?? "evt-1",
    summary: body.summary ?? "Board review",
    start: { dateTime: body.start ?? body.after_start ?? "", timeZone: body.timezone ?? "UTC" },
    end: { dateTime: body.end ?? body.after_end ?? "", timeZone: body.timezone ?? "UTC" },
    etag: body.etag ?? "\"abc123\"",
    attendees: body.attendees ?? 0,
    organizer: { self: true },
    guestsCanModify: false,
    status: "confirmed",
  } as Record<string, unknown>, "UTC") as GoogleEventDetail;
}

test("parseDecision routes accept into approve", () => {
  assert.equal(parseDecision("ok", null)?.action, "approve");
  assert.equal(parseDecision("yes", null)?.action, "approve");
  assert.equal(parseDecision("appr:abcd-1234-5678", "appr:abcd-1234-5678")?.action, "approve");
});

test("parseDecision routes refuse into reject", () => {
  assert.equal(parseDecision("no", null)?.action, "reject");
  assert.equal(parseDecision("reject", null)?.action, "reject");
  assert.equal(parseDecision("rej:abcd-1234-5678", "rej:abcd-1234-5678")?.action, "reject");
});

test("reject taps flip a pending proposal to rejected", async () => {
  const { db } = makeFakeDb();
  const payload = {
    eventId: "evt-1",
    calendarId: "primary",
    title: "Board review",
    before: { start: "2026-10-25T09:00:00+01:00", end: "2026-10-25T10:00:00+01:00" },
    after: { start: "2026-10-26T09:00:00+01:00", end: "2026-10-26T10:00:00+01:00" },
    etag: null,
    timezone: "Europe/London",
    attendees: 0,
    sendUpdates: "all" as const,
  };
  const proposal = await createProposal(db, {
    userId: UID,
    kind: "reschedule",
    payload,
    payloadHash: hashPayload(payload),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const result = await handleDecision(
    { db: db as unknown as Db, google: null as any, now: () => new Date() },
    { userId: UID, text: "no", replyId: `rej:${proposal.id}` },
  );
  assert.ok(result);
  assert.equal(result.mode, "decision");
  assert.match(result.reply, /Cancelled/);
  assert.equal((await getProposal(db as unknown as Db, proposal.id))!.status, "rejected");
});

test("approving an expired proposal flips it to expired", async () => {
  const { db } = makeFakeDb();
  const payload = {
    eventId: "evt-1",
    calendarId: "primary",
    title: "Board review",
    before: { start: "2026-10-25T09:00:00+01:00", end: "2026-10-25T10:00:00+01:00" },
    after: { start: "2026-10-26T09:00:00+01:00", end: "2026-10-26T10:00:00+01:00" },
    etag: null,
    timezone: "Europe/London",
    attendees: 0,
    sendUpdates: "all" as const,
  };
  const proposal = await createProposal(db, {
    userId: UID,
    kind: "reschedule",
    payload,
    payloadHash: hashPayload(payload),
    expiresAt: new Date(Date.now() - 1000),
  });
  const result = await handleDecision(
    { db: db as unknown as Db, google: null as any, now: () => new Date() },
    { userId: UID, text: "ok", replyId: `appr:${proposal.id}` },
  );
  assert.ok(result);
  assert.match(result.reply, /expired/);
  assert.equal((await getProposal(db as unknown as Db, proposal.id))!.status, "expired");
});

test("a proposal whose payload hash no longer matches is refused", async () => {
  const { db } = makeFakeDb();
  const payload = {
    eventId: "evt-1",
    calendarId: "primary",
    title: "Board review",
    before: { start: "2026-10-25T09:00:00+01:00", end: "2026-10-25T10:00:00+01:00" },
    after: { start: "2026-10-26T09:00:00+01:00", end: "2026-10-26T10:00:00+01:00" },
    etag: null,
    timezone: "Europe/London",
    attendees: 0,
    sendUpdates: "all" as const,
  };
  const tampered = { ...payload, before: { start: "2026-10-20T09:00:00+01:00", end: "2026-10-20T10:00:00+01:00" } };
  const proposal = await createProposal(db, {
    userId: UID,
    kind: "reschedule",
    payload,
    payloadHash: hashPayload(tampered),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const result = await handleDecision(
    { db: db as unknown as Db, google: null as any, now: () => new Date() },
    { userId: UID, text: "ok", replyId: `appr:${proposal.id}` },
  );
  assert.ok(result);
  assert.match(result.reply, /refused/i);
  assert.equal((await getProposal(db as unknown as Db, proposal.id))!.status, "failed");
});

test("a second tap on an already-decided proposal is a no-op", async () => {
  const { db } = makeFakeDb();
  const payload = {
    eventId: "evt-1",
    calendarId: "primary",
    title: "Board review",
    before: { start: "2026-10-25T09:00:00+01:00", end: "2026-10-25T10:00:00+01:00" },
    after: { start: "2026-10-26T09:00:00+01:00", end: "2026-10-26T10:00:00+01:00" },
    etag: null,
    timezone: "Europe/London",
    attendees: 0,
    sendUpdates: "all" as const,
  };
  const proposal = await createProposal(db, {
    userId: UID,
    kind: "reschedule",
    payload,
    payloadHash: hashPayload(payload),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  await handleDecision(
    { db: db as unknown as Db, google: null as any, now: () => new Date() },
    { userId: UID, text: "ok", replyId: `appr:${proposal.id}` },
  );
  const second = await handleDecision(
    { db: db as unknown as Db, google: null as any, now: () => new Date() },
    { userId: UID, text: "ok", replyId: `appr:${proposal.id}` },
  );
  assert.ok(second);
  assert.match(second.reply, /already applied/i);
  assert.equal((await getProposal(db as unknown as Db, proposal.id))!.status, "succeeded");
});

test("a tap on a proposal owned by another user is rejected as not theirs", async () => {
  const { db } = makeFakeDb();
  const payload = {
    eventId: "evt-1",
    calendarId: "primary",
    title: "Board review",
    before: { start: "2026-10-25T09:00:00+01:00", end: "2026-10-25T10:00:00+01:00" },
    after: { start: "2026-10-26T09:00:00+01:00", end: "2026-10-26T10:00:00+01:00" },
    etag: null,
    timezone: "Europe/London",
    attendees: 0,
    sendUpdates: "all" as const,
  };
  const proposal = await createProposal(db, {
    userId: UID,
    kind: "reschedule",
    payload,
    payloadHash: hashPayload(payload),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const result = await handleDecision(
    { db: db as unknown as Db, google: null as any, now: () => new Date() },
    { userId: OTHER_UID, text: "ok", replyId: `appr:${proposal.id}` },
  );
  assert.ok(result);
  assert.match(result.reply, /different conversation/i);
  assert.equal((await getProposal(db as unknown as Db, proposal.id))!.status, "pending");
});

test("a stale ETag is refused and reports Google's current state", async () => {
  const { db } = makeFakeDb();
  const payload = {
    eventId: "evt-1",
    calendarId: "primary",
    title: "Board review",
    before: { start: "2026-10-25T09:00:00+01:00", end: "2026-10-25T10:00:00+01:00" },
    after: { start: "2026-10-26T09:00:00+01:00", end: "2026-10-26T10:00:00+01:00" },
    etag: "\"old-etag\"",
    timezone: "Europe/London",
    attendees: 0,
    sendUpdates: "all" as const,
  };
  const proposal = await createProposal(db, {
    userId: UID,
    kind: "reschedule",
    payload,
    payloadHash: hashPayload(payload),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const google = makeGoogleStub();
  const client = {
    getEvent: async () =>
      patchDetail({
        id: "evt-1",
        summary: "Board review",
        start: { dateTime: "2026-10-26T09:30:00+01:00" },
        end: { dateTime: "2026-10-26T10:30:00+01:00" },
        etag: "\"abc123\"",
        attendees: 0,
        organizer: { self: true },
        guestsCanModify: false,
        status: "confirmed",
      }),
    patchEventTimes: async () => {
      google.patchResult(
        412,
        patchDetail({
          id: "evt-1",
          summary: "Board review",
          start: { dateTime: "2026-10-26T09:30:00+01:00" },
          end: { dateTime: "2026-10-26T10:30:00+01:00" },
          etag: "\"abc123\"",
          attendees: 0,
          organizer: { self: true },
          guestsCanModify: false,
          status: "confirmed",
        }),
      );
    },
  };
  (globalThis.fetch as ReturnType<typeof makeGoogleStub>["fetch"]) = google.fetch as any;
  const result = await handleDecision(
    { db: db as unknown as Db, google: { clientId: "id", clientSecret: "secret", tokenKey: Buffer.alloc(32) }, now: () => new Date() },
    { userId: UID, text: "ok", replyId: `appr:${proposal.id}` },
  );
  assert.ok(result);
  assert.ok((result as { reply: string }).reply);
  assert.match((result as { reply: string }).reply, /did not overwrite/i);
  assert.match((result as { reply: string }).reply, /still/);
  assert.equal((await getProposal(db as unknown as Db, proposal.id))!.status, "failed");
});

test("a transient Google error is reconciled by re-reading before deciding", async () => {
  const { db } = makeFakeDb();
  const payload = {
    eventId: "evt-1",
    calendarId: "primary",
    title: "Board review",
    before: { start: "2026-10-25T09:00:00+01:00", end: "2026-10-25T10:00:00+01:00" },
    after: { start: "2026-10-26T09:00:00+01:00", end: "2026-10-26T10:00:00+01:00" },
    etag: null,
    timezone: "Europe/London",
    attendees: 0,
    sendUpdates: "all" as const,
  };
  const proposal = await createProposal(db, {
    userId: UID,
    kind: "reschedule",
    payload,
    payloadHash: hashPayload(payload),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const google = makeGoogleStub();
  let callCount = 0;
  (globalThis.fetch as ReturnType<typeof makeGoogleStub>["fetch"]) = async () => {
    callCount += 1;
    if (callCount === 1) {
      google.patchResult(
        500,
        patchDetail({
          id: "evt-1",
          summary: "Board review",
          start: { dateTime: "2026-10-26T09:00:00+01:00" },
          end: { dateTime: "2026-10-26T10:00:00+01:00" },
          etag: "\"abc123\"",
          attendees: 0,
          organizer: { self: true },
          guestsCanModify: false,
          status: "confirmed",
        }),
      );
      return new Response(JSON.stringify({}), { status: 500 });
    }
    google.getResult(
      200,
      patchDetail({
        id: "evt-1",
        summary: "Board review",
        start: { dateTime: "2026-10-26T09:00:00+01:00" },
        end: { dateTime: "2026-10-26T10:00:00+01:00" },
        etag: "\"abc123\"",
        attendees: 0,
        organizer: { self: true },
        guestsCanModify: false,
        status: "confirmed",
      }),
    );
    return new Response(JSON.stringify({}), { status: 200 });
  };
  const result = await handleDecision(
    { db: db as unknown as Db, google: { clientId: "id", clientSecret: "secret", tokenKey: Buffer.alloc(32) }, now: () => new Date() },
    { userId: UID, text: "ok", replyId: `appr:${proposal.id}` },
  );
  assert.ok(result);
  assert.ok((result as { reply: string }).reply);
  assert.match((result as { reply: string }).reply, /Done/i);
  assert.equal((await getProposal(db as unknown as Db, proposal.id))!.status, "succeeded");
});
