import { test } from "node:test";
import assert from "node:assert/strict";
import { routeCalendarIntent } from "./dispatch.js";

test("cancelling an event routes to the cancellation proposal", () => {
  const route = routeCalendarIntent("cancel my meeting with Ada tomorrow");
  assert.equal(route?.name, "propose_event_cancellation");
  assert.match(String(route?.args.event), /meeting with Ada/);
});

test("rescheduling an event routes to the reschedule proposal", () => {
  const route = routeCalendarIntent("move the board review to 4 PM");
  assert.equal(route?.name, "propose_event_change");
  assert.equal(route?.args.event, "board review");
  assert.equal(route?.args.start, "4 PM");
});

test("a cancel with no event named is left to the conversation", () => {
  assert.equal(routeCalendarIntent("cancel my meeting"), null);
  assert.equal(routeCalendarIntent("cancel that"), null);
});

test("approve, reject and plain questions are never routed to a write", () => {
  assert.equal(routeCalendarIntent("yes"), null);
  assert.equal(routeCalendarIntent("no"), null);
  assert.equal(routeCalendarIntent("what's on today?"), null);
});
