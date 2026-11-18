/**
 * Deterministic intent router for the two calendar actions that must never be
 * guessed: cancelling an event and moving one. The model's job is language, not
 * deciding which write the user meant — a cancellation the model turns into a
 * reschedule (or the reverse) is exactly the failure we cannot have.
 *
 * Approve/Reject is not routed here: it is handled before this point, by the
 * decision handler that owns ownership, expiry and the payload hash.
 */

export type CalendarRouteName =
  | "propose_event_change"
  | "propose_event_cancellation";

export interface CalendarRoute {
  name: CalendarRouteName;
  args: Record<string, unknown>;
}

/** Words that name no event on their own — "cancel that" must ask, not guess. */
const PRONOUN = /^(?:it|that|this|them|those|these)$/i;

/** "my"/"the" and a trailing "meeting" carry no identity — strip, then match. */
function cleanEventPhrase(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:my|the|our|all|of)\s+/i, "")
    .replace(/\s+(?:meeting|event|appointment|invite)$/i, "")
    .replace(/[.!?]+$/, "")
    // "cancel the meeting" names nothing; ask instead of guessing.
    .replace(/^(?:meeting|event|appointment|invite|schedule)$/i, "")
    .trim();
}

/**
 * `"cancel my meeting with Ada"` → propose_event_cancellation{event}
 * `"move the board review to 4pm"`  → propose_event_change{event, start}
 *
 * Returns null when the message does not name both the action and its target,
 * so ordinary conversation still reaches the model.
 */
export function routeCalendarIntent(text: string): CalendarRoute | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const cancelVerb = /^(?:please\s+)?(?:cancel|delete|remove)\b/i;
  if (cancelVerb.test(trimmed)) {
    const event = cleanEventPhrase(trimmed.replace(cancelVerb, ""));
    if (!event || PRONOUN.test(event)) return null;
    return { name: "propose_event_cancellation", args: { event } };
  }

  const move =
    /^(?:please\s+)?(?:move|reschedule|shift|push|postpone)\b\s+(.+?)\s+to\s+(.+)$/i.exec(
      trimmed,
    );
  if (move) {
    const event = cleanEventPhrase(move[1]);
    const start = move[2].trim().replace(/[.!?]+$/, "");
    if (!event || PRONOUN.test(event) || !start) return null;
    return { name: "propose_event_change", args: { event, start } };
  }

  return null;
}
