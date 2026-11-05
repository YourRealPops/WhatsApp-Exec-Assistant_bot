import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "@exec-assistant/db";
import type { Sender } from "@exec-assistant/whatsapp";
import { FIRST_CONTACT_GREETING } from "./pipeline.js";
import { hasIntroduction, runIntro, type IntroDeps } from "./intro.js";

const UID = "3b2f9c1e-7a4d-4c6b-8e10-5d2c9b8a7f61";
const PHONE = "2348012345678";

interface Row {
  id: string;
  user_id: string;
  direction: "inbound" | "outbound";
  body: string;
  created_at: Date;
}

/** Only ensureUser, listHistory and saveMessage are reached — same trick as the pipeline test. */
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
      messages.push({
        id: String(values[0]),
        user_id: String(values[1]),
        direction: values[2] as "inbound" | "outbound",
        body: String(values[3]),
        created_at: new Date(),
      });
      return Promise.resolve([{ id: values[0] }]);
    }
    if (sql.includes("from messages")) return Promise.resolve([...messages].reverse());
    if (sql.includes("insert into users")) return Promise.resolve([user]);
    return Promise.resolve([]);
  }) as unknown as Db;

  return { db: fake, messages };
}

function createSender(opts: { failText?: Error } = {}) {
  const sent: string[] = [];
  const sender: Sender = {
    kind: "test",
    async sendText(_to, text) {
      if (opts.failText) throw opts.failText;
      sent.push(text);
      return `test:${sent.length}`;
    },
    async sendTemplate(_to, name, _language) {
      sent.push(`[template ${name}]`);
      return `test:${sent.length}`;
    },
  };
  return { sender, sent };
}

function deps(sender: Sender, extra: Partial<IntroDeps> = {}): IntroDeps {
  return {
    db: createFakeDb().db,
    sender,
    defaultTimezone: "Africa/Lagos",
    ...extra,
  };
}

const WINDOW_CLOSED = new Error(
  "WhatsApp send failed (400): (#131047) Re-engagement message",
);

test("a number that never wrote in gets the introduction first", async () => {
  const { db, messages } = createFakeDb();
  const { sender, sent } = createSender();

  const outcomes = await runIntro(deps(sender, { db }), [PHONE]);

  assert.deepEqual(outcomes, [{ phone: PHONE, status: "sent", via: "text" }]);
  assert.deepEqual(sent, [FIRST_CONTACT_GREETING]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].direction, "outbound");
  assert.equal(messages[0].body, FIRST_CONTACT_GREETING);
});

test("the introduction is never sent twice unless forced", async () => {
  const { db } = createFakeDb();
  const { sender, sent } = createSender();

  await runIntro(deps(sender, { db }), [PHONE]);
  const again = await runIntro(deps(sender, { db }), [PHONE]);
  assert.deepEqual(again, [{ phone: PHONE, status: "already-greeted" }]);
  assert.equal(sent.length, 1);

  await runIntro(deps(sender, { db }), [PHONE], { force: true });
  assert.equal(sent.length, 2);
});

test("a closed 24h window falls back to the approved template", async () => {
  const { db, messages } = createFakeDb();
  const { sender, sent } = createSender({ failText: WINDOW_CLOSED });

  const outcomes = await runIntro(
    deps(sender, { db, templateName: "ecos_intro", templateLanguage: "en" }),
    [PHONE],
  );

  assert.deepEqual(outcomes, [{ phone: PHONE, status: "sent", via: "template" }]);
  assert.deepEqual(sent, ["[template ecos_intro]"]);
  // The opener still lands in history, so the reply is the onboarding answer.
  assert.equal(messages[0].body, FIRST_CONTACT_GREETING);
});

test("without a template a closed window fails loudly and records nothing", async () => {
  const { db, messages } = createFakeDb();
  const { sender } = createSender({ failText: WINDOW_CLOSED });

  const outcomes = await runIntro(deps(sender, { db }), [PHONE]);

  assert.equal(outcomes[0].status, "failed");
  assert.match(String(outcomes[0].detail), /131047/);
  // Nothing recorded: their next message still triggers the greeting.
  assert.equal(messages.length, 0);
});

test("hasIntroduction only matches the opener, sent outbound", () => {
  assert.equal(
    hasIntroduction([
      { direction: "inbound", body: FIRST_CONTACT_GREETING },
      { direction: "outbound", body: FIRST_CONTACT_GREETING },
    ]),
    true,
  );
  assert.equal(hasIntroduction([{ direction: "inbound", body: "hi" }]), false);
});
