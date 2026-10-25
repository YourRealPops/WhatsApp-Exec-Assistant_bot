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
