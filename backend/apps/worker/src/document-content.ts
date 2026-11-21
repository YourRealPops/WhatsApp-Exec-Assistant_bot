import { chat, hasLlmConfig, type LlmConfig } from "@exec-assistant/ai";
import type { DocumentJobPayload } from "@exec-assistant/db";
import type { DocumentKind, DocumentSection } from "@exec-assistant/documents";

export interface DocumentContentBrief {
  kind: DocumentKind;
  /** What the document is about, e.g. "artificial intelligence". */
  subject: string;
  /** The user's full request, preserved for detail and intent. */
  prompt: string;
  /** Total slides including the cover, when the user asked for a count. */
  slideCount?: number;
  audience?: string;
  tone?: string;
  /** Requested outline, one section heading per line. */
  structure?: string;
  userName?: string | null;
}

export interface AuthoredDocument {
  title: string;
  subtitle?: string;
  sections: DocumentSection[];
}

const MAX_SECTIONS = 40;
const MAX_CHARS = 60_000;

function cleanText(value: unknown, max = 2_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringList(value: unknown, maxItems = 14): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item))
    .filter(Boolean)
    .slice(0, maxItems);
}

function labelFor(kind: DocumentKind): string {
  return kind === "pptx" ? "presentation" : kind === "docx" ? "report" : "document";
}

/**
 * Validate the model's authored JSON. Anything empty or malformed is dropped;
 * a response with no usable sections is a retryable failure, never a blank
 * document sent to the user.
 */
export function normalizeAuthoredContent(
  raw: unknown,
  brief: DocumentContentBrief,
): AuthoredDocument {
  const value =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const sections: DocumentSection[] = [];
  let characters = 0;

  for (const entry of Array.isArray(value.sections) ? value.sections : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const section = entry as Record<string, unknown>;
    const heading = cleanText(section.heading, 140);
    const paragraphs = stringList(section.paragraphs);
    const bullets = stringList(section.bullets);
    if (!heading || paragraphs.length + bullets.length === 0) continue;
    characters += [heading, ...paragraphs, ...bullets].join(" ").length;
    sections.push({ heading, paragraphs, bullets });
    if (sections.length >= MAX_SECTIONS) break;
  }

  if (sections.length === 0) {
    throw new Error("the document model returned no usable sections");
  }
  if (characters > MAX_CHARS) {
    throw new Error("the document model returned more content than one file can hold");
  }

  return {
    title: cleanText(value.title, 160) || brief.subject,
    subtitle:
      cleanText(value.subtitle, 200) ||
      `A practical ${labelFor(brief.kind)} on ${brief.subject}`,
    sections,
  };
}

/**
 * Deterministic content for a deployment without an LLM key. It is honest
 * about being a starting draft and never invents facts, citations or figures.
 * The model-backed path produces the substantive prose.
 */
