import type { AgentDeps, AgentResult, ToolExecution } from "./agent.js";
import type {
  ConnectCalendarResult,
  ConnectionStatusResult,
  DisconnectResult,
  FindFreeTimeResult,
  ListEventsResult,
  ListRemindersResult,
  ManageConnectionsResult,
  ProposeEventChangeResult,
  SaveProfileResult,
} from "./tools.js";
import { safeTimezone } from "./agent.js";
import { parseProfile } from "./profile.js";

const HELP = [
  "I can help with your schedule. Try:",
  '- "what\'s on today"',
  '- "what\'s tomorrow"',
  '- "list my reminders"',
  '- "find a free 30 minute slot"',
  '- "connect my calendar"',
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
    // All-day events are dates, so a clock range would be noise (and, before
    // we anchored them locally, the wrong day).
    const when = e.allDay
      ? "All day"
      : `${timeLabel(e.start, tz)}–${timeLabel(e.end, tz)}`;
    return `- ${when} ${e.title}${e.location ? ` (${e.location})` : ""}`;
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

  // Profile statements without an LLM: "my name is Ada", "call me Ada, CTO".
  const profile = parseProfile(text);
  if (profile?.explicit) {
    const saved = (await call("save_profile", {
      name: profile.name,
      ...(profile.designation ? { designation: profile.designation } : {}),
    })) as SaveProfileResult | null;
    if (saved) {
      return reply(`Noted — I'll call you ${saved.name ?? profile.name}.`);
    }
  }

  if (/^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/.test(t)) {
    return reply(
      "Hey! I'm your executive assistant on WhatsApp. Ask me things like:\n" + HELP,
    );
  }

  if (/(what|which).*(connected|connection)|connection status/.test(t)) {
    const res: ConnectionStatusResult | null = await call("connection_status", {});
    if (!res) return reply("I couldn't check the connection just now — try again in a moment.");
    if (!res.connected) {
      return reply(
        "No calendar is connected yet. Message me \"connect my calendar\" and I'll send a private link.",
      );
    }
    const lines = [
      `Connected: Google Calendar${res.accountEmail ? ` (${res.accountEmail})` : ""}`,
      `Permission: ${res.permission ?? "view and edit your calendar events"}`,
      res.lastSyncAt
        ? `Last sync: ${timeLabel(res.lastSyncAt, tz)} on ${localDate(new Date(res.lastSyncAt), tz)}`
        : "Last sync: not yet",
    ];
    if (res.needsReconnect) {
      lines.push(
        "Needs reconnect: Google rejected the permission. Message me \"reconnect my calendar\" for a fresh link.",
      );
    } else if (res.lastSyncError) {
      lines.push(`Last sync reported an error: ${res.lastSyncError}`);
    }
    return reply(lines.join("\n"));
  }

  if (/\bmanage\b/.test(t) && /\bconnection/.test(t)) {
    const res: ManageConnectionsResult | null = await call("manage_connections", {});
    if (!res?.url) {
      return reply("I couldn't create a connections link just now — try again in a moment.");
    }
    return reply(
      `Private connections page (expires in ${res.expiresInMinutes} minutes):\n${res.url}`,
    );
  }

  if (/\bdisconnect\b/.test(t) && /(calendar|google)/.test(t)) {
    // Two steps, never one: the tool decides whether this is the ask or the act.
    const confirm = /^(yes|yeah|yep|confirm|do it)\b/.test(t);
    const res: DisconnectResult | null = await call("disconnect_calendar", { confirm });
    if (!res) return reply("I couldn't reach your connection just now — try again in a moment.");
    return reply(res.message);
  }

  if (/(connect|reconnect|relink)/.test(t) && /(calendar|google)/.test(t)) {
    const res: ConnectCalendarResult | null = await call("connect_calendar", {});
    if (!res?.url) {
      return reply("I couldn't create a calendar link just now — try again in a moment.");
    }
    return reply(
      `Google will ask for permission to view and edit your calendar events. Nothing changes without your approval.\nOpen this link within ${res.expiresInMinutes} minutes to connect Google Calendar:\n${res.url}`,
    );
  }

  // "move the board review to friday 10am" — proposal only, never a write.
  const move = text.match(/^(?:move|reschedule|shift|push)\s+(.+?)\s+to\s+(.+)$/i);
  if (move) {
    const res: ProposeEventChangeResult | null = await call("propose_event_change", {
      event: move[1].trim(),
      start: move[2].trim(),
    });
    if (!res) {
      return reply(
        "I couldn't prepare that change — check the event name and the new time, or connect your calendar first.",
      );
    }
    return reply(res.message);
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
