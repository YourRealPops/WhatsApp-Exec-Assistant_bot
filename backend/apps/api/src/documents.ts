import { randomUUID } from "node:crypto";
import {
  createDocumentJob,
  listUpcomingEvents,
  type Db,
  type DocumentKind,
} from "@exec-assistant/db";
import {
  addDaysToDateStr,
  startOfDayInTz,
  todayInTz,
} from "@exec-assistant/calendar";
import type { GenerateDocumentResult } from "@exec-assistant/ai";
import { ensureFreshCalendar } from "./calendar-freshness.js";
import type { GoogleConfig } from "./calendar-access.js";

export interface DocumentRequestContext {
  db: Db;
  userId: string;
  timezone: string;
  google: GoogleConfig | null;
  freshnessMs: number;
  lookaheadDays: number;
  reminderOffsets: number[];
  maxOffsetMinutes: number;
  maxEvents: number;
  maxDays: number;
  /** The inbound message that asked for the document (job idempotency key). */
  currentMessageId?: string;
  /** The user's full request — the writing brief for general documents. */
  currentMessage?: string;
}

const FORMAT_ALIASES: Record<string, DocumentKind> = {
  pdf: "pdf",
  docx: "docx",
  doc: "docx",
  word: "docx",
  pptx: "pptx",
  ppt: "pptx",
  powerpoint: "pptx",
  slides: "pptx",
  presentation: "pptx",
};

const LABEL: Record<DocumentKind, string> = {
  pdf: "PDF",
  docx: "Word document",
  pptx: "PowerPoint presentation",
};

type DocumentSource = "calendar" | "general";

function normalizeKind(value: unknown): DocumentKind {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  const kind = FORMAT_ALIASES[key];
  if (!kind) {
    throw new Error("Choose a format first: PDF, Word document or PowerPoint presentation.");
  }
  return kind;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function formatDay(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function explicitSource(value: unknown): DocumentSource | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "calendar" || raw === "schedule" || raw === "events") return "calendar";
  if (raw === "general" || raw === "topic" || raw === "report") return "general";
  return null;
}

/**
 * Old clients only sent a format; they mean a calendar summary. A general
 * request is explicit (source) or carries a topic/prompt. Date/days still
 * selects the calendar path when the model omits source.
 */
function resolveSource(args: Record<string, unknown>, message: string): DocumentSource {
  const explicit = explicitSource(args.source ?? args.mode);
  if (explicit) return explicit;
  if (
    typeof args.topic === "string" ||
    typeof args.subject === "string" ||
    typeof args.prompt === "string"
  ) {
    return "general";
  }
  if (args.date !== undefined || args.days !== undefined) return "calendar";
  if (/\b(calendar|schedule|meetings?|appointments?|events?|agenda)\b/i.test(message)) {
    return "calendar";
  }
  // A clearly authored topic is general even if the model omitted `source`.
  if (/\b(report|proposal|essay|guide|briefing|analysis|article)\b/i.test(message)) {
    return "general";
  }
  return "calendar";
}

/**
 * Turn "Create a PDF report about artificial intelligence" into a concise
 * subject. The full request is still stored as the prompt, so no detail is
 * lost to this cleanup.
 */
export function documentSubject(args: Record<string, unknown>, message: string): string {
  const direct = [args.topic, args.subject, args.prompt, message]
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  let subject = (direct ?? "").trim();
  subject = subject.replace(
    /^(?:please\s+)?(?:can you\s+)?(?:create|make|generate|prepare|build|write|draft|send|give)\s+(?:me\s+)?(?:a|an|the)?\s*(?:(?:pdf|docx|word|pptx|powerpoint|slide|slides|presentation|document|report|summary)\s*)*(?:about|on|containing|covering|for|of)?\s*/i,
    "",
  );
  subject = subject.replace(/\s+/g, " ").replace(/[.?!]+$/g, "").trim();
  return subject.slice(0, 140) || "General document";
}

