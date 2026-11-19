/**
 * Timezone helpers. Wall-clock strings like "2026-10-25T09:00" carry no
 * offset, so they must be interpreted in the *user's* timezone, not the
 * server's — that's what these functions take care of.
 */

function partsInTz(date: Date, tz: string): Record<string, number> {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out;
}

/** Offset of `tz` from UTC (ms) at the given instant. */
export function tzOffsetMs(date: Date, tz: string): number {
  const p = partsInTz(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert a wall-clock time in `tz` to the UTC instant it refers to. */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): Date {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let ts = naive;
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMs(new Date(ts), tz);
    const adjusted = naive - off;
    if (adjusted === ts) break;
    ts = adjusted;
  }
  return new Date(ts);
}

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse an ISO-ish string (or YYYY-MM-DD) into a Date, honouring the user's
 * timezone when the string has no offset of its own.
 */
export function parseWhen(value: string, tz: string): Date {
  const trimmed = value.trim();
  if (HAS_OFFSET.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) throw new Error(`Unrecognised time: ${value}`);
    return d;
  }
  const m = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!m) throw new Error(`Unrecognised time: ${value}`);
  const [y, mo, d, h, mi] = [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
  ];
  // Reject values Date.UTC would silently roll over (2026-13-45T99:99).
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) {
    throw new Error(`Unrecognised time: ${value}`);
  }
  const result = zonedToUtc(y, mo, d, h, mi, tz);
  const back = partsInTz(result, tz);
  if (back.year !== y || back.month !== mo || back.day !== d) {
    throw new Error(`Unrecognised time: ${value}`);
  }
  return result;
}

/** Midnight (in `tz`) of the YYYY-MM-DD date. */
export function startOfDayInTz(dateStr: string, tz: string): Date {
  return parseWhen(dateStr, tz);
}

/** Add days to a YYYY-MM-DD string without touching timezones. */
export function addDaysToDateStr(dateStr: string, days: number): string {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Expected YYYY-MM-DD, got: ${dateStr}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's YYYY-MM-DD in `tz`. */
export function todayInTz(tz: string, now: Date = new Date()): string {
  const p = partsInTz(now, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The wall-clock time of `date` in `tz`, as "HH:mm". */
export function clockInTz(date: Date, tz: string): string {
  const p = partsInTz(date, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/**
 * Parse the way people say times in chat ("10a.m tomorrow", "4 PM",
 * "tomorrow at 09:30", "next friday 3pm") into the UTC instant they mean,
 * interpreting every wall-clock part in `tz` — never twice, and never in the
 * server's timezone.
 *
 * ISO-ish input is handed straight to {@link parseWhen}, so a caller may pass
 * either form.
 */
export function parseSpokenWhen(
  value: string,
  tz: string,
  now: Date = new Date(),
): Date {
  const raw = value
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/\b(?:instead|please)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) throw new Error("Unrecognised time: empty");
  if (HAS_OFFSET.test(raw) || /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return parseWhen(raw, tz);
  }

  const lower = raw.toLowerCase();
  const today = todayInTz(tz, now);
  let dateStr = today;

  if (/\bday\s+after\s+tomorrow\b/.test(lower)) {
    dateStr = addDaysToDateStr(today, 2);
  } else if (/\btomorrow\b/.test(lower)) {
    dateStr = addDaysToDateStr(today, 1);
  } else if (/\btoday\b|\btonight\b/.test(lower)) {
    dateStr = today;
  } else {
    const weekday = WEEKDAYS.findIndex((name) =>
      new RegExp(`\\b${name}\\b`).test(lower),
    );
    if (weekday >= 0) {
      const p = partsInTz(now, tz);
      const current = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
      // The next occurrence: "Friday" on a Friday means next week, because a
      // time already behind us is never the one the user meant.
      const delta = ((weekday - current + 7) % 7) || 7;
      dateStr = addDaysToDateStr(today, delta);
    }
  }

  let hour: number | null = null;
  let minute = 0;
  const spelled = /\b(noon|midday|midnight)\b/i.exec(lower);
  if (spelled) {
    hour = spelled[1].toLowerCase() === "midnight" ? 0 : 12;
  } else {
    const clock = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(raw);
    if (clock) {
      hour = Number(clock[1]);
      minute = Number(clock[2] ?? 0);
      const meridiem = clock[3]?.toLowerCase().replace(/\./g, "");
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
    }
  }
  if (hour === null || hour > 23 || minute > 59) {
    throw new Error(`Unrecognised time: ${value}`);
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  return parseWhen(`${dateStr}T${pad(hour)}:${pad(minute)}`, tz);
}
