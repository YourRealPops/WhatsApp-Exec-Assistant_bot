import { test } from "node:test";
import assert from "node:assert/strict";
import {
  briefFromPayload,
  buildFallbackContent,
  generateAuthoredContent,
  normalizeAuthoredContent,
} from "./document-content.js";

const brief = {
  kind: "pptx" as const,
  subject: "cybersecurity",
  prompt: "Create a PowerPoint presentation about cybersecurity with 10 slides",
  slideCount: 10,
};

test("the no-LLM fallback authors a complete, grounded deck", async () => {
  const authored = await generateAuthoredContent(brief, null);
  assert.equal(authored.sections.length, 9, "cover + nine content slides");
  assert.equal(authored.title, "cybersecurity");
  assert.ok(authored.sections.every((section) => section.heading.length > 0));
  assert.ok(
    authored.sections.every(
      (section) => (section.paragraphs?.length ?? 0) + (section.bullets?.length ?? 0) > 0,
    ),
  );
  const text = JSON.stringify(authored);
  assert.doesNotMatch(text, /https?:\/\//, "no invented sources");
  assert.doesNotMatch(text, /\b\d{4}\b/, "no invented years");
});

test("PDF fallback sections are specific to the requested subject", () => {
  const authored = buildFallbackContent({
    kind: "pdf",
    subject: "artificial intelligence",
    prompt: "Create a PDF report about artificial intelligence",
  });
  assert.equal(authored.sections.length, 5);
  assert.match(JSON.stringify(authored), /artificial intelligence/);
});

test("malformed or empty authored content is rejected for retry", () => {
  assert.throws(
    () => normalizeAuthoredContent({ sections: [] }, brief),
    /no usable sections/,
  );
  assert.throws(
    () => normalizeAuthoredContent({ sections: [{ heading: "", bullets: ["x"] }] }, brief),
    /no usable sections/,
  );
});

test("model content is sanitised and keeps authored structure", () => {
  const authored = normalizeAuthoredContent(
    {
      title: "  Security briefing  ",
      subtitle: "What leaders should know",
      sections: [
        {
          heading: " Threat landscape ",
          paragraphs: ["  Attacks are increasingly automated.  "],
          bullets: ["  Patch known vulnerabilities.  ", "", 42],
        },
      ],
    },
    brief,
  );
  assert.equal(authored.title, "Security briefing");
  assert.equal(authored.sections.length, 1);
  assert.deepEqual(authored.sections[0], {
    heading: "Threat landscape",
    paragraphs: ["Attacks are increasingly automated."],
    bullets: ["Patch known vulnerabilities."],
  });
});

test("the model-backed path asks for the requested slide count", async () => {
  const previous = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    body = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Cybersecurity",
                subtitle: "A board briefing",
                sections: [{ heading: "Why it matters", bullets: ["Risk is rising."] }],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const authored = await generateAuthoredContent(brief, {
      baseUrl: "https://llm.example/v1",
      apiKey: "test",
      model: "test-model",
    });
    assert.equal(authored.title, "Cybersecurity");
    assert.match(body, /exactly 9 sections/);
    assert.match(body, /Do not invent statistics/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("a persisted general brief retains its prompt and slide count", () => {
  const parsed = briefFromPayload(
    {
      source: "general",
      subject: "artificial intelligence",
      prompt: "Create a PDF report about artificial intelligence",
      slideCount: 6,
    },
    { kind: "pdf", title: "Fallback title", userName: "Ada" },
  );
  assert.equal(parsed.subject, "artificial intelligence");
  assert.match(parsed.prompt, /PDF report/);
  assert.equal(parsed.slideCount, 6);
  assert.equal(parsed.userName, "Ada");
});
