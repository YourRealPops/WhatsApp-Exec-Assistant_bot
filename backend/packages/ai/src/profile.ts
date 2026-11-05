/**
 * Name/designation parsing for onboarding.
 *
 * ECOS opens by asking for a name and designation, so the message that follows
 * is usually the profile answer. With an LLM key the model routes that through
 * `save_profile`; the no-key fallback has no model to lean on, so this small
 * parser reads the two shapes worth supporting: an explicit statement ("my name
 * is Ada", "call me Ada") and a bare "Name, Designation" answer.
 *
 * It is deliberately conservative — a doubtful parse returns null and the turn
 * is handled as ordinary conversation, because storing a wrong name and then
 * using it forever is worse than asking again.
 */

export interface ProfileCandidate {
  name: string;
  designation: string | null;
  /** True for "my name is …" / "call me …", false for a bare "Name, Role". */
  explicit: boolean;
}

const MAX_NAME_LENGTH = 60;
const MAX_NAME_WORDS = 5;
const MAX_DESIGNATION_LENGTH = 80;

const FILLERS =
  /^(?:hi|hello|hey|sure|ok|okay|alright|yes|yeah|yep|well)\b[,.:!\s]*/i;

const EXPLICIT =
  /^(?:my name(?:'s| is)|call me|i am|i'm|im|this is)\s+(.+)$/i;

/** Lowercase name particles: "Ada de la Cruz". */
const PARTICLES = new Set([
  "de",
  "del",
  "la",
  "le",
  "van",
  "von",
  "da",
  "di",
  "bin",
  "al",
  "dos",
  "das",
  "san",
]);

function clean(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[.!?,;:]+$/, "").trim();
}

function isNameWord(word: string): boolean {
  return /^\p{Lu}[\p{L}'’.`-]*$/u.test(word) || PARTICLES.has(word.toLowerCase());
}

function isName(value: string): boolean {
  const words = value.split(" ").filter(Boolean);
  return (
    words.length > 0 &&
    words.length <= MAX_NAME_WORDS &&
    value.length <= MAX_NAME_LENGTH &&
    words.every(isNameWord)
  );
}

/** A nickname the user chose outright: "call me ada". */
function isSpokenName(value: string): boolean {
  return (
    !value.includes(" ") &&
    value.length > 1 &&
    value.length <= MAX_NAME_LENGTH &&
    /^[\p{L}][\p{L}'’.-]*$/u.test(value)
  );
}

/** "CTO at Analytic Engines" from ", CTO at Analytic Engines". */
function asDesignation(value: string): string | null {
  const trimmed = clean(value.replace(/^(?:i(?:'m| am)(?: the)?|the|an?)\s+/i, ""));
  if (!trimmed || trimmed.length > MAX_DESIGNATION_LENGTH) return null;
  return trimmed;
}

export function parseProfile(text: string): ProfileCandidate | null {
  const normalized = clean(text ?? "");
  if (!normalized) return null;
  const body = clean(normalized.replace(FILLERS, ""));
  if (!body) return null;

  const match = EXPLICIT.exec(body);
  const explicit = !!match;
  const statement = clean(match ? match[1] : body);
  if (!statement) return null;

  // "Ada Lovelace, CTO at Analytic Engines" / "Ada Lovelace and CTO"
  const parts = statement.split(/,|\s+and\s+/i).map(clean).filter(Boolean);
  const name = parts[0] ?? "";
  if (!name) return null;
  if (!isName(name) && !(explicit && isSpokenName(name))) return null;

  return {
    name,
    designation: parts.length > 1 ? asDesignation(parts.slice(1).join(", ")) : null,
    explicit,
  };
}
