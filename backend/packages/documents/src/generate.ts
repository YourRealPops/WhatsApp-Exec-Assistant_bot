import { createWriteStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import PDFDocument from "pdfkit";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import PptxGenJSModule from "pptxgenjs";
import JSZip from "jszip";
import {
  DEFAULT_DOCUMENT_LIMITS,
  DOCUMENT_MIME,
  isCalendarDocument,
  type DocumentLimits,
  type DocumentRequest,
  type GeneratedDocument,
} from "./types.js";
import {
  documentFilename,
  fitSectionsForSlides,
  formatEventTime,
  groupEventsByDay,
  sectionLines,
} from "./format.js";

function generatedAt(req: DocumentRequest): Date {
  const at = req.generatedAt ? new Date(req.generatedAt) : new Date();
  return Number.isNaN(at.getTime()) ? new Date() : at;
}

function assertRequest(req: DocumentRequest, limits: DocumentLimits): void {
  if (!req.title.trim()) throw new Error("document title is required");
  if (isCalendarDocument(req)) {
    if (req.events.length > limits.maxEvents) {
      throw new Error(
        `that is ${req.events.length} events — the limit for one document is ${limits.maxEvents}`,
      );
    }
    for (const event of req.events) {
      if (!event.title.trim()) event.title = "(untitled)";
      if (Number.isNaN(new Date(event.start).getTime())) {
        throw new Error(`event "${event.title}" has an invalid start time`);
      }
      if (Number.isNaN(new Date(event.end).getTime())) {
        throw new Error(`event "${event.title}" has an invalid end time`);
      }
    }
    return;
  }

  const maxSections = limits.maxSections ?? 40;
  if (!Array.isArray(req.sections) || req.sections.length === 0) {
    throw new Error("a general document needs at least one section");
  }
  if (req.sections.length > maxSections) {
    throw new Error(`that is ${req.sections.length} sections — the limit is ${maxSections}`);
  }
  let characters = 0;
  for (const section of req.sections) {
    if (!section.heading?.trim()) throw new Error("every section needs a heading");
    for (const value of [...(section.paragraphs ?? []), ...(section.bullets ?? [])]) {
      if (typeof value !== "string") throw new Error("section content must be text");
      characters += value.length;
    }
  }
  if (characters > 60_000) {
    throw new Error("the authored content is too long for one document");
  }
  if (
    req.slideCount !== undefined &&
    (!Number.isInteger(req.slideCount) || req.slideCount < 1 || req.slideCount > 60)
  ) {
    throw new Error("slide count must be a whole number between 1 and 60");
  }
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

async function renderPdf(req: DocumentRequest, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      info: { Title: req.title, Author: "ECOS" },
    });
    const stream = createWriteStream(path);
    doc.pipe(stream);
    doc.on("error", reject);
    stream.on("error", reject);
    stream.on("finish", () => resolve());

    const at = generatedAt(req);
    const timezone = req.timezone ?? "UTC";
    doc.font("Helvetica-Bold").fontSize(22).fillColor("#111111").text(req.title);
    doc
      .moveDown(0.3)
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#555555")
      .text(
        isCalendarDocument(req)
          ? req.rangeLabel
          : (req.subtitle ?? "Briefing prepared by ECOS"),
      );
    doc.text(`Prepared ${at.toISOString().slice(0, 10)} · ${timezone}`);
    if (req.generatedFor) doc.text(`For ${req.generatedFor}`);
    doc.moveDown(1.2);

    if (isCalendarDocument(req)) {
      const days = groupEventsByDay(req);
      if (days.length === 0) {
        doc
          .font("Helvetica-Oblique")
          .fontSize(12)
          .fillColor("#444444")
          .text("No events are scheduled in this period.");
      }

      for (const day of days) {
        if (doc.y > 690) doc.addPage();
        doc
          .font("Helvetica-Bold")
          .fontSize(13)
          .fillColor("#111111")
          .text(day.label);
        doc.moveDown(0.35);
        for (const event of day.events) {
          if (doc.y > 710) doc.addPage();
          doc
            .font("Helvetica")
            .fontSize(10)
            .fillColor("#666666")
            .text(formatEventTime(event, timezone), { continued: true, width: 110 });
          doc
            .font("Helvetica-Bold")
            .fontSize(11)
            .fillColor("#111111")
            .text(event.title);
          if (event.location) {
            doc
              .font("Helvetica")
              .fontSize(9)
              .fillColor("#555555")
              .text(event.location, { indent: 4 });
          }
          if (event.description) {
            doc
              .font("Helvetica")
              .fontSize(9)
              .fillColor("#555555")
              .text(event.description.slice(0, 400), { indent: 4 });
          }
          doc.moveDown(0.45);
        }
        doc.moveDown(0.4);
      }
    } else {
      for (const section of req.sections) {
        if (doc.y > 690) doc.addPage();
        doc
          .font("Helvetica-Bold")
          .fontSize(14)
          .fillColor("#111111")
          .text(section.heading);
        doc.moveDown(0.35);
        for (const paragraph of section.paragraphs ?? []) {
          if (doc.y > 720) doc.addPage();
          doc
            .font("Helvetica")
            .fontSize(10.5)
            .fillColor("#222222")
            .text(paragraph, { align: "left", lineGap: 2 });
          doc.moveDown(0.4);
        }
        for (const bullet of section.bullets ?? []) {
          if (doc.y > 720) doc.addPage();
          doc
            .font("Helvetica")
            .fontSize(10.5)
            .fillColor("#222222")
            .text(`•  ${bullet}`, { indent: 8, lineGap: 1 });
          doc.moveDown(0.25);
        }
        doc.moveDown(0.7);
      }
    }

    doc.end();
  });
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

