/**
 * Deterministic intent router for the two calendar actions that must never be
 * guessed: cancelling an event and moving one. The model's job is language, not
 * deciding which write the user meant — a cancellation the model turns into a
 * reschedule (or the reverse) is exactly the failure we cannot have.
 *
 * A message is split into structured operations first, so one compound request
 * (\"cancel A and move B to 10am tomorrow\") becomes two independent proposals
 * instead of one nonsense event title.
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

export type CalendarAction = "cancel" | "move";

/**
 * One thing the user asked for. `event` is null when the message refers to an
 * event indirectly (\"the first one\", \"the 9 PM one\", \"it\"): resolution then
 * happens against the most recent listing, never by guessing.
 */
export interface CalendarOperation {
  action: CalendarAction;
  /** Cleaned title fragment, or null when only a time/ordinal/pronoun is given. */
  event: string | null;
  /** A clock that helps identify the event, e.g. \"21:00\" or \"9 PM\". */
  time?: string;
  /** 1-based position in the last listing (\"the second one\"); -1 for \"last\". */
  ordinal?: number;
  /** Raw new-start phrase for a move, resolved in the user's timezone later. */
  start?: string;
}

export interface CalendarIntent {
  operations: CalendarOperation[];
}

/** Words that name no event on their own — \"cancel that\" must ask, not guess. */
const PRONOUN = /^(?:it|that|this|them|those|these|one)$/i;

/** A bare noun for \"the thing we were just talking about\", not a title. */
const GENERIC = /^(?:meeting|meetings|event|events|appointment|appointments|invite|schedule)$/i;

const CANCEL_VERB = "cancel|delete|remove|drop|call\\s+off";
const MOVE_VERB = "move|reschedule|shift|push|postpone|bring\\s+forward";

/**
 * A verb only starts a new action when it sits at the start of the message or
 * after a conjunction/separator. This is what keeps \"Research and Development
 * sync\" and \"move planning meeting\" from being split into pieces.
 */
const ACTION_VERB = new RegExp(
  `\\b(${CANCEL_VERB}|${MOVE_VERB})\\b`,
  "gi",
);

const SEGMENT_LEAD_IN =
  /(?:^|[\s,;.!?&+\-])(?:(?:and|then|also|plus|please|now)\s+)*$/i;

const CANCEL_ONLY = new RegExp(`^(?:${CANCEL_VERB})$`, "i");
const MOVE_ONLY = new RegExp(`^(?:${MOVE_VERB})$`, "i");

interface VerbHit {
  action: CalendarAction;
  start: number;
  end: number;
}

