import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "@exec-assistant/db";
import type { Sender } from "@exec-assistant/whatsapp";
import {
  FIRST_CONTACT_GREETING,
  handleUserText,
  processInbound,
  type PipelineDeps,
} from "./pipeline.js";

const UID = "6f1d5a3c-2b7e-4f5a-9c8d-0a1b2c3d4e5f";
const PHONE = "+2348012345678";

interface Row {
  id: string;
  user_id: string;
  direction: "inbound" | "outbound";
  body: string;
  created_at: Date;
}

/**
 * The turn only touches getUserById, listHistory and saveMessage, so a tagged
 * stand-in with those three shapes is a faithful Db here (same trick as the
 * auth route test) — no database needed for a pipeline test.
 */
function createFakeDb() {
  const messages: Row[] = [];
  const user = {
    id: UID,
    phone: PHONE,
    name: null as string | null,
    designation: null as string | null,
    timezone: "Africa/Lagos",
    created_at: new Date(),
  };

  const fake = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("insert into messages")) {
      if (messages.some((message) => message.id === String(values[0]))) {
        return Promise.resolve([]);
      }
      messages.push({
        id: String(values[0]),
        user_id: String(values[1]),
        direction: values[2] as "inbound" | "outbound",
        body: String(values[3]),
        created_at: new Date(),
      });
      return Promise.resolve([{ id: values[0] }]);
    }
    if (sql.includes("from messages")) {
      // The repo asks for newest-first and reverses; keep that contract.
      return Promise.resolve([...messages].reverse());
    }
    if (sql.includes("insert into users")) return Promise.resolve([user]);
    if (sql.includes("insert into document_jobs")) {
      return Promise.resolve([
        {
          id: "job-1",
          status: "queued",
          user_id: UID,
          kind: values[2],
          title: values[3],
          payload: values[4],
        },
      ]);
    }
    if (sql.includes("update users")) {
      // setUserProfile coalesces: an omitted field keeps its stored value.
      user.name = (values[0] as string | null) ?? user.name;
      user.designation = (values[1] as string | null) ?? user.designation;
      return Promise.resolve([user]);
    }
    if (sql.includes("from users")) return Promise.resolve([user]);
    return Promise.resolve([]);
  }) as unknown as Db;

  return { db: fake, messages, user };
}

function createSender(opts: { failTyping?: boolean } = {}) {
  const sent: string[] = [];
  const typing: string[] = [];
  const order: string[] = [];
  const sender: Sender = {
    kind: "test",
    async sendTypingIndicator(messageId) {
      typing.push(messageId);
      order.push(`typing:${messageId}`);
      if (opts.failTyping) throw new Error("typing unavailable");
    },
    async sendText(_to, text) {
      sent.push(text);
      order.push(`text:${text}`);
      return `test:${sent.length}`;
    },
    async sendTemplate(_to, name, _language, params) {
      sent.push(`[template ${name}] ${params.join(" | ")}`);
      return `test:${sent.length}`;
    },
    async sendButtons(_to, _text, _buttons) {
      return `test:${sent.length}`;
    },
  };
  return { sender, sent, typing, order };
}

function deps(db: Db, sender: Sender): PipelineDeps {
  return {
    db,
    sender,
    llm: null,
    devCalendar: false,
    defaultTimezone: "Africa/Lagos",
  };
}

test("a normal inbound message triggers one typing indicator before the reply", async () => {
  const { db } = createFakeDb();
  const { sender, typing, order } = createSender();
  await processInbound(deps(db, sender), [
    {
      id: "wamid.typing.1",
      from: PHONE,
      type: "text",
      text: "hello",
      timestamp: new Date(),
      replyId: null,
    },
  ]);
  assert.deepEqual(typing, ["wamid.typing.1"]);
  assert.equal(order[0], "typing:wamid.typing.1", "indicator goes first");
  assert.ok(order.some((entry) => entry.startsWith("text:")), "the reply still sends");
});

test("calendar and document requests both show typing before work starts", async () => {
  for (const [index, text] of [
    "what's on my calendar today?",
    "Create a PDF report about artificial intelligence",
  ].entries()) {
    const { db } = createFakeDb();
    const { sender, typing } = createSender();
    const id = `wamid.typing.request.${index}`;
    await processInbound(deps(db, sender), [
      { id, from: PHONE, type: "text", text, timestamp: new Date(), replyId: null },
    ]);
    assert.deepEqual(typing, [id], `typing for: ${text}`);
  }
});

test("a failed typing indicator never blocks the reply", async () => {
  const { db } = createFakeDb();
  const { sender, sent } = createSender({ failTyping: true });
  await processInbound(deps(db, sender), [
    {
      id: "wamid.typing.fail",
      from: PHONE,
      type: "text",
      text: "hello",
      timestamp: new Date(),
      replyId: null,
    },
  ]);
  assert.ok(sent.length > 0, "the bot still replies");
});