async function renderDocx(req: DocumentRequest, path: string): Promise<void> {
  const timezone = req.timezone ?? "UTC";
  const children: Paragraph[] = [
    new Paragraph({ text: req.title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [
        new TextRun({
          text: isCalendarDocument(req)
            ? req.rangeLabel
            : (req.subtitle ?? "Briefing prepared by ECOS"),
          bold: true,
        }),
        new TextRun({
          text: `\nPrepared ${generatedAt(req).toISOString().slice(0, 10)} · ${timezone}`,
          color: "666666",
          size: 18,
        }),
      ],
    }),
  ];
  if (req.generatedFor) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `For ${req.generatedFor}`, color: "666666" })],
      }),
    );
  }

  if (isCalendarDocument(req)) {
    const days = groupEventsByDay(req);
    if (days.length === 0) {
      children.push(new Paragraph({ text: "No events are scheduled in this period." }));
    }
    for (const day of days) {
      children.push(new Paragraph({ text: day.label, heading: HeadingLevel.HEADING_1 }));
      for (const event of day.events) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            children: [
              new TextRun({
                text: `${formatEventTime(event, timezone)}  `,
                bold: true,
              }),
              new TextRun({ text: event.title, bold: true }),
            ],
          }),
        );
        if (event.location) {
          children.push(
            new Paragraph({
              indent: { left: 720 },
              children: [
                new TextRun({ text: event.location, color: "666666", size: 18 }),
              ],
            }),
          );
        }
      }
      children.push(new Paragraph({ text: "" }));
    }
  } else {
    for (const section of req.sections) {
      children.push(
        new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }),
      );
      for (const paragraph of section.paragraphs ?? []) {
        children.push(new Paragraph({ text: paragraph, spacing: { after: 160 } }));
      }
      for (const bullet of section.bullets ?? []) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            children: [new TextRun({ text: bullet })],
          }),
        );
      }
      children.push(new Paragraph({ text: "" }));
    }
  }

  const doc = new Document({
    creator: "ECOS",
    title: req.title,
    sections: [{ properties: {}, children }],
  });
  await writeFile(path, await Packer.toBuffer(doc));
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

const SLIDE_EVENTS = 9;

// pptxgenjs ships a CJS default export whose typings also declare a global
// namespace; this constructor cast is what makes it usable from NodeNext ESM.
const PptxGenJS = PptxGenJSModule as unknown as { new (): any };

