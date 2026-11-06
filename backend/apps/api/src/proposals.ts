import {
  createProposal,
  hashPayload,
  listUpcomingEvents,
  type Db,
  type ProposalPayload,
} from "@exec-assistant/db";
import {
  addDaysToDateStr,
  parseWhen,
  startOfDayInTz,
  todayInTz,
} from "@exec-assistant/calendar";
import type { ProposeEventChangeResult } from "@exec-assistant/ai";
import {
  connectedGoogleClient,
  requireGoogleAccount,
  type GoogleConfig,
} from "./calendar-access.js";
import { formatRange } from "./when.js";

/** How far ahead an event may be to be reschedulable by title. */
const SEARCH_DAYS = 14;

export interface ProposalContext {
  db: Db;
  userId: string;
  timezone: string;
  google: GoogleConfig | null;
  /** APPROVAL_TTL_MINUTES — how long the Approve button stays valid. */
  approvalTtlMinutes: number;
  now?: Date;
}

/**
 * Turn "move the board review to Friday 10am" into a stored proposal.
 *
 * This function never writes to Google. It reads the event (to refuse what
 * cannot be changed and to capture the ETag the user is approving), checks the
 * new slot for overlaps, and stops. Execution lives in decisions.ts.
 */
export async function proposeEventChange(
  ctx: ProposalContext,
  args: Record<string, unknown>,
): Promise<ProposeEventChangeResult> {
  const now = ctx.now ?? new Date();
  const account = await requireGoogleAccount(ctx.db, ctx.userId);
  if (!ctx.google) {
    throw new Error(
      "Calendar changes are not configured on this server (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY).",
    );
  }
  const client = await connectedGoogleClient(ctx.google, ctx.db, account);

  const givenId = typeof args.event_id === "string" ? args.event_id.trim() : "";
  const query = typeof args.event === "string" ? args.event.trim() : "";

  let eventId = givenId;
  if (!eventId) {
    if (!query) throw new Error("Which event should I move?");
    const rows = await listUpcomingEvents(
      ctx.db,
      ctx.userId,
      now,
      new Date(now.getTime() + SEARCH_DAYS * 86_400_000),
      200,
    );
    const needle = query.toLowerCase();
    const matches = rows.filter((e) => e.title.toLowerCase().includes(needle));
    if (matches.length === 0) {
      throw new Error(`I couldn't find an event matching "${query}".`);
    }
    if (matches.length > 1) {
      const names = matches.slice(0, 3).map((m) => m.title).join(", ");
      throw new Error(`That matches ${matches.length} events (${names}). Which one?`);
    }
    eventId = matches[0].external_id;
  }

  // Read it from Google, not from our copy: the refusal rules and the ETag
  // must reflect the provider's current state.
  const detail = await client.getEvent(eventId);
  if (!detail) throw new Error("That event is no longer in your Google Calendar.");

  const before = detail.event;
  if (detail.rawStatus === "cancelled") {
    throw new Error(`"${before.title}" is cancelled, so there is nothing to move.`);
  }
  if (before.allDay) {
    throw new Error(`"${before.title}" is an all-day event — I can only reschedule timed events.`);
  }
  if (before.start.getTime() < now.getTime()) {
    throw new Error(`"${before.title}" already started (${formatRange(before.start, before.end, ctx.timezone)}), so it can't be moved.`);
  }
  if (!detail.organizerSelf && !detail.guestsCanModify) {
    throw new Error(`You don't have edit rights on "${before.title}" — Google would refuse the change.`);
  }

  const startValue = typeof args.start === "string" ? args.start.trim() : "";
  if (!startValue) throw new Error("What new time should I propose?");
  const afterStart = parseWhen(startValue, ctx.timezone);
  const afterEnd = args.end
    ? parseWhen(String(args.end), ctx.timezone)
    : new Date(afterStart.getTime() + (before.end.getTime() - before.start.getTime()));
  if (afterEnd.getTime() <= afterStart.getTime()) {
    throw new Error("The new end time must be after the new start time.");
  }
  if (afterStart.getTime() <= now.getTime()) {
    throw new Error("That new time is in the past — give me a time still ahead.");
  }

  // Overlap warning against Google's own view of the new day.
  const dateStr = todayInTz(ctx.timezone, afterStart);
  const dayStart = startOfDayInTz(dateStr, ctx.timezone);
  const dayEnd = startOfDayInTz(addDaysToDateStr(dateStr, 1), ctx.timezone);
  const sameDay = await client.listEvents(dayStart, dayEnd);
  const overlaps = sameDay.filter(
    (e) =>
      e.externalId !== eventId &&
      e.status !== "cancelled" &&
      !e.allDay &&
      e.start < afterEnd &&
      e.end > afterStart,
  );
  const conflictWarning =
    overlaps.length === 0
      ? null
      : `This overlaps "${overlaps[0].title}" (${formatRange(overlaps[0].start, overlaps[0].end, ctx.timezone)})${overlaps.length > 1 ? ` and ${overlaps.length - 1} more` : ""}.`;

  const attendees = detail.attendees;
  const payload: ProposalPayload = {
    eventId,
    calendarId: account.calendar_id,
    title: before.title,
    before: {
      start: before.start.toISOString(),
      end: before.end.toISOString(),
    },
    after: {
      start: afterStart.toISOString(),
      end: afterEnd.toISOString(),
    },
    etag: detail.etag,
    timezone: ctx.timezone,
    attendees,
    sendUpdates: attendees > 0 ? "all" : "none",
  };

  const expiresAt = new Date(now.getTime() + ctx.approvalTtlMinutes * 60_000);
  const proposal = await createProposal(ctx.db, {
    userId: ctx.userId,
    payload,
    payloadHash: hashPayload(payload),
    expiresAt,
  });

  const lines = [
    `Proposed change: "${before.title}"`,
    `Now: ${formatRange(before.start, before.end, ctx.timezone)}`,
    `New: ${formatRange(afterStart, afterEnd, ctx.timezone)}`,
    attendees > 0
      ? `${attendees} guest${attendees === 1 ? "" : "s"} will be notified by Google.`
      : "No guests to notify.",
    conflictWarning ? `⚠️ ${conflictWarning}` : "",
    `Nothing changes until you approve. This expires in ${ctx.approvalTtlMinutes} minutes.`,
  ].filter(Boolean);

  return {
    proposalId: proposal.id,
    message: lines.join("\n"),
    before: payload.before,
    after: payload.after,
    conflictWarning,
    attendees,
    notifiesAttendees: attendees > 0,
    expiresInMinutes: ctx.approvalTtlMinutes,
  };
}
