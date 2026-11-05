import { randomUUID } from "node:crypto";
import {
  createAdHocReminder,
  getCalendarAccount,
  listUpcomingEvents,
  listUpcomingReminders,
  setUserProfile,
  upsertEvents,
  type Db,
} from "@exec-assistant/db";
import {
  CONNECT_TOKEN_TTL_MS,
  addDaysToDateStr,
  buildConnectUrl,
  defaultDevEvents,
  parseWhen,
  startOfDayInTz,
  todayInTz,
} from "@exec-assistant/calendar";
import type {
  ConnectCalendarResult,
  CreateEventResult,
  FindFreeTimeResult,
  ListEventsResult,
  ListRemindersResult,
  SaveProfileResult,
  SetReminderResult,
  ToolHandler,
} from "@exec-assistant/ai";

export interface ToolContext {
  db: Db;
  userId: string;
  timezone: string;
  devCalendar: boolean;
  /** Needed to mint a connect link; without them the tool fails politely. */
  publicBaseUrl?: string;
  oauthStateSecret?: string;
}

const WORKDAY_START = "09:00";
const WORKDAY_END = "18:00";
const MAX_DAYS = 14;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function dayArg(args: Record<string, unknown>, tz: string): string {
  const date = args.date;
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
    return date.trim();
  }
  return todayInTz(tz);
}

/**
 * Seed the dev fixture calendar (standup / investor call / gym) for users
 * who have not connected Google yet, so the whole system is observable
 * without OAuth credentials.
 */
export async function ensureDevEvents(
  db: Db,
  userId: string,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  const account = await getCalendarAccount(db, userId);
  if (account) return;
  await upsertEvents(db, userId, defaultDevEvents());
}

export function buildTools(ctx: ToolContext): Record<string, ToolHandler> {
  const { db, userId, timezone: tz } = ctx;

  return {
    list_events: async (args): Promise<ListEventsResult> => {
      await ensureDevEvents(db, userId, ctx.devCalendar);
      const dateStr = dayArg(args, tz);
      const days = clamp(Number(args.days ?? 1), 1, MAX_DAYS);
      const from = startOfDayInTz(dateStr, tz);
      const to = startOfDayInTz(addDaysToDateStr(dateStr, days), tz);
      const events = await listUpcomingEvents(db, userId, from, to);
      return {
        date: dateStr,
        events: events.map((e) => ({
          title: e.title,
          start: new Date(e.start_at).toISOString(),
          end: new Date(e.end_at).toISOString(),
          allDay: e.all_day,
          location: e.location,
        })),
      };
    },

    find_free_time: async (args): Promise<FindFreeTimeResult> => {
      const dateStr = dayArg(args, tz);
      const duration = clamp(Number(args.duration_minutes ?? 60), 15, 480);
      const dayStart = startOfDayInTz(dateStr, tz);
      const dayEnd = startOfDayInTz(addDaysToDateStr(dateStr, 1), tz);
      const events = await listUpcomingEvents(db, userId, dayStart, dayEnd);

      const workStart = parseWhen(`${dateStr}T${WORKDAY_START}`, tz);
      const workEnd = parseWhen(`${dateStr}T${WORKDAY_END}`, tz);
      let cursor = Math.max(workStart.getTime(), Date.now());
      cursor = Math.ceil(cursor / (5 * 60_000)) * 5 * 60_000;

      const slots: FindFreeTimeResult["slots"] = [];
      const busy = events
        .map((e) => ({
          start: new Date(e.start_at).getTime(),
          end: new Date(e.end_at).getTime(),
        }))
        .sort((a, b) => a.start - b.start);

      const offer = (from: number, to: number) => {
        if (to - from >= duration * 60_000 && slots.length < 5) {
          slots.push({
            start: new Date(from).toISOString(),
            end: new Date(from + duration * 60_000).toISOString(),
          });
        }
      };

      for (const block of busy) {
        if (block.end <= cursor) continue;
        if (block.start > workEnd.getTime()) break;
        offer(cursor, Math.min(block.start, workEnd.getTime()));
        cursor = Math.max(cursor, block.end);
        if (cursor >= workEnd.getTime()) break;
      }
      offer(cursor, workEnd.getTime());

      return { date: dateStr, slots };
    },

    create_event: async (args): Promise<CreateEventResult> => {
      const title = String(args.title ?? "").trim();
      if (!title) throw new Error("title is required");
      const start = parseWhen(String(args.start ?? ""), tz);
      const end = args.end
        ? parseWhen(String(args.end), tz)
        : new Date(start.getTime() + 3_600_000);
      if (end.getTime() <= start.getTime()) {
        throw new Error("end must be after start");
      }
      const [created] = await upsertEvents(db, userId, [
        {
          externalId: `local:${randomUUID()}`,
          title,
          start,
          end,
          location: typeof args.location === "string" ? args.location : null,
          description: "created by the assistant",
        },
      ]);
      return {
        created: true,
        title,
        start: new Date(created.start_at).toISOString(),
        end: new Date(created.end_at).toISOString(),
      };
    },

    set_reminder: async (args): Promise<SetReminderResult> => {
      const message = String(args.message ?? "").trim();
      if (!message) throw new Error("message is required");
      const at = parseWhen(String(args.at ?? ""), tz);
      if (at.getTime() <= Date.now()) {
        throw new Error("that time is in the past");
      }
      // Reminders ring the phone unless the user explicitly asked for a
      // message only.
      const alarm = args.alarm === undefined || String(args.alarm) !== "false";
      const row = await createAdHocReminder(db, {
        userId,
        fireAt: at,
        note: message,
        alarm,
      });
      return {
        created: row !== null,
        at: at.toISOString(),
        message,
        alarm: row?.alarm ?? alarm,
      };
    },

    connect_calendar: async (): Promise<ConnectCalendarResult> => {
      if (!ctx.publicBaseUrl || !ctx.oauthStateSecret) {
        throw new Error("calendar connection is not configured on this server");
      }
      return {
        url: buildConnectUrl({
          baseUrl: ctx.publicBaseUrl,
          secret: ctx.oauthStateSecret,
          uid: userId,
        }),
        expiresInMinutes: Math.round(CONNECT_TOKEN_TTL_MS / 60_000),
      };
    },

    save_profile: async (args): Promise<SaveProfileResult> => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const designation =
        typeof args.designation === "string" ? args.designation.trim() : "";
      const saved = await setUserProfile(db, userId, {
        name: name || null,
        designation: designation || null,
      });
      return {
        name: saved?.name ?? null,
        designation: saved?.designation ?? null,
      };
    },

    list_reminders: async (): Promise<ListRemindersResult> => {
      const rows = await listUpcomingReminders(db, userId, 20);
      return {
        reminders: rows.map((r) => ({
          fireAt: new Date(r.fire_at).toISOString(),
          message: r.event_id
            ? `${r.event_title ?? "your event"}${
                (r.offset_minutes ?? 0) > 0
                  ? ` — ${r.offset_minutes} min before`
                  : " — starting now"
              }`
            : r.note,
          status: r.status,
          eventTitle: r.event_title,
        })),
      };
    },
  };
}
