import type {
  CalendarDocumentRequest,
  DocumentEvent,
  DocumentRequest,
  DocumentSection,
} from "./types.js";

function safeFormat(
  date: Date,
  tz: string,
  opts: Intl.DateTimeFormatOptions,
): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** "Mon 23 Nov 2026" in the user's timezone. */
export function formatDay(date: Date, tz: string): string {
  return safeFormat(date, tz, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "09:00" in the user's timezone. */
export function formatClock(date: Date, tz: string): string {
  return safeFormat(date, tz, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatEventTime(event: DocumentEvent, tz: string): string {
  if (event.allDay) return "All day";
  return `${formatClock(new Date(event.start), tz)}–${formatClock(new Date(event.end), tz)}`;
}

/** Stable local date key (YYYY-MM-DD) used to group events by day. */
export function dayKey(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export interface EventDay {
  key: string;
  label: string;
  events: DocumentEvent[];
}

/**
 * Group events by the local day they start on. Events are already sorted by
 * the snapshot query, and sorting again here keeps each renderer identical.
 */
export function groupEventsByDay(req: CalendarDocumentRequest): EventDay[] {
  const days = new Map<string, EventDay>();
  const sorted = [...req.events].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
  for (const event of sorted) {
    const start = new Date(event.start);
    if (Number.isNaN(start.getTime())) continue;
    const key = dayKey(start, req.timezone);
    let day = days.get(key);
    if (!day) {
      day = { key, label: formatDay(start, req.timezone), events: [] };
      days.set(key, day);
    }
    day.events.push(event);
  }
  return [...days.values()];
}

/**
 * Turn authored paragraphs and bullets into the lines a slide can show. The
 * order is deliberate: the lead paragraph is the narrative, then bullets.
 */
export function sectionLines(section: DocumentSection): string[] {
  const paragraphs = (section.paragraphs ?? [])
    .map((p) => p.trim())
    .filter(Boolean);
  const bullets = (section.bullets ?? [])
    .map((b) => b.trim())
    .filter(Boolean);
  return [...paragraphs, ...bullets];
}

/**
 * Fit authored sections into exactly `target` content slides. Long sections
 * are split at a sentence boundary; short sections are grouped rather than
 * dropping content. This is what makes "10 slides" mean ten slides even when
 * the model's outline has a different number of headings.
 */
export function fitSectionsForSlides(
  sections: DocumentSection[],
  target: number,
): DocumentSection[] {
  const wanted = Math.max(1, Math.trunc(target));
  let units: DocumentSection[] = sections
    .map((section, index) => ({
      heading: (section.heading || `Section ${index + 1}`).trim(),
      paragraphs: (section.paragraphs ?? []).map((p) => p.trim()).filter(Boolean),
      bullets: (section.bullets ?? []).map((b) => b.trim()).filter(Boolean),
    }))
    .filter((section) => section.paragraphs!.length + section.bullets!.length > 0);

  if (units.length === 0) {
    units = [{ heading: "Overview", paragraphs: ["No content was supplied."] }];
  }

  // Split the richest section until the requested number of slides is met.
  while (units.length < wanted) {
    let best = 0;
    for (let i = 1; i < units.length; i++) {
      if (sectionLines(units[i]).length > sectionLines(units[best]).length) best = i;
    }
    const lines = sectionLines(units[best]);
    if (lines.length < 2) break;
    const half = Math.ceil(lines.length / 2);
    const first = lines.slice(0, half);
    const second = lines.slice(half);
    const heading = units[best].heading;
    units.splice(
      best,
      1,
      { heading, bullets: first },
      { heading: `${heading} (cont.)`, bullets: second },
    );
  }

  // Group adjacent sections when there are more headings than slides.
  if (units.length > wanted) {
    const grouped: DocumentSection[] = [];
    let cursor = 0;
    for (let i = 0; i < wanted; i++) {
      const remaining = units.length - cursor;
      const take = Math.max(1, Math.ceil(remaining / (wanted - i)));
      const group = units.slice(cursor, cursor + take);
      cursor += take;
      grouped.push({
        heading:
          group.length === 1
            ? group[0].heading
            : group.map((section) => section.heading).join(" · "),
        bullets: group.flatMap((section) => {
          const lines = sectionLines(section);
          return group.length === 1
            ? lines
            : [`${section.heading}:`, ...lines];
        }),
      });
    }
    units = grouped;
  }

  return units.slice(0, wanted);
}

/** Filesystem/WhatsApp-safe name for a generated document. */
export function documentFilename(req: DocumentRequest, at = new Date()): string {
  const slug = req.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "document";
  const stamp = at.toISOString().slice(0, 10);
  return `${slug}-${stamp}.${req.kind}`;
}