function slideCountArg(args: Record<string, unknown>): number | undefined {
  const raw = args.slide_count ?? args.slides ?? args.slideCount;
  if (raw === undefined || raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return clamp(value, 1, 60);
}

/**
 * Validate a document request and queue one job. Calendar requests refresh
 * Google first and snapshot the exact events; general requests carry the
 * writing brief and do not touch or require a calendar. Nothing is generated
 * here — the worker produces the file and sends it.
 */
export async function requestCalendarDocument(
  ctx: DocumentRequestContext,
  args: Record<string, unknown>,
): Promise<GenerateDocumentResult> {
  const kind = normalizeKind(args.format ?? args.kind);
  const source = resolveSource(args, ctx.currentMessage ?? "");

  if (source === "general") {
    const subject = documentSubject(args, ctx.currentMessage ?? "");
    const prompt = (
      typeof args.prompt === "string" && args.prompt.trim()
        ? args.prompt
        : ctx.currentMessage || subject
    )
      .trim()
      .slice(0, 4_000);
    const title =
      typeof args.title === "string" && args.title.trim()
        ? args.title.trim().slice(0, 140)
        : subject;
    const slideCount = kind === "pptx" ? slideCountArg(args) : undefined;
    const audience =
      typeof args.audience === "string" ? args.audience.trim().slice(0, 120) : undefined;
    const tone = typeof args.tone === "string" ? args.tone.trim().slice(0, 80) : undefined;
    const rawStructure = Array.isArray(args.structure)
      ? args.structure.filter((item): item is string => typeof item === "string").join("\n")
      : typeof args.structure === "string"
        ? args.structure
        : "";
    const structure = rawStructure.trim().slice(0, 2_000) || undefined;

    const job = await createDocumentJob(ctx.db, {
      userId: ctx.userId,
      requestMessageId: ctx.currentMessageId ?? `tool:${randomUUID()}`,
      kind,
      title,
      payload: {
        source: "general",
        subject,
        prompt,
        ...(audience ? { audience } : {}),
        ...(tone ? { tone } : {}),
        ...(structure ? { structure } : {}),
        ...(slideCount ? { slideCount } : {}),
        generatedFor: null,
      },
    });

    return {
      jobId: job.id,
      format: kind,
      source: "general",
      title,
      eventCount: 0,
      ...(slideCount ? { slideCount } : {}),
      message:
        job.status === "sent"
          ? `That ${LABEL[kind]} was already sent here.`
          : `Your ${LABEL[kind]} is being prepared. I'll send it here when it's ready.`,
    };
  }

  const days = clamp(Number(args.days ?? 7), 1, ctx.maxDays);
  const rawDate = typeof args.date === "string" ? args.date.trim() : "";
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? rawDate
    : todayInTz(ctx.timezone);

  const from = startOfDayInTz(dateStr, ctx.timezone);
  const to = startOfDayInTz(addDaysToDateStr(dateStr, days), ctx.timezone);
  const lastDay = new Date(to.getTime() - 1);
  const rangeLabel =
    days === 1
      ? formatDay(from, ctx.timezone)
      : `${formatDay(from, ctx.timezone)} – ${formatDay(lastDay, ctx.timezone)}`;

  // A calendar document must never be built from stale data. The freshness
  // read either refreshes Google now or reports that it could not; in the
  // latter case the request is refused rather than fabricating content.
  const freshness = await ensureFreshCalendar({
    db: ctx.db,
    userId: ctx.userId,
    google: ctx.google,
    freshnessMs: ctx.freshnessMs,
    lookaheadDays: ctx.lookaheadDays,
    reminderOffsets: ctx.reminderOffsets,
    maxOffsetMinutes: ctx.maxOffsetMinutes,
  });
  if (freshness.stale) {
    throw new Error(
      freshness.warning ??
        "I couldn't refresh your calendar, so I won't build a document from out-of-date events.",
    );
  }

  const rows = await listUpcomingEvents(
    ctx.db,
    ctx.userId,
    from,
    to,
    ctx.maxEvents + 1,
  );
  if (rows.length > ctx.maxEvents) {
    throw new Error(
      `That range has more than ${ctx.maxEvents} events. Ask for a shorter period.`,
    );
  }

  const title =
    typeof args.title === "string" && args.title.trim()
      ? args.title.trim().slice(0, 120)
      : `Calendar summary — ${rangeLabel}`;

  const job = await createDocumentJob(ctx.db, {
    userId: ctx.userId,
    requestMessageId: ctx.currentMessageId ?? `tool:${randomUUID()}`,
    kind,
    title,
    payload: {
      source: "calendar",
      timezone: ctx.timezone,
      rangeLabel,
      generatedFor: null,
      events: rows.map((e) => ({
        title: e.title,
        start: new Date(e.start_at).toISOString(),
        end: new Date(e.end_at).toISOString(),
        allDay: e.all_day,
        location: e.location,
        description: e.description,
      })),
    },
  });

  return {
    jobId: job.id,
    format: kind,
    source: "calendar",
    title,
    eventCount: rows.length,
    message:
      job.status === "sent"
        ? `That ${LABEL[kind]} was already sent here.`
        : `Your ${LABEL[kind]} is being prepared. I'll send it here when it's ready.`,
  };
}
