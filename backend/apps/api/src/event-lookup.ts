import { clockInTz } from "@exec-assistant/calendar";

/**
 * Event resolution is matching, not string equality. Chat inputs carry
 * presentation noise ("21:00", "(22:00 UTC)", straight vs curly punctuation)
 * and people refer to events by a distinctive fragment, by time, or by their
 * position in the last list. This module decides which event was meant — and
 * refuses to pick when more than one event still fits.
 */

export interface LookupCandidate {
  /** Stable provider id (Google's event id) — what a proposal stores. */
  id: string;
  title: string;
  start: Date;
}

export interface LookupQuery {
  /** Title fragment the user typed, already stripped of presentation noise. */
  text?: string | null;
  /** Clock the user mentioned, e.g. "9 PM" or "21:00". */
  time?: string | null;
  /** 1-based position in the listing; -1 means "the last one". */
  ordinal?: number | null;
}

export type LookupResult =
  | { kind: "matched"; candidate: LookupCandidate; score: number }
  | { kind: "ambiguous"; candidates: LookupCandidate[] }
  | { kind: "none" };

export const SCORE_EXACT = 100;
export const SCORE_PREFIX = 80;
export const SCORE_CONTAINS = 70;
export const SCORE_TOKENS = 60;

/**
 * Reduce a title to the words that identify it: no case, no punctuation, no
 * parenthetical annotations, no clock times and no timezone labels. Both the
 * query and the stored title go through this, so "Standup (22:00 UTC)" and
 * "standup" are the same event.
 */
export function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:utc|gmt)\s*[+-]?\d{0,2}(?::?\d{2})?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "9 PM" / "21:00" / "9p.m." → "21:00" in 24h form; null when unreadable. */
export function parseClockHint(raw: string): string | null {
  const match = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(
    raw.trim(),
  );
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase().replace(/\./g, "");
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hour)}:${pad(minute)}`;
}

function scoreTitle(title: string, query: string): number {
  const candidate = normalizeTitle(title);
  if (!candidate || !query) return 0;
  if (candidate === query) return SCORE_EXACT;
  if (candidate.startsWith(query) || query.startsWith(candidate)) {
    return SCORE_PREFIX;
  }
  if (candidate.includes(query)) return SCORE_CONTAINS;
  const queryTokens = query.split(" ").filter(Boolean);
  const candidateTokens = new Set(candidate.split(" ").filter(Boolean));
  if (
    queryTokens.length > 0 &&
    queryTokens.every((token) => candidateTokens.has(token))
  ) {
    return SCORE_TOKENS;
  }
  return 0;
}

function byStart(a: LookupCandidate, b: LookupCandidate): number {
  return a.start.getTime() - b.start.getTime();
}

/**
 * Resolve one event from a candidate set. No branch ever falls back to "the
 * first result": a tie is `ambiguous` and the caller must ask.
 */
export function lookupEvent(
  candidates: LookupCandidate[],
  query: LookupQuery,
  timezone: string,
): LookupResult {
  if (candidates.length === 0) return { kind: "none" };

  // Position in the last listing is exact and needs no title matching.
  if (query.ordinal !== null && query.ordinal !== undefined) {
    const ordered = [...candidates].sort(byStart);
    const index = query.ordinal > 0 ? query.ordinal - 1 : ordered.length - 1;
    const candidate = ordered[index];
    if (!candidate) return { kind: "none" };
    return { kind: "matched", candidate, score: SCORE_EXACT };
  }

  let pool = candidates;
  let bestScore = 0;
  const text = query.text?.trim() ? normalizeTitle(query.text) : "";

  if (text) {
    const scored = pool
      .map((candidate) => ({ candidate, score: scoreTitle(candidate.title, text) }))
      .filter((entry) => entry.score > 0);
    if (scored.length > 0) {
      bestScore = Math.max(...scored.map((entry) => entry.score));
      pool = scored
        .filter((entry) => entry.score === bestScore)
        .map((entry) => entry.candidate);
      if (pool.length === 1) {
        return { kind: "matched", candidate: pool[0], score: bestScore };
      }
    } else {
      pool = [];
    }
  }

  const clock = query.time ? parseClockHint(query.time) : null;
  if (clock) {
    if (pool.length === 0) pool = candidates;
    // Time is a second, independent way to identify the event: when a title
    // fragment was too broad, the clock narrows it to the one the user saw.
    const timed = pool.filter(
      (candidate) => clockInTz(candidate.start, timezone) === clock,
    );
    if (timed.length === 1) {
      return { kind: "matched", candidate: timed[0], score: bestScore + 20 };
    }
    if (timed.length > 1) return { kind: "ambiguous", candidates: timed };
    // Nothing is on at that clock. A title fragment that narrowed the field
    // is still a useful question to ask about; a pure clock reference is not.
    if (!text) return { kind: "none" };
    return pool.length > 1
      ? { kind: "ambiguous", candidates: pool }
      : { kind: "none" };
  }

  if (pool.length === 0) return { kind: "none" };
  if (pool.length === 1) {
    return { kind: "matched", candidate: pool[0], score: bestScore };
  }
  return { kind: "ambiguous", candidates: pool };
}
