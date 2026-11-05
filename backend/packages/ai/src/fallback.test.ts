import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, buildSystemPrompt, type AgentDeps } from "./agent.js";

const TZ = "Africa/Lagos";

function makeDeps(
  overrides: Partial<AgentDeps> & {
    onListEvents?: (args: Record<string, unknown>) => void;
  },
): AgentDeps {
  const { onListEvents, ...rest } = overrides;
  const base: AgentDeps = {
    timezone: TZ,
    systemPrompt: "system",
    history: [],
    userMessage: "hello",
    tools: {},
    ...rest,
  };
  base.tools = {
    list_events: async (args) => {
      onListEvents?.(args);
      return {
        date: String(args.date ?? ""),
        events: [
          {
            title: "Board review",
            start: "2026-10-25T09:00:00+01:00",
            end: "2026-10-25T10:00:00+01:00",
            location: "Boardroom",
          },
        ],
      };
    },
    list_reminders: async () => ({
      reminders: [
        {
          fireAt: "2026-10-25T08:45:00+01:00",
          message: "Board review starts in 15 minutes",
          status: "pending",
        },
      ],
    }),
    find_free_time: async () => ({
      date: "2026-10-25",
      slots: [{ start: "2026-10-25T13:00:00+01:00", end: "2026-10-25T14:00:00+01:00" }],
    }),
    ...overrides.tools,
  };
  return base;
}

function todayInTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

test("no LLM key → fallback mode", async () => {
  const res = await runAgent(makeDeps({ userMessage: "hello there" }));
  assert.equal(res.mode, "fallback");
  assert.ok(res.reply.length > 0);
});

test("routes today's schedule to list_events with the local date", async () => {
  let seen: Record<string, unknown> = {};
  const res = await runAgent(
    makeDeps({
      userMessage: "what's on today?",
      onListEvents: (args) => (seen = args),
    }),
  );
  assert.equal(res.mode, "fallback");
  assert.equal(res.toolCalls[0]?.name, "list_events");
  assert.equal(seen.date, todayInTz(), "date must be computed in the user's timezone");
  assert.match(res.reply, /Board review/);
  assert.match(res.reply, /09:00–10:00/);
  assert.match(res.reply, /Boardroom/);
});

test("routes tomorrow to the next day", async () => {
  let seen: Record<string, unknown> = {};
  await runAgent(
    makeDeps({
      userMessage: "any meetings tomorrow",
      onListEvents: (args) => (seen = args),
    }),
  );
  const tomorrow = new Date(Date.now() + 86_400_000);
  const expected = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(tomorrow);
  assert.equal(seen.date, expected);
});

test("lists reminders", async () => {
  const res = await runAgent(makeDeps({ userMessage: "show my reminders" }));
  assert.equal(res.toolCalls[0]?.name, "list_reminders");
  assert.match(res.reply, /Board review starts in 15 minutes/);
  assert.match(res.reply, /pending/);
});

test("finds free slots and honours the requested duration", async () => {
  let seen: Record<string, unknown> = {};
  const res = await runAgent(
    makeDeps({
      userMessage: "find a free 45 minute slot",
      tools: {
        find_free_time: async (args) => {
          seen = args;
          return { date: "2026-10-25", slots: [] };
        },
      },
    }),
  );
  assert.equal(seen.duration_minutes, 45);
  assert.match(res.reply, /No free slots|Free on/);
});

test("tool errors are reported, never thrown", async () => {
  const res = await runAgent(
    makeDeps({
      userMessage: "what's on today?",
      tools: {
        list_events: async () => {
          throw new Error("calendar exploded");
        },
      },
    }),
  );
  assert.equal(res.toolCalls[0]?.ok, false);
  assert.ok(res.reply.length > 0, "fallback still answers something");
});

test("all-day events are listed as All day, without a clock range", async () => {
  const res = await runAgent(
    makeDeps({
      userMessage: "what's on today?",
      tools: {
        list_events: async () => ({
          date: "2026-11-05",
          events: [
            {
              title: "Board review",
              start: "2026-11-05T09:00:00+01:00",
              end: "2026-11-05T10:00:00+01:00",
            },
            {
              title: "Public holiday",
              start: "2026-11-04T23:00:00.000Z",
              end: "2026-11-05T23:00:00.000Z",
              allDay: true,
            },
          ],
        }),
      },
    }),
  );
  assert.match(res.reply, /- 09:00–10:00 Board review/);
  assert.match(res.reply, /- All day Public holiday/);
  assert.ok(!/23:00/.test(res.reply), "no clock time leaks out of an all-day event");
});

test("'connect my calendar' asks the tool for a link", async () => {
  const res = await runAgent(
    makeDeps({
      userMessage: "connect my calendar",
      tools: {
        connect_calendar: async () => ({
          url: "https://ecos.example.com/auth/google?token=a.b",
          expiresInMinutes: 30,
        }),
      },
    }),
  );
  assert.equal(res.toolCalls[0]?.name, "connect_calendar");
  assert.match(res.reply, /https:\/\/ecos\.example\.com\/auth\/google\?token=a\.b/);
  assert.match(res.reply, /30 minutes/);
});

test("a connect request without a link degrades to an apology", async () => {
  const res = await runAgent(makeDeps({ userMessage: "please reconnect my google calendar" }));
  assert.match(res.reply, /couldn't create a calendar link/i);
  assert.ok(res.reply.length > 0);
});

test("unrecognised input falls through to help text", async () => {
  const res = await runAgent(makeDeps({ userMessage: "quantum banana" }));
  assert.match(res.reply, /what's on today|didn't catch/i);
});

test("system prompt carries the timezone and date", () => {
  const prompt = buildSystemPrompt({ timezone: TZ, userName: "Ada", now: new Date() });
  assert.match(prompt, /Ada/);
  assert.match(prompt, /Africa\/Lagos/);
  assert.match(prompt, /Current date/);
});
