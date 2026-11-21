import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { generateDocument, validateDocument } from "./generate.js";
import { isCalendarDocument, type DocumentRequest } from "./types.js";

const request = (kind: DocumentRequest["kind"]): DocumentRequest => ({
  kind,
  title: "Calendar summary",
  timezone: "Africa/Lagos",
  rangeLabel: "23 Nov – 29 Nov 2026",
  generatedFor: "Ada",
  generatedAt: "2026-11-21T09:00:00Z",
  events: [
    {
      title: "Board review",
      start: "2026-11-23T09:00:00Z",
      end: "2026-11-23T10:00:00Z",
      location: "Boardroom",
    },
    {
      title: "Public holiday",
      start: "2026-11-24T00:00:00Z",
      end: "2026-11-25T00:00:00Z",
      allDay: true,
    },
  ],
});

test("generates and validates a PDF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecos-doc-"));
  try {
    const out = join(dir, "summary.pdf");
    const file = await generateDocument(request("pdf"), out);
    assert.equal(file.mimeType, "application/pdf");
    assert.ok(file.bytes > 500, "a real PDF, not an empty stub");
    assert.equal(file.filename.endsWith(".pdf"), true);
    assert.deepEqual(await validateDocument(out, "pdf"), { valid: true, reason: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generates and validates a DOCX package", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecos-doc-"));
  try {
    const out = join(dir, "summary.docx");
    const file = await generateDocument(request("docx"), out);
    assert.match(file.mimeType, /wordprocessingml/);
    assert.equal((await validateDocument(out, "docx")).valid, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generates and validates a PPTX package", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecos-doc-"));
  try {
    const out = join(dir, "summary.pptx");
    const file = await generateDocument(request("pptx"), out);
    assert.match(file.mimeType, /presentationml/);
    assert.equal((await validateDocument(out, "pptx")).valid, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const generalRequest = (
  kind: DocumentRequest["kind"],
  slideCount?: number,
): DocumentRequest => ({
  kind,
  source: "general",
  title: "Artificial intelligence: a practical report",
  subtitle: "Opportunities, limits and responsible adoption",
  timezone: "Africa/Lagos",
  generatedFor: "Ada",
  generatedAt: "2026-11-21T09:00:00Z",
  slideCount,
  sections: [
    {
      heading: "Executive summary",
      paragraphs: [
        "Artificial intelligence is a family of techniques that learn patterns from data. This report explains where it helps, where it does not, and how teams can adopt it responsibly.",
      ],
    },
    {
      heading: "How modern systems work",
      bullets: [
        "Models learn statistical patterns from examples rather than following hand-written rules.",
        "Quality depends on the data, the task definition and human review.",
        "Outputs are probabilistic and should be verified before high-stakes use.",
        "Evaluation must include failure cases, not only demonstrations.",
        "Small, focused models can outperform large general models on narrow tasks.",
      ],
    },
    {
      heading: "Practical opportunities",
      bullets: [
        "Drafting and summarising reduce time spent on first-pass text.",
        "Classification can route requests and flag anomalies for review.",
        "Retrieval over trusted documents grounds answers in approved material.",
        "Coding assistants speed up repetitive implementation and test writing.",
        "Customer support triage can surface likely answers to human agents.",
      ],
    },
    {
      heading: "Risks and limits",
      bullets: [
        "Models can state falsehoods confidently, so citations need independent checks.",
        "Sensitive data requires clear retention and access controls.",
        "Bias in training data can produce unfair outcomes.",
        "Automation can hide accountability unless a human owns the decision.",
        "Cost and latency grow with model size and usage volume.",
      ],
    },
    {
      heading: "Recommended next steps",
      bullets: [
        "Start with one bounded workflow and a measurable baseline.",
        "Keep a human approval step for external or irreversible actions.",
        "Log inputs, outputs and corrections so quality can be audited.",
        "Publish an acceptable-use policy before broad access.",
        "Review results after a fixed pilot period and decide whether to scale.",
      ],
    },
  ],
});

test("generates a general-purpose PDF report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecos-doc-"));
  try {
    const out = join(dir, "report.pdf");
    const file = await generateDocument(generalRequest("pdf"), out);
    assert.ok(file.bytes > 1000);
    assert.equal((await validateDocument(out, "pdf")).valid, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generates a general-purpose Word document with its authored sections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecos-doc-"));
  try {
    const out = join(dir, "report.docx");
    await generateDocument(generalRequest("docx"), out);
    assert.equal((await validateDocument(out, "docx")).valid, true);
    const zip = await JSZip.loadAsync(await readFile(out));
    const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
    assert.match(xml, /Artificial intelligence/);
    assert.match(xml, /Recommended next steps/);
    assert.match(xml, /human approval step/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a requested PowerPoint slide count is honoured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecos-doc-"));
  try {
    const out = join(dir, "deck.pptx");
    await generateDocument(generalRequest("pptx", 10), out);
    assert.equal((await validateDocument(out, "pptx")).valid, true);
    const zip = await JSZip.loadAsync(await readFile(out));
    const slides = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name),
    );
    assert.equal(slides.length, 10, "cover plus nine content slides");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a shorter deck groups sections instead of dropping them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecos-doc-"));
  try {
    const out = join(dir, "short.pptx");
    await generateDocument(generalRequest("pptx", 3), out);
    const zip = await JSZip.loadAsync(await readFile(out));
    const slides = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name),
    );
    assert.equal(slides.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects a general document with no authored sections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecos-doc-"));
  try {
    const req = generalRequest("pdf");
    if (req.source === "general") req.sections = [];
    await assert.rejects(generateDocument(req, join(dir, "empty.pdf")), /at least one section/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects empty, wrong-magic and truncated files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecos-doc-"));
  try {
    const empty = join(dir, "empty.pdf");
    await writeFile(empty, Buffer.alloc(0));
    assert.equal((await validateDocument(empty, "pdf")).valid, false);

    const fake = join(dir, "fake.pdf");
    await writeFile(fake, "not a pdf at all");
    assert.equal((await validateDocument(fake, "pdf")).valid, false);

    const truncated = join(dir, "truncated.pdf");
    await writeFile(truncated, "%PDF-1.7\nbody without an end marker");
    assert.equal((await validateDocument(truncated, "pdf")).valid, false);

    assert.equal((await validateDocument(join(dir, "missing.docx"), "docx")).valid, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses more events than the configured limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ecos-doc-"));
  try {
    const req = request("pdf");
    if (!isCalendarDocument(req)) throw new Error("expected a calendar document");
    req.events = Array.from({ length: 3 }, (_, i) => ({
      title: `Event ${i}`,
      start: "2026-11-23T09:00:00Z",
      end: "2026-11-23T10:00:00Z",
    }));
    await assert.rejects(
      generateDocument(req, join(dir, "too-many.pdf"), { maxBytes: 1024, maxEvents: 2 }),
      /limit/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
