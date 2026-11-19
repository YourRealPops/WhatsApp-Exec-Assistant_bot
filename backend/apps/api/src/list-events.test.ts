import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CalEvent, Db } from "@exec-assistant/db";
import { buildTools } from "./tools.js";

const UID = "6f1d5a3c-2b7e-4f5a-9c8d-0a1b2c3d4e5f";
const LAGOS = "Africa/Lagos";

/**
 * In-memory Db for `list_events`: it reads synced events and writes the
 * listing context (`event_references`) through the same transaction shape the
 * repo uses.
 */
function makeDb() {
  const events: CalEvent[] = [
    {
      id: randomUUID(),
      user_id: UID,
      external_id: "evt-future-africa",
      title: "Future Africa meeting",
      start_at: new Date("2026-11-19T20:00:00Z"), // 21:00 Lagos
      end_at: new Date("2026-11-19T21:00:00Z"), // 22:00 Lagos
      location: null,
      description: null,
      status: "confirmed",
      all_day: false,
      updated_at: new Date(),
    },
    {
      id: randomUUID(),
      user_id: UID,
      external_id: "evt-l2e",
      title: "L2E meeting",
      start_at: new Date("2026-11-19T21:30:00Z"), // 22:30 Lagos
      end_at: new Date("2026-11-19T22:30:00Z"), // 23:30 Lagos
      location: null,
      description: null,
      status: "confirmed",
      all_day: false,
      updated_at: new Date(),
    },
  ];
  const references: Array<Record<string, unknown>> = [];

  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ");
    if (text.includes("delete from event_references")) {
      references.length = 0;
      return Promise.resolve([]);
    }
    if (text.includes("insert into event_references")) {
      references.push({
        user_id: values[0],
        position: values[1],
        external_id: values[2],
        title: values[3],
        start_at: values[4],
        end_at: values[5],
      });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Db;

  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ");
    if (text.includes("from calendar_accounts")) return Promise.resolve([]);
    if (text.includes("from events")) {
      const from = values[1] as Date;
      const to = values[2] as Date;
      return Promise.resolve(
        events.filter(
          (event) =>
            event.user_id === UID &&
            event.start_at >= from &&
            event.start_at < to &&
            event.status !== "cancelled",
        ),
      );
    }
    return Promise.resolve([]);
  }) as unknown as Db;
  (db as unknown as { begin: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown> }).begin =
    (fn) => fn(tx);

  return { db, references };
}

test("list_events returns local, offset-labeled times and never a UTC clock", async () => {
  const { db, references } = makeDb();
  const tools = buildTools({
    db,
    userId: UID,
    timezone: LAGOS,
    devCalendar: false,
    needsConnect: false,
  });

  const result = (await tools.list_events({ date: "2026-11-19" })) as {
    timezone: string;
    events: Array<Record<string, unknown>>;
  };

  assert.equal(result.timezone, LAGOS);
  assert.equal(result.events.length, 2);
  // 21:00 Lagos is 20:00Z — displayed as 21:00+01:00, not 22:00 or "20:00Z".
  assert.equal(result.events[0].startLocal, "Thu 19 Nov, 21:00");
  assert.equal(result.events[0].offset, "+01:00");
  assert.equal(result.events[0].display, "Thu 19 Nov, 21:00–22:00 (+01:00)");
  assert.doesNotMatch(String(result.events[0].display), /UTC/);
  assert.equal(result.events[1].startLocal, "Thu 19 Nov, 22:30");
  assert.equal(result.events[1].display, "Thu 19 Nov, 22:30–23:30 (+01:00)");

  // The listing becomes the context that "the second one" refers to.
  assert.equal(references.length, 2);
  assert.equal(references[0].position, 1);
  assert.equal(references[0].external_id, "evt-future-africa");
  assert.equal(references[1].position, 2);
  assert.equal(references[1].external_id, "evt-l2e");
});
