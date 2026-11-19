import {
  createProposal,
  focusEventReference,
  hashPayload,
  listEventReferences,
  listUpcomingEvents,
  type Db,
  type ProposalPayload,
} from "@exec-assistant/db";
import {
  addDaysToDateStr,
  clockInTz,
  parseSpokenWhen,
  startOfDayInTz,
  todayInTz,
  type CalendarClient,
  type CalendarEvent,
} from "@exec-assistant/calendar";
import type {
  ProposeEventCancellationResult,
  ProposeEventChangeResult,
} from "@exec-assistant/ai";
import {
  connectedGoogleClient,
  requireGoogleAccount,
  type GoogleConfig,
} from "./calendar-access.js";
import {
  lookupEvent,
  type LookupCandidate,
} from "./event-lookup.js";
import { formatInstant, formatRange } from "./when.js";

/** How far ahead an event may be to be reschedulable by title. */
const SEARCH_DAYS = 14;

/** How long a listing stays usable as conversational context. */
const CONTEXT_MAX_AGE_MINUTES = 720;

/** A bare pronoun names no event — the last focused/listed one does. */
const PRONOUN = /^(?:it|that|this|them|those|these|one)$/i;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOrdinal(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n !== 0 ? n : null;
}

function candidateFrom(row: {
  external_id?: string;
  externalId?: string;
  title: string;
  start_at?: Date | string;
  start?: Date;
}): LookupCandidate | null {
  const id = row.external_id ?? row.externalId;
  const start = row.start_at ?? row.start;
  if (!id || !start) return null;
  const date = start instanceof Date ? start : new Date(start);
  if (Number.isNaN(date.getTime())) return null;
  return { id, title: row.title, start: date };
}

function uniqueCandidates(candidates: Array<LookupCandidate | null>): LookupCandidate[] {
  const byId = new Map<string, LookupCandidate>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    // The provider's fresh copy wins over the stored listing copy.
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  return [...byId.values()];
}

function describeAmbiguous(
  candidates: LookupCandidate[],
  timezone: string,
): string {
  const shown = candidates
    .slice(0, 4)
    .map((c) => `${c.title} (${formatInstant(c.start, timezone)})`)
    .join(", ");
  return `That matches ${candidates.length} events (${shown}). Which one?`;
}

/**
 * Resolve "which event" once, for both proposals.
 *
 * An explicit stable id wins. Otherwise the message is matched against the
 * provider's current events plus the last listing the user was shown, using
 * normalized titles, partial titles, clock hints and positions. A tie is
 * always a question — never the first search result.
 */
async function resolveEventId(
  ctx: ProposalContext,
  args: Record<string, unknown>,
  now: Date,
  intent: "move" | "cancel",
  client: CalendarClient,
): Promise<string> {
  const givenId = asText(args.event_id);
  if (givenId) {
    await focusEventReference(ctx.db, ctx.userId, givenId).catch(() => {});
    return givenId;
  }

  const rawQuery = asText(args.event);
  const query = PRONOUN.test(rawQuery) ? "" : rawQuery;
  const time = asText(args.time) || null;
  const ordinal = asOrdinal(args.ordinal);

  const references = await listEventReferences(
    ctx.db,
    ctx.userId,
    CONTEXT_MAX_AGE_MINUTES,
  );
  // The listing the user is looking at is the best context for ordinals and
  // times; the provider is authoritative for the event itself.
  const referenceCandidates = uniqueCandidates(
    references.map((row) => candidateFrom(row)),
  );

  let providerEvents: CalendarEvent[] = [];
  try {
    providerEvents = await client.listEvents(
      now,
      new Date(now.getTime() + SEARCH_DAYS * 86_400_000),
    );
  } catch (err) {
    // Fall back to the copy synced into Postgres rather than failing closed.
    console.error(
      `[proposal] could not list Google events for ${ctx.userId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  let localRows: Array<{ external_id: string; title: string; start_at: Date }> = [];
  if (providerEvents.length === 0) {
    localRows = await listUpcomingEvents(
      ctx.db,
      ctx.userId,
      now,
      new Date(now.getTime() + SEARCH_DAYS * 86_400_000),
      200,
    );
  }

  const providerCandidates = uniqueCandidates(providerEvents.map((e) => candidateFrom(e)));
  const localCandidates = uniqueCandidates(localRows.map((e) => candidateFrom(e)));
  const all = uniqueCandidates([
    ...providerCandidates,
    ...referenceCandidates,
    ...localCandidates,
  ]);

  // A pronoun with no title, time or position: one safe antecedent only.
  if (!query && !time && ordinal === null) {
    const focused = references
      .filter((row) => row.focused_at !== null)
      .sort((a, b) => b.focused_at!.getTime() - a.focused_at!.getTime())[0];
    if (focused) return focused.external_id;
    if (references.length === 1) return references[0].external_id;
    throw new Error(
      references.length > 1
        ? `Which event do you mean? ${describeAmbiguous(referenceCandidates, ctx.timezone)}`
        : intent === "cancel"
          ? "Which event should I cancel?"
          : "Which event should I move?",
    );
  }

  // An ordinal is a position in the last listing, so it resolves there first.
  const pool =
    ordinal !== null && referenceCandidates.length > 0
      ? referenceCandidates
      : all;

  const result = lookupEvent(pool, { text: query, time, ordinal }, ctx.timezone);
  if (result.kind === "matched") {
    await focusEventReference(ctx.db, ctx.userId, result.candidate.id).catch(() => {});
    return result.candidate.id;
  }
  if (result.kind === "ambiguous") {
    throw new Error(describeAmbiguous(result.candidates, ctx.timezone));
  }
  if (query) {
    throw new Error(`I couldn't find an event matching "${query}".`);
  }
  if (time) {
    throw new Error(`I couldn't find an event at ${time}.`);
  }
  throw new Error(
    ordinal !== null
      ? `There is no event at position ${ordinal} in the last list.`
      : intent === "cancel"
        ? "Which event should I cancel?"
        : "Which event should I move?",
  );
}

/**
 * Interpret the new start phrase in the user's timezone, once: "10a.m
 * tomorrow" becomes 10:00 local tomorrow. A day-only phrase ("tomorrow")
 * keeps the event's current clock time.
 */
function parseNewStart(
  value: string,
  eventStart: Date,
  timezone: string,
  now: Date,
): Date {
  const trimmed = value.trim();
  const hasClock =
    /\d/.test(trimmed) || /\b(?:noon|midday|midnight)\b/i.test(trimmed);
  if (!hasClock) {
    // "tomorrow", "next friday": same time of day, different date.
    return parseSpokenWhen(
      `${trimmed} at ${clockInTz(eventStart, timezone)}`,
      timezone,
      now,
    );
  }
  return parseSpokenWhen(trimmed, timezone, now);
}

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

  const eventId = await resolveEventId(ctx, args, now, "move", client);

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
  const afterStart = parseNewStart(startValue, before.start, ctx.timezone, now);
  const afterEnd = args.end
    ? parseSpokenWhen(String(args.end), ctx.timezone, now)
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
    action: "reschedule",
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
    after: payload.after as { start: string; end: string },
    conflictWarning,
    attendees,
    notifiesAttendees: attendees > 0,
    expiresInMinutes: ctx.approvalTtlMinutes,
  };
}

