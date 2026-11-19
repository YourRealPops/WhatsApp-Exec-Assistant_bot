import { randomUUID } from "node:crypto";
import {
  createAdHocReminder,
  getCalendarAccount,
  listUpcomingEvents,
  listUpcomingReminders,
  replaceEventReferences,
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
  ConnectionStatusResult,
  CreateEventResult,
  DisconnectResult,
  ProposeEventCancellationResult,
  FindFreeTimeResult,
  ListEventsResult,
  ListRemindersResult,
  ManageConnectionsResult,
  ProposeEventChangeResult,
  SaveProfileResult,
  SetReminderResult,
  ToolHandler,
} from "@exec-assistant/ai";
import {
  assertCalendarEventsScope,
  connectedGoogleClient,
  requireGoogleAccount,
  type GoogleConfig,
} from "./calendar-access.js";
import {
  connectionStatus,
  disconnectCalendar,
  manageConnections,
} from "./connections.js";
import { proposeEventCancellation, proposeEventChange } from "./proposals.js";
import { clock, day, offsetLabel } from "./when.js";

export interface ToolContext {
  db: Db;
  userId: string;
  timezone: string;
  devCalendar: boolean;
  /** Needed to mint a connect link; without them the tool fails politely. */
  publicBaseUrl?: string;
  oauthStateSecret?: string;
  /** Google credentials + token key; absent means calendar writes are off. */
  google?: GoogleConfig | null;
  /** APPROVAL_TTL_MINUTES, applied to every proposal. */
  approvalTtlMinutes?: number;
  /** The user's message for this turn — the disconnect confirmation reads it. */
  currentMessage?: string;
  /** True when calendar writes are off; events created here are local-only
   *  until Google is connected. */
  needsConnect: boolean;
}

/** One Google Calendar API error, plus a small set of conditionally-backed
 * extras that only Google v3 returns. Everything else is caught by the
 * generic {@link CalendarError} branch.
 */
export class GoogleCalendarError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "GoogleCalendarError";
    this.code = code;
  }
}

/** Google's `401`/`403` with `invalid_grant`/`insufficient_scope` style text. */
export class CalendarAuthError extends Error {
  /** Reason Google gave: `invalid_grant`, `insufficient_scope`, etc. */
  readonly reason: string;

  /** The auth failure category: `auth` for auth errors. */
  code: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "CalendarAuthError";
    this.code = "auth";
    this.reason = reason;
  }
}

/** Google's `409` when the event already exists on the user's calendar. */
export class CalendarConflictError extends Error {
  constructor(message = "The event could not be created: a Google Calendar conflict occurred.") {
    super(message);
    this.name = "CalendarConflictError";
  }
}

/** A write to Google Calendar was accepted but the returned object could not
 * be read back. */
export class CalendarWriteUnverifiedError extends Error {
  constructor(message = "The event was created on Google Calendar, but I could not read it back to confirm.") {
    super(message);
    this.name = "CalendarWriteUnverifiedError";
  }
}

/** Something about the Google Calendar write is out of ordinary conditions:
 * a network error, a 5xx/429, or a timeout. The only safe next step is to
 * retry the exact same call. */
export class CalendarTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarTransientError";
  }
}

/** Something about the Google Calendar credentials is out of ordinary
 * conditions: no credentials, no access token, or the OAuth connection is
 * missing. */
export class CalendarSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarSetupError";
  }
}

/** An error from the Google Calendar API that could not be mapped to one of
 * the specific error classes above. */