test("duplicate webhook delivery does not reprocess or re-trigger typing", async () => {
  const { db, messages } = createFakeDb();
  const { sender, typing, sent } = createSender();
  const delivery = [
    {
      id: "wamid.dup.1",
      from: PHONE,
      type: "text" as const,
      text: "hello",
      timestamp: new Date(),
      replyId: null,
    },
  ];
  await processInbound(deps(db, sender), delivery);
  await processInbound(deps(db, sender), delivery);
  assert.deepEqual(typing, ["wamid.dup.1"]);
  assert.equal(messages.filter((m) => m.id === "wamid.dup.1").length, 1);
  assert.equal(sent.length, 1, "the reply is sent only once");
});

test("ECOS sends the introduction before it answers anything", async () => {
  const { db, messages } = createFakeDb();
  const { sender, sent } = createSender();

  const result = await handleUserText(deps(db, sender), {
    userId: UID,
    phone: PHONE,
    text: "what's on my calendar today?",
  });

  assert.equal(result.mode, "onboarding");
  assert.equal(result.reply, FIRST_CONTACT_GREETING);
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(sent, [FIRST_CONTACT_GREETING]);

  const outbound = messages.filter((m) => m.direction === "outbound");
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].body, FIRST_CONTACT_GREETING);
});

test("the introduction is asked once — the answer is handled normally", async () => {
  const { db, messages, user } = createFakeDb();
  const { sender, sent } = createSender();
  const pipeline = deps(db, sender);

  await handleUserText(pipeline, { userId: UID, phone: PHONE, text: "hi" });
  messages.push({
    id: "wamid.2",
    user_id: UID,
    direction: "inbound",
    body: "Ada Lovelace, CTO at Analytic Engines",
    created_at: new Date(),
  });

  const second = await handleUserText(pipeline, {
    userId: UID,
    phone: PHONE,
    text: "Ada Lovelace, CTO at Analytic Engines",
    excludeMessageId: "wamid.2",
  });

  assert.notEqual(second.reply, FIRST_CONTACT_GREETING);
  assert.equal(second.mode, "fallback");
  assert.equal(sent.filter((t) => t === FIRST_CONTACT_GREETING).length, 1);
  assert.equal(sent.length, 2);

  // ...and the answer to the greeting is stored as the profile.
  assert.equal(user.name, "Ada Lovelace");
  assert.equal(user.designation, "CTO at Analytic Engines");
});

test("a bare name with no designation is stored on its own", async () => {
  const { db, messages, user } = createFakeDb();
  const { sender } = createSender();
  const pipeline = deps(db, sender);

  await handleUserText(pipeline, { userId: UID, phone: PHONE, text: "hi" });
  messages.push({
    id: "wamid.3",
    user_id: UID,
    direction: "inbound",
    body: "Ada Lovelace",
    created_at: new Date(),
  });

  await handleUserText(pipeline, {
    userId: UID,
    phone: PHONE,
    text: "Ada Lovelace",
    excludeMessageId: "wamid.3",
  });

  assert.equal(user.name, "Ada Lovelace");
  assert.equal(user.designation, null);
});

test("a later 'call me…' edit replaces the stored name", async () => {
  const { db, messages, user } = createFakeDb();
  const { sender } = createSender();
  const pipeline = deps(db, sender);
  user.name = "Ada Lovelace";
  messages.push({
    id: "wamid.5",
    user_id: UID,
    direction: "inbound",
    body: "what's on today",
    created_at: new Date(),
  });
  messages.push({
    id: "out:5",
    user_id: UID,
    direction: "outbound",
    body: "Nothing on the calendar for 2026-11-05.",
    created_at: new Date(),
  });
  messages.push({
    id: "wamid.4",
    user_id: UID,
    direction: "inbound",
    body: "call me Ada",
    created_at: new Date(),
  });

  const result = await handleUserText(pipeline, {
    userId: UID,
    phone: PHONE,
    text: "call me Ada",
    excludeMessageId: "wamid.4",
  });

  assert.equal(user.name, "Ada");
  assert.match(result.reply, /I'll call you Ada/);
});

test("a user with history never gets the introduction", async () => {
  const { db, messages } = createFakeDb();
  messages.push({
    id: "wamid.0",
    user_id: UID,
    direction: "inbound",
    body: "what's on today",
    created_at: new Date(),
  });
  messages.push({
    id: "out:0",
    user_id: UID,
    direction: "outbound",
    body: "Nothing on the calendar for 2026-11-05.",
    created_at: new Date(),
  });
  const { sender, sent } = createSender();

  const result = await handleUserText(deps(db, sender), {
    userId: UID,
    phone: PHONE,
    text: "help",
  });

  assert.notEqual(result.reply, FIRST_CONTACT_GREETING);
  assert.ok(!sent.includes(FIRST_CONTACT_GREETING));
});