/**
 * Turn "cancel my Trials Students meeting" into a stored proposal.
 *
 * Like a reschedule, this never writes to Google: it reads the event to refuse
 * what cannot be cancelled and to capture the ETag the user is approving, then
 * stops. The delete happens in decisions.ts, only after an explicit approval.
 */
export async function proposeEventCancellation(
  ctx: ProposalContext,
  args: Record<string, unknown>,
): Promise<ProposeEventCancellationResult> {
  const now = ctx.now ?? new Date();
  const account = await requireGoogleAccount(ctx.db, ctx.userId);
  if (!ctx.google) {
    throw new Error(
      "Calendar changes are not configured on this server (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY).",
    );
  }
  const client = await connectedGoogleClient(ctx.google, ctx.db, account);

  const eventId = await resolveEventId(ctx, args, now, "cancel", client);

  const detail = await client.getEvent(eventId);
  if (!detail) throw new Error("That event is no longer in your Google Calendar.");

  const before = detail.event;
  if (detail.rawStatus === "cancelled") {
    throw new Error(`"${before.title}" is already cancelled.`);
  }
  if (before.end.getTime() <= now.getTime()) {
    throw new Error(
      `"${before.title}" is already over (${formatRange(before.start, before.end, ctx.timezone)}), so there is nothing to cancel.`,
    );
  }
  if (!detail.organizerSelf && !detail.guestsCanModify) {
    throw new Error(`You don't have edit rights on "${before.title}" — Google would refuse the change.`);
  }

  const attendees = detail.attendees;
  const payload: ProposalPayload = {
    action: "cancellation",
    eventId,
    calendarId: account.calendar_id,
    title: before.title,
    before: {
      start: before.start.toISOString(),
      end: before.end.toISOString(),
    },
    etag: detail.etag,
    timezone: ctx.timezone,
    attendees,
    sendUpdates: attendees > 0 ? "all" : "none",
  };

  const expiresAt = new Date(now.getTime() + ctx.approvalTtlMinutes * 60_000);
  const proposal = await createProposal(ctx.db, {
    userId: ctx.userId,
    kind: "cancellation",
    payload,
    payloadHash: hashPayload(payload),
    expiresAt,
  });

  const lines = [
    `Proposed cancellation: "${before.title}"`,
    `When: ${formatRange(before.start, before.end, ctx.timezone)}`,
    attendees > 0
      ? `${attendees} guest${attendees === 1 ? "" : "s"} will be notified by Google.`
      : "No guests to notify.",
    "Nothing changes until you approve. This expires in " +
      `${ctx.approvalTtlMinutes} minutes.`,
  ];

  return {
    proposalId: proposal.id,
    message: lines.join("\n"),
    before: payload.before,
    attendees,
    notifiesAttendees: attendees > 0,
    expiresInMinutes: ctx.approvalTtlMinutes,
  };
}
