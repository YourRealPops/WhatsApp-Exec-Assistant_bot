/**
 * Chat-sized time formatting for proposals and confirmations. WhatsApp renders
 * plain text only, so everything here is short and ASCII-ish.
 */

function safe(date: Date, tz: string, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** "+01:00" for the event's timezone at that instant. */
export function offsetLabel(date: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      timeZoneName: "longOffset",
    }).formatToParts(date);
    const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    const offset = raw.replace("GMT", "");
    return offset === "" ? "UTC" : offset;
  } catch {
    return "UTC";
  }
}

export function clock(date: Date, tz: string): string {
  return safe(date, tz, { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function day(date: Date, tz: string): string {
  return safe(date, tz, { weekday: "short", day: "numeric", month: "short" });
}

/** "Fri 6 Nov, 10:00–11:00 (+01:00)" */
export function formatRange(start: Date, end: Date, tz: string): string {
  return `${day(start, tz)}, ${clock(start, tz)}–${clock(end, tz)} (${offsetLabel(start, tz)})`;
}

/** "Fri 6 Nov, 10:00 (+01:00)" */
export function formatInstant(date: Date, tz: string): string {
  return `${day(date, tz)}, ${clock(date, tz)} (${offsetLabel(date, tz)})`;
}
