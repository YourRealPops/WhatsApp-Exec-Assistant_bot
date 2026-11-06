import {
  DEFAULT_OFFSETS,
  claimProposal,
  expireProposal,
  failProposal,
  finishProposal,
  getProposal,
  hashPayload,
  listPendingProposals,
  logProposalEvent,
  materializeReminders,
  rejectProposal,
  upsertEvents,
  type Db,
  type Proposal,
  type ProposalPayload,
} from "@exec-assistant/db";
import {
  CalendarAuthError,
  EventConflictError,
  TransientCalendarError,
  GoogleEventDetail,
} from "@exec-assistant/calendar";
import type { AgentResult } from "@exec-assistant/ai";
import { connectedGoogleClient, requireGoogleAccount, type GoogleConfig } from "./calendar-access.js";
import { formatRange } from "./when.js";

/**
 * Approve/Reject handling is plain code, never a model turn. A reschedule that
 * a language model could talk itself into is exactly the failure we cannot
 * have, so the decision path checks ownership, status, expiry, payload
 * integrity and one-time use, then writes, then verifies by reading back.
 */

export interface DecisionDeps {
  db: Db;
  google: GoogleConfig | null;
  now?: () => Date;
}

export interface DecisionInput {
  userId: string;
  text: string;
  /** Button id from the webhook ("appr:<uuid>" / "rej:<uuid>"), when tapped. */
  replyId?: string | null;
}

export type DecisionAction = "approve" | "reject";

export interface ParsedDecision {
  action: DecisionAction;
  /** Present for button taps; absent for a typed yes/no. */
  proposalId?: string;
}

const BUTTON_ID = /^(appr|rej):([0-9a-f-]{36})$/i;

/**
 * A tap is unambiguous. Typed text only counts as a decision when exactly one
 * proposal is pending (checked by the caller), so ordinary chatter that starts
 * with "ok" can never execute a calendar change on its own.
 */
