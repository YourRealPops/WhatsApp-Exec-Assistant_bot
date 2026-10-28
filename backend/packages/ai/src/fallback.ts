import type { AgentDeps, AgentResult, ToolExecution } from "./agent.js";
import type {
  FindFreeTimeResult,
  ListEventsResult,
  ListRemindersResult,
} from "./tools.js";
import { safeTimezone } from "./agent.js";

const HELP = [
  "I can help with your schedule. Try:",
  '- "what\'s on today"',
  '- "what\'s tomorrow"',
  '- "list my reminders"',
  '- "find a free 30 minute slot"',
  "Set LLM_API_KEY in .env to unlock full natural-language mode.",
].join("\n");

function localDate(now: Date, tz: string, dayOffset = 0): string {
  const d = new Date(now.getTime() + dayOffset * 86_400_000);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function timeLabel(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatEvents(res: ListEventsResult | null, tz: string): string {
  if (!res) return "I couldn't read the calendar just now — try again in a moment.";
  if (res.events.length === 0) return `Nothing on the calendar for ${res.date}.`;
  const lines = res.events.map((e) => {
    const range = `${timeLabel(e.start, tz)}–${timeLabel(e.end, tz)}`;
    return `- ${range} ${e.title}${e.location ? ` (${e.location})` : ""}`;
  });
  return `Schedule for ${res.date}:\n${lines.join("\n")}`;
}

function formatReminders(res: ListRemindersResult | null, tz: string): string {
  if (!res) return "I couldn't read your reminders right now.";
  if (res.reminders.length === 0) return "No reminders scheduled.";
  const lines = res.reminders.map((r) => {
    const when = `${timeLabel(r.fireAt, tz)} on ${localDate(new Date(r.fireAt), tz)}`;
    return `- ${when} ${r.message} [${r.status}]`;
  });
  return `Upcoming reminders:\n${lines.join("\n")}`;
}

function formatSlots(res: FindFreeTimeResult | null, tz: string): string {
  if (!res) return "I couldn't scan your calendar right now.";
  if (res.slots.length === 0) return `No free slots left on ${res.date}.`;
  const lines = res.slots.map((s) => `- ${timeLabel(s.start, tz)}–${timeLabel(s.end, tz)}`);
  return `Free on ${res.date}:\n${lines.join("\n")}`;
}

/**
 * Rule-based assistant for when no LLM key is set. It drives the exact same
 * tool handlers as the LLM path, so the whole pipeline stays testable.
 */
export async function runFallbackAgent(deps: AgentDeps): Promise<AgentResult> {
  const tz = safeTimezone(deps.timezone);
  const now = new Date();
  const text = deps.userMessage.trim();
  const t = text.toLowerCase();
  const dayOffset = /\btomorrow\b/.test(t) ? 1 : 0;
  const date = localDate(now, tz, dayOffset);
  const executions: ToolExecution[] = [];

  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<any | null> {
    const handler = deps.tools[name];
    if (!handler) return null;
    try {
      const result = await handler(args);
      const execution: ToolExecution = { name, args, result, ok: true };
      executions.push(execution);
      deps.onToolCall?.(execution);
      return result;
    } catch (err) {
      const execution: ToolExecution = {
        name,
        args,
        result: { error: err instanceof Error ? err.message : String(err) },
        ok: false,
      };
      executions.push(execution);
      deps.onToolCall?.(execution);
      return null;
    }
  }

  const reply = (body: string): AgentResult => ({
    reply: body,
    toolCalls: executions,
    mode: "fallback",
  });

  if (/^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/.test(t)) {
    return reply(
      "Hey! I'm your executive assistant on WhatsApp. Ask me things like:\n" + HELP,
    );
  }

  if (/\b(free|availability|available|slot)\b/.test(t)) {
    const duration = Number(t.match(/\b(\d{1,3})\s*(min|minute|minutes)\b/)?.[1] ?? 60);
    const res: FindFreeTimeResult | null = await call("find_free_time", {
      date,
      duration_minutes: duration,
    });
    return reply(formatSlots(res, tz));
  }

  if (/\breminders?\b/.test(t) && /\b(list|show|my|upcoming|do i have|any)\b/.test(t)) {
    const res: ListRemindersResult | null = await call("list_reminders", {});
    return reply(formatReminders(res, tz));
  }

  if (/\btomorrow\b/.test(t) || /\b(today|schedule|agenda|calendar|what.s on|what.s next|meetings?)\b/.test(t)) {
    const res: ListEventsResult | null = await call("list_events", { date });
    return reply(formatEvents(res, tz));
  }

  if (/\bhelp\b|what can you do/.test(t)) {
    return reply(HELP);
  }

  return reply(
    "I didn't catch that without an LLM key.\n" + HELP,
  );
}