export function buildFallbackContent(brief: DocumentContentBrief): AuthoredDocument {
  const subject = brief.subject;
  const total = brief.kind === "pptx" ? Math.max(2, brief.slideCount ?? 7) : 5;
  const target = brief.kind === "pptx" ? total - 1 : total;
  const base: DocumentSection[] = [
    {
      heading: "Purpose and scope",
      paragraphs: [
        `This ${labelFor(brief.kind)} sets out a practical view of ${subject}. It is a starting draft: check the specifics, figures and local requirements before acting on it.`,
      ],
      bullets: [
        `Explain why ${subject} matters now.`,
        "State the decision or outcome this document should support.",
        "Record any assumptions that still need confirmation.",
      ],
    },
    {
      heading: "Context",
      bullets: [
        "Who is affected, and what they need from this work.",
        "What is already in place and what is missing.",
        "Constraints on time, budget, people and compliance.",
      ],
    },
    {
      heading: "Key considerations",
      bullets: [
        "Define success in measurable terms before starting.",
        "Identify the highest-risk assumption and test it early.",
        "Separate reversible experiments from irreversible commitments.",
        "Agree who owns each decision and how escalations work.",
      ],
    },
    {
      heading: "Risks and limitations",
      bullets: [
        "Missing or unreliable information can distort the plan.",
        "Hidden dependencies may delay delivery.",
        "Controls must match the sensitivity of the data involved.",
        "A named human should remain accountable for high-impact outcomes.",
      ],
    },
    {
      heading: "Recommended approach",
      paragraphs: [
        `Start with a bounded pilot for ${subject}, with a clear baseline and a review date. Expand only when the evidence supports it.`,
      ],
      bullets: [
        "Choose one workflow with a visible, low-risk outcome.",
        "Document the current process and its cost before changing it.",
        "Review results with the people who will use the output.",
      ],
    },
    {
      heading: "Implementation steps",
      bullets: [
        "Confirm the scope and the owner.",
        "Collect the minimum reliable information needed.",
        "Run a small trial and record what happens.",
        "Adjust the approach, then decide whether to scale.",
      ],
    },
    {
      heading: "Success measures",
      bullets: [
        "Time saved or quality improved against the baseline.",
        "Adoption by the intended users.",
        "Error and escalation rates.",
        "Cost per completed task.",
      ],
    },
    {
      heading: "Next steps",
      bullets: [
        "Assign an owner and a review date.",
        "List the open questions that block a decision.",
        "Agree the next concrete action.",
      ],
    },
  ];

  const sections: DocumentSection[] = [];
  for (let i = 0; i < target; i++) {
    const template = base[i % base.length];
    if (i < base.length) {
      sections.push(template);
    } else {
      const lines = [...(template.paragraphs ?? []), ...(template.bullets ?? [])];
      sections.push({
        heading: `${template.heading} (cont.)`,
        bullets: lines,
      });
    }
  }

  return {
    title: subject,
    subtitle: `A practical ${labelFor(brief.kind)} on ${subject}`,
    sections,
  };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("the document model returned no JSON");
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new Error("the document model returned invalid JSON");
  }
}

/**
 * Author a general-purpose document. The API queues the request and the worker
 * runs this, so a long generation never delays the WhatsApp reply.
 */
export async function generateAuthoredContent(
  brief: DocumentContentBrief,
  llm?: LlmConfig | null,
): Promise<AuthoredDocument> {
  if (!hasLlmConfig(llm)) return buildFallbackContent(brief);

  const contentSlides = Math.max(1, (brief.slideCount ?? 7) - 1);
  const structure =
    brief.kind === "pptx"
      ? `Create exactly ${contentSlides} sections. Each section becomes one content slide (the cover counts as slide 1). Use 3-6 short bullets per section, each under 22 words.`
      : "Create 4-8 sections. Each section should have 1-3 short paragraphs or 3-6 bullets.";

  const result = await chat(llm, {
    messages: [
      {
        role: "system",
        content: [
          "You are an expert document writer producing a finished, self-contained document for a busy professional.",
          "Use only the information in the request. Do not invent statistics, dates, names, quotes, studies, URLs or citations. When a claim would need a source, phrase it as general guidance instead.",
          "Write clear, specific prose. Do not use markdown. Do not mention that you are an AI.",
          'Return ONLY a JSON object: {"title": string, "subtitle": string, "sections": [{"heading": string, "paragraphs": string[], "bullets": string[]}]}.',
          "Every section must have a heading and at least one paragraph or bullet.",
          structure,
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Request: ${brief.prompt}`,
          `Subject: ${brief.subject}`,
          `Format: ${brief.kind === "pptx" ? "PowerPoint presentation" : brief.kind === "docx" ? "Word document" : "PDF"}`,
          brief.audience ? `Audience: ${brief.audience}` : "",
          brief.tone ? `Tone: ${brief.tone}` : "",
          brief.structure
            ? `Use this outline and keep its order where sensible:\n${brief.structure}`
            : "",
          brief.userName ? `Prepared for: ${brief.userName}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
    temperature: 0.4,
    maxTokens: 3_500,
  });

  if (!result.content) throw new Error("the document model returned no content");
  return normalizeAuthoredContent(extractJson(result.content), brief);
}

/** Read the general-document brief from a persisted job payload. */
export function briefFromPayload(
  payload: DocumentJobPayload,
  opts: { kind: DocumentKind; title: string; userName?: string | null },
): DocumentContentBrief {
  return {
    kind: opts.kind,
    subject: (payload.subject ?? opts.title).trim().slice(0, 160),
    prompt: (payload.prompt ?? payload.subject ?? opts.title).trim().slice(0, 4_000),
    slideCount: payload.slideCount,
    audience: payload.audience,
    tone: payload.tone,
    structure: payload.structure,
    userName: opts.userName ?? null,
  };
}