export function parseDecision(
  text: string,
  replyId?: string | null,
): ParsedDecision | null {
  const button = BUTTON_ID.exec((replyId ?? "").trim());
  if (button) {
    return {
      action: button[1].toLowerCase() === "appr" ? "approve" : "reject",
      proposalId: button[2],
    };
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^(yes|y|yeah|yep|yup|approve|approved|ok|okay|confirm|do it|go ahead)\b/i.test(trimmed) && !/\bno\b/i.test(trimmed)) {
    return { action: "approve" };
  }
  if (/^(no|n|nope|reject|rejected|cancel|don'?t|stop)\b/i.test(trimmed)) {
    return { action: "reject" };
  }
  return null;
}

function message(reply: string): AgentResult {
  return { reply, toolCalls: [], mode: "decision" };
}

function stateReply(proposal: Proposal): AgentResult {
  const title = proposal.payload.title;
  switch (proposal.status) {
    case "succeeded":
      return message(`That change was already applied to "${title}".`);
    case "rejected":
      return message(`You already declined that change to "${title}" — nothing was written.`);
    case "expired":
      return message(`That request expired, so nothing was changed. Ask me again if you still want "${title}" moved.`);
    case "executing":
      return message(`I'm still working on "${title}" — give me a moment and check it again.`);
    case "failed":
      return message(
        `That change to "${title}" didn't go through${proposal.error ? ` (${proposal.error})` : ""}. Nothing was written.`,
      );
    default:
      return message(`That request is ${proposal.status}, so there is nothing to do.`);
  }
}

function currentState(
  detail: GoogleEventDetail | null,
  payload: ProposalPayload,
): string {
  if (!detail) return `"${payload.title}" is no longer in your Google Calendar.`;
  return `"${payload.title}" is still ${formatRange(detail.event.start, detail.event.end, payload.timezone)}.`;
}

interface ExecutionOutcome {
  ok: boolean;
  detail: GoogleEventDetail | null;
  reply: string;
  error?: string;
}

function wroteIntended(
  detail: GoogleEventDetail | null,
  payload: ProposalPayload,
): boolean {
  if (!detail) return false;
  return (
    detail.event.start.getTime() === new Date(payload.after.start).getTime() &&
    detail.event.end.getTime() === new Date(payload.after.end).getTime()
  );
}

/**
 * Apply one approved proposal and confirm it by reading the event back.
 * Every failure path reports the event's actual current state rather than
 * claiming success.
 */
async function executeProposal(
  deps: DecisionDeps,
  proposal: Proposal,
): Promise<ExecutionOutcome> {
  const payload = proposal.payload;

  let client: Awaited<ReturnType<typeof connectedGoogleClient>>;
  try {
    const account = await requireGoogleAccount(deps.db, proposal.user_id);
    if (!deps.google) {
      return {
        ok: false,
        detail: null,
        reply: "Nothing was changed: calendar writes are not configured on this server.",
        error: "google not configured",
      };
    }
    client = await connectedGoogleClient(deps.google, deps.db, account);
  } catch (err) {
    return {
      ok: false,
      detail: null,
      reply: `Nothing was changed: ${err instanceof Error ? err.message : String(err)}`,
      error: "no usable connection",
    };
  }

  let ambiguous = false;
  try {
    await client.patchEventTimes({
      eventId: payload.eventId,
      etag: payload.etag,
      start: new Date(payload.after.start),
      end: new Date(payload.after.end),
      sendUpdates: payload.sendUpdates,
    });
  } catch (err) {
    if (err instanceof EventConflictError) {
      const current = await client.getEvent(payload.eventId).catch(() => null);
      return {
        ok: false,
        detail: current,
        reply: `Nothing was changed: the event changed in Google since the proposal was made, so I did not overwrite it. ${currentState(current, payload)}`,
        error: "etag mismatch (event changed)",
      };
    }
    if (err instanceof CalendarAuthError) {
      return {
        ok: false,
        detail: null,
        reply:
          "Nothing was changed: Google rejected the calendar permission. Reconnect and I'll try again.",
        error: "google auth rejected",
      };
    }
    if (err instanceof TransientCalendarError) {
      // The write may have landed. Re-read before deciding anything.
      ambiguous = true;
    } else {
      const current = await client.getEvent(payload.eventId).catch(() => null);
      return {
        ok: false,
        detail: current,
        reply: `Nothing was changed: ${err instanceof Error ? err.message : String(err)}. ${currentState(current, payload)}`,
        error: err instanceof Error ? err.message : "provider error",
      };
    }
  }

  const verified = await client.getEvent(payload.eventId).catch(() => null);

  if (wroteIntended(verified, payload)) {
    return {
      ok: true,
      detail: verified,
      reply: `Done. Verified in Google Calendar: "${payload.title}" is now ${formatRange(new Date(payload.after.start), new Date(payload.after.end), payload.timezone)}.${
        payload.attendees > 0
          ? ` Google is notifying ${payload.attendees} guest${payload.attendees === 1 ? "" : "s"}.`
          : ""
      }`,
    };
  }

  return {
    ok: false,
    detail: verified,
    reply: ambiguous
      ? `I couldn't confirm the change: Google didn't answer cleanly and the event does not read as moved. ${currentState(verified, payload)}`
      : `Google accepted it but the event still reads differently. ${currentState(verified, payload)}`,
    error: ambiguous ? "unverified write (timeout/5xx)" : "verification mismatch",
  };
}

/**
 * Handle an approval or rejection. Returns null when the message isn't a
 * decision, so the normal conversation continues untouched.
 */
export async function handleDecision(
  deps: DecisionDeps,
  input: DecisionInput,
): Promise<AgentResult | null> {
  const parsed = parseDecision(input.text, input.replyId);
  if (!parsed) return null;
  const now = deps.now?.() ?? new Date();

  let proposal: Proposal | null = null;
  if (parsed.proposalId) {
    proposal = await getProposal(deps.db, parsed.proposalId);
    if (!proposal) {
      return message("I couldn't find that change request — it may have been deleted. Nothing was changed.");
    }
    // The tap must come from the chat that owns the proposal.
    if (proposal.user_id !== input.userId) {
      console.warn(
        `[decision] rejected tap on proposal ${proposal.id}: not the owner`,
      );
      return message("That button belongs to a different conversation. Nothing was changed.");
    }
  } else {
    const pending = await listPendingProposals(deps.db, input.userId, now);
    if (pending.length === 0) return null;
    if (pending.length > 1) {
      return message(
        `You have ${pending.length} changes waiting. Tap Approve or Reject on the one you mean — I won't guess.`,
      );
    }
    proposal = pending[0];
  }

  if (proposal.status !== "pending") return stateReply(proposal);

  if (proposal.expires_at.getTime() <= now.getTime()) {
    await failProposalSafely(deps, proposal, "expired", "expired");
    return message(
      `That request expired, so nothing was changed. Ask me again if you still want "${proposal.payload.title}" moved.`,
    );
  }

  // Integrity: what is stored must be exactly what was approved. A row edited
  // in the database is refused outright, never executed.
  if (hashPayload(proposal.payload) !== proposal.payload_hash) {
    const changed = await failProposal(deps.db, proposal.id, "payload integrity check failed")
      .then(() => true)
      .catch(() => false);
    await logProposalEvent(deps.db, {
      proposalId: proposal.id,
      from: "pending",
      to: "failed",
      detail: "payload hash mismatch",
    }).catch(() => {});
    console.error(
      `[decision] proposal ${proposal.id} payload does not match its hash — refused${changed ? "" : " (state unchanged)"}`,
    );
    return message(
      "I refused that one: the stored request doesn't match what you approved, so nothing was changed.",
    );
  }

  if (parsed.action === "reject") {
    const rejected = await rejectProposal(deps.db, {
      id: proposal.id,
      userId: input.userId,
      now,
    });
    if (!rejected) {
      const fresh = await getProposal(deps.db, proposal.id);
      return fresh ? stateReply(fresh) : message("That request is no longer pending. Nothing was changed.");
    }
    await logProposalEvent(deps.db, {
      proposalId: proposal.id,
      from: "pending",
      to: "rejected",
      detail: "rejected by user",
    }).catch(() => {});
    return message(
      `Cancelled — nothing was changed. ${currentStateFromPayload(proposal.payload)}`,
    );
  }

  // One-time use: exactly one caller can move pending → executing.
  const claimed = await claimProposal(deps.db, {
    id: proposal.id,
    userId: input.userId,
    now,
  });
  if (!claimed) {
    const fresh = await getProposal(deps.db, proposal.id);
    return fresh ? stateReply(fresh) : message("That request is no longer pending. Nothing was changed.");
  }
  await logProposalEvent(deps.db, {
    proposalId: claimed.id,
    from: "pending",
    to: "executing",
    detail: "approved by user",
  }).catch(() => {});

  // Re-check the claimed copy: the claim is a new read of the row.
  if (hashPayload(claimed.payload) !== claimed.payload_hash) {
    await failProposal(deps.db, claimed.id, "payload integrity check failed");
    return message(
      "I refused that one: the stored request doesn't match what you approved, so nothing was changed.",
    );
  }

  const outcome = await executeProposal(deps, claimed);

  if (!outcome.ok) {
    await finishProposal(deps.db, claimed.id, {
      status: "failed",
      error: outcome.error ?? "execution failed",
    });
    await logProposalEvent(deps.db, {
      proposalId: claimed.id,
      from: "executing",
      to: "failed",
      detail: outcome.error ?? null,
    }).catch(() => {});
    return message(outcome.reply);
  }

  const detail = outcome.detail as GoogleEventDetail;
  await finishProposal(deps.db, claimed.id, {
    status: "succeeded",
    providerResult: {
      start: detail.event.start.toISOString(),
      end: detail.event.end.toISOString(),
      etag: detail.etag,
    },
  });
  await logProposalEvent(deps.db, {
    proposalId: claimed.id,
    from: "executing",
    to: "succeeded",
    detail: "verified in google calendar",
  }).catch(() => {});

  // Keep our copy in step so the reminder ladder moves with the event.
  try {
    const [saved] = await upsertEvents(deps.db, claimed.user_id, [
      {
        externalId: detail.event.externalId,
        title: detail.event.title,
        start: detail.event.start,
        end: detail.event.end,
        allDay: detail.event.allDay ?? false,
        location: detail.event.location ?? null,
        description: detail.event.description ?? null,
        status: detail.event.status,
      },
    ]);
    if (saved) {
      await materializeReminders(
        deps.db,
        {
          id: saved.id,
          userId: claimed.user_id,
          startAt: saved.start_at,
          allDay: saved.all_day,
        },
        DEFAULT_OFFSETS,
      );
    }
  } catch (err) {
    console.error(
      `[decision] local event refresh failed after ${claimed.id} succeeded:`,
      err instanceof Error ? err.message : err,
    );
  }

  return message(outcome.reply);
}

/** Before the event has been touched we only have the proposed "before" state. */
function currentStateFromPayload(payload: ProposalPayload): string {
  return `"${payload.title}" is still ${formatRange(new Date(payload.before.start), new Date(payload.before.end), payload.timezone)}.`;
}

async function failProposalSafely(
  deps: DecisionDeps,
  proposal: Proposal,
  error: string,
  detail: string,
): Promise<void> {
  try {
    await expireProposal(deps.db, proposal.id);
    await logProposalEvent(deps.db, {
      proposalId: proposal.id,
      from: "pending",
      to: "expired",
      detail,
    });
  } catch (err) {
    console.error(
      `[decision] could not expire proposal ${proposal.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