function findActions(text: string): VerbHit[] {
  const hits: VerbHit[] = [];
  ACTION_VERB.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ACTION_VERB.exec(text)) !== null) {
    const before = text.slice(0, match.index);
    if (before.trim() !== "" && !SEGMENT_LEAD_IN.test(before)) continue;
    hits.push({
      action: CANCEL_ONLY.test(match[0]) ? "cancel" : "move",
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return hits;
}

/** Drop the conjunction/separator that joined this segment to the next one. */
function trimSegmentTail(raw: string): string {
  let out = raw.trim();
  let previous = "";
  while (out !== previous) {
    previous = out;
    out = out
      .replace(/[\s,;.!?&+\-–—]+$/, "")
      .replace(/\b(?:and|then|also|plus|please|now|instead)\s*$/i, "")
      .trim();
  }
  return out;
}

/** Presentation-only noise: \"(22:00 UTC)\" is not part of a title. */
function stripPresentation(raw: string): string {
  return raw
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CLOCK = String.raw`\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?`;
const CLOCK_PHRASE = new RegExp(
  String.raw`(?:^|[\s,;(])(?:(?:at|by|around|@|from)\s+)?(${CLOCK})(?=$|[\s,;).])`,
  "i",
);
const CLOCK_PHRASE_GLOBAL = new RegExp(
  String.raw`(?:^|[\s,;(])(?:(?:at|by|around|@|from)\s+)?${CLOCK}(?=$|[\s,;).])`,
  "gi",
);

/** A clock the user mentioned, kept verbatim for the resolver to interpret. */
function clockHint(raw: string): string | undefined {
  const match = CLOCK_PHRASE.exec(raw);
  return match ? match[1].trim() : undefined;
}

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  "1st": 1,
  second: 2,
  "2nd": 2,
  third: 3,
  "3rd": 3,
  fourth: 4,
  "4th": 4,
  last: -1,
};

const ORDINAL_PHRASE =
  /\b(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|last)\s+(?:one|event|meeting|appointment|invite)\b/i;

function ordinalHint(raw: string): number | undefined {
  const match = ORDINAL_PHRASE.exec(raw);
  return match ? ORDINAL_WORDS[match[1].toLowerCase()] : undefined;
}

/** Reduce a cleaned phrase to the event name it actually contains. */
function cleanEventPhrase(raw: string): string | null {
  let text = stripPresentation(raw)
    .replace(ORDINAL_PHRASE, " ")
    .replace(CLOCK_PHRASE_GLOBAL, " ")
    .replace(/^(?:the|my|our|all|of|that|this)\s+/i, "")
    .replace(/^(?:the|my|our|all|of|that|this)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!text) return null;
  if (PRONOUN.test(text) || GENERIC.test(text)) return null;
  return text;
}

function parseCancel(segment: string): CalendarOperation | null {
  const body = trimSegmentTail(segment);
  const time = clockHint(body);
  const ordinal = ordinalHint(body);
  const event = cleanEventPhrase(body);
  if (!event && !time && !ordinal) return null;
  return {
    action: "cancel",
    event,
    ...(time ? { time } : {}),
    ...(ordinal !== undefined ? { ordinal } : {}),
  };
}

/** Where the new start begins when the user omits \"to\" (\"move it 4pm\"). */
const TIME_START =
  /\b(?:tomorrow|today|tonight|day\s+after\s+tomorrow|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|next\s+(?:week|month)|at\s+\d{1,2}|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/i;

function parseMove(segment: string): CalendarOperation | null {
  const body = trimSegmentTail(segment);
  let eventPart: string | null = null;
  let startPart: string | null = null;

  // Greedy so a title containing \"to\" keeps it: the last \"to\" introduces
  // the new time, not the first one.
  const explicit = /^(.+)\s+(?:to|until)\s+(.+)$/i.exec(body);
  if (explicit) {
    eventPart = explicit[1];
    startPart = explicit[2];
  } else {
    const bare = TIME_START.exec(body);
    if (bare) {
      eventPart = body.slice(0, bare.index);
      startPart = body.slice(bare.index);
    }
  }
  if (!startPart) return null;

  const start = startPart.trim().replace(/[.!?]+$/, "").trim();
  if (!start) return null;

  const ordinal = ordinalHint(eventPart ?? "");
  const event = cleanEventPhrase(eventPart ?? "");
  return {
    action: "move",
    event,
    start,
    ...(ordinal !== undefined ? { ordinal } : {}),
  };
}

/**
 * Turn a message into its calendar operations.
 *
 * Examples:
 *   \"Remove Future Africa meeting and move L2e meeting to 10a.m tomorrow\"
 *     → [{cancel, event: \"Future Africa meeting\"},
 *        {move, event: \"L2e meeting\", start: \"10a.m tomorrow\"}]
 *   \"Remove the event by 21:00\"
 *     → [{cancel, event: null, time: \"21:00\"}]
 *   \"Remove 21:00 Future Africa meeting (22:00 UTC)\"
 *     → [{cancel, event: \"Future Africa meeting\", time: \"21:00\"}]
 *
 * Returns no operations when the message does not name both an action and a
 * way to find its target, so ordinary conversation still reaches the model.
 */
export function parseCalendarIntent(text: string): CalendarIntent {
  const trimmed = text.trim();
  if (!trimmed) return { operations: [] };

  const hits = findActions(trimmed);
  if (hits.length === 0) return { operations: [] };

  const operations: CalendarOperation[] = [];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const end = i + 1 < hits.length ? hits[i + 1].start : trimmed.length;
    const segment = trimmed.slice(hit.end, end);
    const operation =
      hit.action === "cancel" ? parseCancel(segment) : parseMove(segment);
    if (operation) operations.push(operation);
  }

  return { operations };
}

function toRoute(operation: CalendarOperation): CalendarRoute {
  if (operation.action === "cancel") {
    return {
      name: "propose_event_cancellation",
      args: {
        event: operation.event ?? "",
        ...(operation.time ? { time: operation.time } : {}),
        ...(operation.ordinal !== undefined ? { ordinal: operation.ordinal } : {}),
      },
    };
  }
  return {
    name: "propose_event_change",
    args: {
      event: operation.event ?? "",
      start: operation.start,
      ...(operation.ordinal !== undefined ? { ordinal: operation.ordinal } : {}),
    },
  };
}

/**
 * Backwards-compatible single-route view: the first operation when the message
 * contains exactly one unambiguous action. Compound messages must go through
 * {@link parseCalendarIntent} so no action is silently dropped.
 */
export function routeCalendarIntent(text: string): CalendarRoute | null {
  const { operations } = parseCalendarIntent(text);
  if (operations.length !== 1) return null;
  return toRoute(operations[0]);
}
