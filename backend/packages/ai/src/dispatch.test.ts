import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCalendarIntent, routeCalendarIntent } from "./dispatch.js";
import { dispatchOrRun } from "./agent.js";

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

test("a compound request becomes one operation per action", () => {
  const { operations } = parseCalendarIntent(
    "Remove Future Africa meeting and move L2e meeting to 10a.m tomorrow",
  );
  assert.equal(operations.length, 2);
  assert.deepEqual(operations[0], {
    action: "cancel",
    event: "Future Africa meeting",
  });
  assert.deepEqual(operations[1], {
    action: "move",
    event: "L2e meeting",
    start: "10a.m tomorrow",
  });
});

test("'then' and a comma also join independent actions", () => {
  const { operations } = parseCalendarIntent(
    "cancel the gym session, then move the board review to 4 PM",
  );
  assert.equal(operations.length, 2);
  assert.equal(operations[0].event, "gym session");
  assert.equal(operations[1].action, "move");
  assert.equal(operations[1].event, "board review");
  assert.equal(operations[1].start, "4 PM");
});

test("an event title containing 'and' is not split into two actions", () => {
  const { operations } = parseCalendarIntent("cancel Research and Development sync");
  assert.equal(operations.length, 1);
  assert.equal(operations[0].event, "Research and Development sync");
});

test("a cancel by clock alone keeps the clock and asks for no title", () => {
  assert.deepEqual(parseCalendarIntent("Remove the event by 21:00").operations, [
    { action: "cancel", event: null, time: "21:00" },
  ]);
});

test("a displayed title with its clock and UTC annotation loses only the noise", () => {
  const { operations } = parseCalendarIntent(
    "Remove 21:00 Future Africa meeting (22:00 UTC)",
  );
  assert.equal(operations.length, 1);
  assert.equal(operations[0].event, "Future Africa meeting");
  assert.equal(operations[0].time, "21:00");
});

test("'the 9 PM one' is a time reference, not an event title", () => {
  assert.deepEqual(parseCalendarIntent("Remove the 9 PM one").operations, [
    { action: "cancel", event: null, time: "9 PM" },
  ]);
});

test("'the first one' and 'the second meeting' become ordinals", () => {
  assert.deepEqual(parseCalendarIntent("Cancel the first one.").operations, [
    { action: "cancel", event: null, ordinal: 1 },
  ]);
  assert.deepEqual(
    parseCalendarIntent("Move the second meeting to tomorrow.").operations,
    [{ action: "move", event: null, start: "tomorrow", ordinal: 2 }],
  );
});

test("'actually, move it to 4 PM instead' is a move with no title", () => {
  assert.deepEqual(
    parseCalendarIntent("Actually, move it to 4 PM instead.").operations,
    [{ action: "move", event: null, start: "4 PM" }],
  );
});

test("a title containing 'to' survives the move split", () => {
  const { operations } = parseCalendarIntent(
    "move the Road to launch review to 4pm",
  );
  assert.equal(operations[0].event, "Road to launch review");
  assert.equal(operations[0].start, "4pm");
});

test("a single compound route is not exposed as one event title", () => {
  assert.equal(routeCalendarIntent("cancel A and move B to 4 PM"), null);
});

test("each action becomes its own proposal with its own approval text", async () => {
  const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
  const result = await dispatchOrRun(
    {
      llm: null,
      systemPrompt: "",
      timezone: "Africa/Lagos",
      history: [],
      userMessage: "",
      tools: {
        propose_event_cancellation: async (args) => {
          seen.push({ name: "propose_event_cancellation", args });
          return { proposalId: "proposal-cancel", message: `Cancel: ${args.event}` };
        },
        propose_event_change: async (args) => {
          seen.push({ name: "propose_event_change", args });
          return {
            proposalId: "proposal-move",
            message: `Move: ${args.event} to ${args.start}`,
          };
        },
      },
    },
    "Cancel Future Africa meeting and move L2E meeting to 10 AM tomorrow.",
  );

  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].args, { event: "Future Africa meeting" });
  assert.deepEqual(seen[1].args, {
    event: "L2E meeting",
    start: "10 AM tomorrow",
  });
  assert.equal(result.toolCalls.length, 2);
  assert.match(result.reply, /Cancel: Future Africa meeting/);
  assert.match(result.reply, /Move: L2E meeting to 10 AM tomorrow/);
  // Both proposals are pending; nothing was executed.
  assert.ok(result.toolCalls.every((call) => call.ok));
});

test("a failed action never hides the other proposal", async () => {
  const result = await dispatchOrRun(
    {
      llm: null,
      systemPrompt: "",
      timezone: "Africa/Lagos",
      history: [],
      userMessage: "",
      tools: {
        propose_event_cancellation: async () => {
          throw new Error('I couldn\'t find an event matching "Future Africa".');
        },
        propose_event_change: async () => ({
          proposalId: "proposal-move",
          message: "Move: L2E meeting to 10 AM tomorrow",
        }),
      },
    },
    "Remove Future Africa meeting and move L2E meeting to 10 AM tomorrow.",
  );
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].ok, false);
  assert.equal(result.toolCalls[1].ok, true);
  assert.match(result.reply, /couldn't find an event/);
  assert.match(result.reply, /Move: L2E meeting/);
});