async function renderPptx(req: DocumentRequest, path: string): Promise<void> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.author = "ECOS";
  pptx.title = req.title;
  const timezone = req.timezone ?? "UTC";

  const cover = pptx.addSlide();
  cover.background = { color: "111827" };
  cover.addText(req.title, {
    x: 0.6,
    y: 1.7,
    w: 8.8,
    h: 1.4,
    fontSize: 34,
    bold: true,
    color: "FFFFFF",
    breakLine: false,
  });
  cover.addText(
    isCalendarDocument(req)
      ? req.rangeLabel
      : (req.subtitle ?? "Briefing prepared by ECOS"),
    {
      x: 0.6,
      y: 3.1,
      w: 8.8,
      h: 0.5,
      fontSize: 18,
      color: "D1D5DB",
    },
  );
  cover.addText(
    `Prepared ${generatedAt(req).toISOString().slice(0, 10)} · ${timezone}${
      req.generatedFor ? ` · ${req.generatedFor}` : ""
    }`,
    { x: 0.6, y: 3.7, w: 8.8, h: 0.4, fontSize: 12, color: "9CA3AF" },
  );

  if (isCalendarDocument(req)) {
    const days = groupEventsByDay(req);
    if (days.length === 0) {
      const slide = pptx.addSlide();
      slide.addText("No events are scheduled in this period.", {
        x: 0.6,
        y: 2.5,
        w: 8.8,
        h: 0.8,
        fontSize: 20,
        color: "374151",
      });
    }

    for (const day of days) {
      for (let i = 0; i < day.events.length; i += SLIDE_EVENTS) {
        const chunk = day.events.slice(i, i + SLIDE_EVENTS);
        const slide = pptx.addSlide();
        slide.addText(day.label, {
          x: 0.5,
          y: 0.35,
          w: 9,
          h: 0.6,
          fontSize: 26,
          bold: true,
          color: "111827",
        });
        slide.addShape(pptx.ShapeType.line, {
          x: 0.5,
          y: 1.05,
          w: 9,
          h: 0,
          line: { color: "D1D5DB", width: 1 },
        });
        slide.addText(
          chunk.map((event) => ({
            text: `${formatEventTime(event, timezone)}   ${event.title}${
              event.location ? ` — ${event.location}` : ""
            }`,
            options: { bullet: true, breakLine: true },
          })),
          {
            x: 0.6,
            y: 1.3,
            w: 8.8,
            h: 4.4,
            fontSize: 16,
            color: "1F2937",
            valign: "top",
            lineSpacingMultiple: 1.3,
          },
        );
        if (i + SLIDE_EVENTS < day.events.length) {
          slide.addText("continued", {
            x: 8.2,
            y: 5.05,
            w: 1.2,
            h: 0.3,
            fontSize: 10,
            color: "9CA3AF",
          });
        }
      }
    }
  } else {
    const requestedTotal = req.slideCount ?? req.sections.length + 1;
    const contentSlides = Math.max(0, requestedTotal - 1);
    const sections =
      contentSlides > 0 ? fitSectionsForSlides(req.sections, contentSlides) : [];
    for (const section of sections) {
      const slide = pptx.addSlide();
      slide.addText(section.heading, {
        x: 0.5,
        y: 0.35,
        w: 9,
        h: 0.65,
        fontSize: section.heading.length > 52 ? 20 : 25,
        bold: true,
        color: "111827",
      });
      slide.addShape(pptx.ShapeType.line, {
        x: 0.5,
        y: 1.05,
        w: 9,
        h: 0,
        line: { color: "D1D5DB", width: 1 },
      });
      const lines = sectionLines(section);
      slide.addText(
        lines.map((line) => ({
          text: line,
          options: { bullet: true, breakLine: true },
        })),
        {
          x: 0.65,
          y: 1.3,
          w: 8.7,
          h: 4.35,
          fontSize: lines.length > 9 ? 12 : lines.length > 6 ? 14 : 16,
          color: "1F2937",
          valign: "top",
          lineSpacingMultiple: 1.25,
        },
      );
    }
  }

  await pptx.writeFile({ fileName: path });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render one document to `path`. The caller owns the directory and is
 * responsible for deleting the file after delivery.
 */
export async function generateDocument(
  req: DocumentRequest,
  path: string,
  limits: DocumentLimits = DEFAULT_DOCUMENT_LIMITS,
): Promise<GeneratedDocument> {
  assertRequest(req, limits);
  if (req.kind === "pdf") await renderPdf(req, path);
  else if (req.kind === "docx") await renderDocx(req, path);
  else if (req.kind === "pptx") await renderPptx(req, path);
  else throw new Error(`unsupported document format: ${String(req.kind)}`);

  const file = await stat(path);
  return {
    path,
    filename: documentFilename(req, generatedAt(req)),
    mimeType: DOCUMENT_MIME[req.kind],
    bytes: file.size,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  reason: string | null;
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Verify a generated file before it can be uploaded: size, magic bytes and
 * (for OOXML) the package entries the format requires. A document that fails
 * here is never sent to the user.
 */
export async function validateDocument(
  path: string,
  kind: DocumentRequest["kind"],
  limits: DocumentLimits = DEFAULT_DOCUMENT_LIMITS,
): Promise<ValidationResult> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { valid: false, reason: "the generated file is missing" };
  }
  if (size === 0) return { valid: false, reason: "the generated file is empty" };
  if (size > limits.maxBytes) {
    return {
      valid: false,
      reason: `the generated file is ${size} bytes, above the ${limits.maxBytes}-byte limit`,
    };
  }

  const buffer = await readFile(path);
  if (kind === "pdf") {
    if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return { valid: false, reason: "the generated file is not a PDF" };
    }
    // A complete PDF ends with %%EOF (trailing whitespace is allowed).
    const tail = buffer.subarray(Math.max(0, buffer.length - 2048)).toString("latin1");
    if (!tail.includes("%%EOF")) {
      return { valid: false, reason: "the PDF is truncated" };
    }
    return { valid: true, reason: null };
  }

  if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    return { valid: false, reason: `the generated file is not a ${kind.toUpperCase()}` };
  }
  try {
    const zip = await JSZip.loadAsync(buffer);
    const required =
      kind === "docx"
        ? ["[Content_Types].xml", "word/document.xml"]
        : ["[Content_Types].xml", "ppt/presentation.xml"];
    for (const entry of required) {
      if (!zip.file(entry)) {
        return {
          valid: false,
          reason: `${kind.toUpperCase()} package is missing ${entry}`,
        };
      }
    }
    return { valid: true, reason: null };
  } catch {
    return { valid: false, reason: `the ${kind.toUpperCase()} package is corrupt` };
  }
}
