/** Shared shapes for every document the assistant generates. */

export type DocumentKind = "pdf" | "docx" | "pptx";

/** One calendar event as it will appear in the document. */
export interface DocumentEvent {
  title: string;
  /** ISO 8601 instant. */
  start: string;
  /** ISO 8601 instant. */
  end: string;
  allDay?: boolean;
  location?: string | null;
  description?: string | null;
}

/** One authored chapter/section of a general-purpose document. */
export interface DocumentSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

interface BaseDocumentRequest {
  kind: DocumentKind;
  title: string;
  /** IANA zone used for dates in the header. Defaults to UTC. */
  timezone?: string;
  /** Name to address the document to, when known. */
  generatedFor?: string | null;
  /** ISO instant the document was prepared. Defaults to now. */
  generatedAt?: string;
}

/**
 * A calendar snapshot. It is taken when the job is created, so the generated
 * file always matches the data the user's request was answered with.
 */
export interface CalendarDocumentRequest extends BaseDocumentRequest {
  source?: "calendar";
  timezone: string;
  /** Human window, e.g. "23 Nov – 29 Nov 2026". */
  rangeLabel: string;
  events: DocumentEvent[];
}

/**
 * A general-purpose document: a report, proposal, briefing, guide or deck.
 * `sections` is authored by the worker's document model, never invented by the
 * renderer. No calendar connection is involved.
 */
export interface GeneralDocumentRequest extends BaseDocumentRequest {
  source: "general";
  /** Short line under the title, e.g. "A practical briefing". */
  subtitle?: string;
  sections: DocumentSection[];
  /** Total slides including the cover, when the user asked for a count. */
  slideCount?: number;
}

export type DocumentRequest = CalendarDocumentRequest | GeneralDocumentRequest;

export function isCalendarDocument(
  req: DocumentRequest,
): req is CalendarDocumentRequest {
  return req.source !== "general";
}

export interface GeneratedDocument {
  path: string;
  filename: string;
  mimeType: string;
  bytes: number;
}

export interface DocumentLimits {
  /** Hard file-size ceiling in bytes. */
  maxBytes: number;
  /** Generation refuses more events than this. */
  maxEvents: number;
  /** Refuses more authored sections than this. */
  maxSections?: number;
}

export const DEFAULT_DOCUMENT_LIMITS: DocumentLimits = {
  maxBytes: 16 * 1024 * 1024,
  maxEvents: 500,
  maxSections: 40,
};

export const DOCUMENT_MIME: Record<DocumentKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const DOCUMENT_LABEL: Record<DocumentKind, string> = {
  pdf: "PDF",
  docx: "Word document",
  pptx: "PowerPoint presentation",
};

export function isDocumentKind(value: unknown): value is DocumentKind {
  return value === "pdf" || value === "docx" || value === "pptx";
}
