import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "@exec-assistant/db";
import { requestCalendarDocument, type DocumentRequestContext } from "./documents.js";

const UID = "6f1d5a3c-2b7e-4f5a-9c8d-0a1b2c3d4e5f";

function fakeDb(opts: { account?: Record<string, unknown> | null; events?: unknown[] } = {}) {
  const jobs: Array<Record<string, unknown>> = [];
  const template = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("from calendar_accounts")) {
      return Promise.resolve(opts.account ? [opts.account] : []);
    }
    if (sql.includes("from events")) {
      return Promise.resolve(opts.events ?? []);
    }
    if (sql.includes("insert into document_jobs")) {
      const job = {
        id: `job-${jobs.length + 1}`,
        user_id: values[0],
        request_message_id: values[1],
        kind: values[2],
        title: values[3],
        payload: values[4],
        status: "queued",
      };
      jobs.push(job);
      return Promise.resolve([job]);
    }
    return Promise.resolve([]);
  };
  const db = Object.assign(template, {
    json: (value: unknown) => value,
  }) as unknown as Db;
  return { db, jobs };
}

function ctx(db: Db, overrides: Partial<DocumentRequestContext> = {}): DocumentRequestContext {
  return {
    db,
    userId: UID,
    timezone: "Africa/Lagos",
    google: null,
    freshnessMs: 120_000,
    lookaheadDays: 14,
    reminderOffsets: [15, 10, 5, 0],
    maxOffsetMinutes: 15,
    maxEvents: 500,
    maxDays: 31,
    currentMessageId: "wamid.in.1",
    ...overrides,
  };
}

const eventRow = {
  id: "e1",
  external_id: "google:e1",
  title: "Board review",
  start_at: new Date("2026-11-23T09:00:00Z"),
  end_at: new Date("2026-11-23T10:00:00Z"),
  all_day: false,
  location: "Boardroom",
  description: null,
  status: "confirmed",
};

test("a document request queues one job with the calendar snapshot", async () => {
  const { db, jobs } = fakeDb({ events: [eventRow] });
  const result = await requestCalendarDocument(ctx(db), {
    format: "powerpoint",
    date: "2026-11-23",
    days: 7,
    title: "Week ahead",
  });

  assert.equal(result.format, "pptx");
  assert.equal(result.eventCount, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, "Week ahead");
  assert.deepEqual((jobs[0].payload as any).events, [
    {
      title: "Board review",
      start: "2026-11-23T09:00:00.000Z",
      end: "2026-11-23T10:00:00.000Z",
      allDay: false,
      location: "Boardroom",
      description: null,
    },
  ]);
  assert.match(result.message, /PowerPoint presentation is being prepared/);
  assert.equal((jobs[0].payload as any).timezone, "Africa/Lagos");
});

test("a general document queues a writing brief without a calendar connection", async () => {
  const { db, jobs } = fakeDb();
  const result = await requestCalendarDocument(
    ctx(db, { currentMessage: "Create a PDF report about artificial intelligence" }),
    { format: "pdf", source: "general" },
  );

  assert.equal(result.source, "general");
  assert.equal(result.eventCount, 0);
  assert.equal(result.format, "pdf");
  assert.equal(jobs.length, 1);
  const payload = jobs[0].payload as any;
  assert.equal(payload.source, "general");
  assert.equal(payload.subject, "artificial intelligence");
  assert.match(payload.prompt, /PDF report about artificial intelligence/);
  assert.equal(payload.events, undefined, "no calendar snapshot is involved");
  assert.equal(jobs[0].title, "artificial intelligence");
});

test("a general deck keeps the requested slide count and topic", async () => {
  const { db, jobs } = fakeDb();
  const result = await requestCalendarDocument(
    ctx(db, {
      currentMessage: "Create a PowerPoint presentation about cybersecurity with 10 slides",
    }),
    {
      format: "pptx",
      source: "general",
      topic: "cybersecurity",
      slide_count: 10,
      audience: "the board",
      tone: "concise",
      structure: "Landscape\nRisks\nRecommendations",
    },
  );

  assert.equal(result.source, "general");
  assert.equal(result.slideCount, 10);
  const payload = jobs[0].payload as any;
  assert.equal(payload.subject, "cybersecurity");
  assert.equal(payload.slideCount, 10);
  assert.equal(payload.audience, "the board");
  assert.equal(payload.tone, "concise");
  assert.equal(payload.structure, "Landscape\nRisks\nRecommendations");
});

test("a calendar summary still takes the calendar path", async () => {
  const { db, jobs } = fakeDb({ events: [eventRow] });
  const result = await requestCalendarDocument(
    ctx(db, { currentMessage: "Create a PDF summary of my meetings tomorrow" }),
    { format: "pdf", date: "2026-11-23", days: 1 },
  );
  assert.equal(result.source, "calendar");
  assert.equal(result.eventCount, 1);
  assert.equal((jobs[0].payload as any).source, "calendar");
  assert.ok(Array.isArray((jobs[0].payload as any).events));
});

test("an unknown format is refused before any job is created", async () => {
  const { db, jobs } = fakeDb();
  await assert.rejects(
    requestCalendarDocument(ctx(db), { format: "spreadsheet" }),
    /PDF, Word document or PowerPoint/,
  );
  assert.equal(jobs.length, 0);
});

test("a document is never built from a stale calendar", async () => {
  const { db, jobs } = fakeDb({
    account: {
      id: "a1",
      user_id: UID,
      access_token: "token",
      refresh_token: null,
      expires_at: null,
      synced_at: new Date("2026-11-01T00:00:00Z"),
      last_sync_error: null,
      reauth_required_at: null,
      sync_token: null,
      sync_next_at: null,
      sync_attempts: 0,
    },
    events: [eventRow],
  });

  await assert.rejects(
    requestCalendarDocument(ctx(db), { format: "pdf" }),
    /may be out of date|out-of-date/,
  );
  assert.equal(jobs.length, 0, "no job is queued from stale data");
});
