import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthUrl, mapGoogleEvent } from "./google.js";
import { createDevClient, defaultDevEvents } from "./dev.js";

test("maps a timed Google event", () => {
  const mapped = mapGoogleEvent({
    id: "abc123",
    summary: "Board review",
    status: "confirmed",
    start: { dateTime: "2026-10-25T09:00:00+01:00" },
    end: { dateTime: "2026-10-25T10:00:00+01:00" },
    location: "Boardroom",
  });
  assert.ok(mapped);
  assert.equal(mapped.externalId, "abc123");
  assert.equal(mapped.title, "Board review");
  assert.equal(mapped.status, "confirmed");
  assert.equal(mapped.location, "Boardroom");
  assert.equal(mapped.start.toISOString(), "2026-10-25T08:00:00.000Z");
});

test("maps an all-day event (date instead of dateTime)", () => {
  const mapped = mapGoogleEvent({
    id: "all-day",
    start: { date: "2026-10-26" },
    end: { date: "2026-10-27" },
  });
  assert.ok(mapped);
  assert.equal(mapped.title, "(untitled)", "missing summary gets a placeholder");
  assert.equal(mapped.start.toISOString(), "2026-10-26T00:00:00.000Z");
});

test("marks cancelled events", () => {
  const mapped = mapGoogleEvent({
    id: "gone",
    summary: "Cancelled sync",
    status: "cancelled",
    start: { dateTime: "2026-10-25T11:00:00Z" },
    end: { dateTime: "2026-10-25T11:30:00Z" },
  });
  assert.equal(mapped?.status, "cancelled");
});

test("rejects malformed resources instead of throwing", () => {
  assert.equal(mapGoogleEvent({}), null);
  assert.equal(mapGoogleEvent({ id: "x" }), null);
  assert.equal(
    mapGoogleEvent({ id: "y", start: { dateTime: "nonsense" }, end: { dateTime: "nonsense" } }),
    null,
  );
  assert.equal(mapGoogleEvent(null as any), null);
});

test("auth URL carries the OAuth handshake parameters", () => {
  const url = new URL(
    buildAuthUrl({
      clientId: "cid",
      redirectUri: "http://localhost:3000/auth/google/callback",
      state: "user-123",
    }),
  );
  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "user-123");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.match(url.searchParams.get("scope") ?? "", /calendar\.readonly/);
});

test("dev client filters fixture events to the window", async () => {
  const now = new Date("2026-10-25T08:00:00");
  const fixtures = defaultDevEvents(now);
  const client = createDevClient(fixtures);

  const morning = await client.listEvents(
    new Date("2026-10-25T08:30:00"),
    new Date("2026-10-25T10:00:00"),
  );
  assert.deepEqual(
    morning.map((e) => e.title),
    ["Daily standup"],
  );

  const empty = await client.listEvents(
    new Date("2026-10-25T20:00:00"),
    new Date("2026-10-25T21:00:00"),
  );
  assert.deepEqual(empty, []);

  const ids = fixtures.map((e) => e.externalId);
  assert.equal(new Set(ids).size, ids.length, "dev external ids must be unique");
});