export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarError";
  }
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
  const { db, userId, timezone: tz, needsConnect } = ctx;

  return {
    list_events: async (args): Promise<ListEventsResult> => {
      await ensureDevEvents(db, userId, ctx.devCalendar);
      const dateStr = dayArg(args, tz);
      const days = clamp(Number(args.days ?? 1), 1, MAX_DAYS);
      const from = startOfDayInTz(dateStr, tz);
      const to = startOfDayInTz(addDaysToDateStr(dateStr, days), tz);
      const events = await listUpcomingEvents(db, userId, from, to);

      // This listing is now the conversational context: "the second one" and
      // "the 9 PM one" resolve against exactly these rows.
      await replaceEventReferences(
        db,
        userId,
        events.map((e) => ({
          externalId: e.external_id,
          title: e.title,
          start: new Date(e.start_at),
          end: new Date(e.end_at),
        })),
      ).catch((err) => {
        console.error(
          `[list_events] could not store listing context for ${userId}:`,
          err instanceof Error ? err.message : err,
        );
      });

      return {
        date: dateStr,
        timezone: tz,
        events: events.map((e) => {
          const start = new Date(e.start_at);
          const end = new Date(e.end_at);
          // The same instant, already rendered in the user's timezone. The
          // model quotes this text; it never converts an offset itself.
          const startLocal = e.all_day
            ? `${day(start, tz)} (all day)`
            : `${day(start, tz)}, ${clock(start, tz)}`;
          const endLocal = e.all_day
            ? `all day`
            : `${clock(end, tz)}`;
          return {
            id: e.external_id,
            title: e.title,
            start: start.toISOString(),
            end: end.toISOString(),
            startLocal,
            endLocal,
            display: e.all_day
              ? `${day(start, tz)} (all day)`
              : `${day(start, tz)}, ${clock(start, tz)}–${clock(end, tz)} (${offsetLabel(start, tz)})`,
            timezone: tz,
            offset: offsetLabel(start, tz),
            allDay: e.all_day,
            location: e.location,
          };
        }),
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

  const account = await requireGoogleAccount(db, userId);
  if (!ctx.google) {
    throw new CalendarSetupError(
      "No calendar credentials configured on this server; connect Google Calendar before creating events.",
    );
  }
  await assertCalendarEventsScope(account);
  const client = await connectedGoogleClient(ctx.google, db, account);

  const externalId = `google:${randomUUID()}`;
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const [row] = await db`
    INSERT INTO events (
      user_id,
      external_id,
      title,
      start_at,
      end_at,
      location,
      description,
      status,
      updated_at
    )
    VALUES (
      ${userId},
      ${externalId},
      ${title},
      ${start},
      ${end},
      ${typeof args.location === "string" ? args.location : null},
      ${"created by the assistant"},
      ${"confirmed"},
      NOW()
    )
    RETURNING *
  `;

  const body: Record<string, unknown> = {
    summary: title,
    start: {
      dateTime: startIso,
      timeZone: account.timezone ?? "UTC",
    },
    end: {
      dateTime: endIso,
      timeZone: account.timezone ?? "UTC",
    },
  };
  if (typeof args.location === "string" && args.location.trim() !== "") {
    body.location = args.location;
  }
  if (typeof args.description === "string" && args.description.trim() !== "") {
    body.description = args.description;
  }

  let googleEventId: string | null = null;
  try {
    const response = await client.insertEvent({
      calendarId: account.calendar_id,
      sendUpdates: "all",
      requestBody: body,
    });
    googleEventId = response.event.externalId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CalendarAuthError) {
      console.error(`[create_event] Google calendar authorization failed for ${userId}: ${message}`);
      throw err;
    }
    if (err instanceof CalendarTransientError) {
      console.error(`[create_event] Google Calendar transient error for ${userId}: ${message}`);
      throw err;
    }
    if (err instanceof CalendarConflictError) {
      console.error(`[create_event] Google Calendar conflict for ${userId}: ${message}`);
      await db`update events set status = 'failed', updated_at = now() where id = ${row.id}`;
      throw err;
    }
    console.error(`[create_event] Google Calendar unexpected error for ${userId}: ${message}`);
    throw err;
  }

  if (!googleEventId) {
    console.error(`[create_event] Google Calendar did not return an event id for ${userId}`);
    throw new CalendarWriteUnverifiedError();
  }

  await db`update events set external_id = ${googleEventId} where id = ${row.id}`;

  return {
    created: true,
    title,
    start: new Date(row.start_at).toISOString(),
    end: new Date(row.end_at).toISOString(),
    needsConnect: false,
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

    connection_status: async (): Promise<ConnectionStatusResult> =>
      connectionStatus({
        db,
        userId,
        google: ctx.google ?? null,
        publicBaseUrl: ctx.publicBaseUrl,
        oauthStateSecret: ctx.oauthStateSecret,
        currentMessage: ctx.currentMessage ?? "",
      }),

    manage_connections: async (): Promise<ManageConnectionsResult> =>
      manageConnections({
        db,
        userId,
        google: ctx.google ?? null,
        publicBaseUrl: ctx.publicBaseUrl,
        oauthStateSecret: ctx.oauthStateSecret,
        currentMessage: ctx.currentMessage ?? "",
      }),

    disconnect_calendar: async (args): Promise<DisconnectResult> =>
      disconnectCalendar(
        {
          db,
          userId,
          google: ctx.google ?? null,
          publicBaseUrl: ctx.publicBaseUrl,
          oauthStateSecret: ctx.oauthStateSecret,
          currentMessage: ctx.currentMessage ?? "",
        },
        args,
      ),

    propose_event_change: async (args): Promise<ProposeEventChangeResult> =>
      proposeEventChange(
        {
          db,
          userId,
          timezone: tz,
          google: ctx.google ?? null,
          approvalTtlMinutes: ctx.approvalTtlMinutes ?? 15,
        },
        args,
      ),

    propose_event_cancellation: async (
      args,
    ): Promise<ProposeEventCancellationResult> =>
      proposeEventCancellation(
        {
          db,
          userId,
          timezone: tz,
          google: ctx.google ?? null,
          approvalTtlMinutes: ctx.approvalTtlMinutes ?? 15,
        },
        args,
      ),

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
