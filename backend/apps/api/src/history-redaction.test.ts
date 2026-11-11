import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "@exec-assistant/db";
import { listHistory, redactMessageBodies } from "@exec-assistant/db";
import type { Message } from "@exec-assistant/db";

/**
 * Fake Db for the calendar db package: answers the SQL shapes it uses (select
 * * from messages, and select * from users) so the history redaction is a
 * unit test with no real database.
 */
function createRepoDb() {
  const rows = new Map<string, Message[]>();

  const fake = ((strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const sql = strings.join("?");
    if (sql.includes("from messages")) {
      const key = `messages:${values[0]}`;
      return Promise.resolve((rows.get(key) ?? []).reverse());
    }
    if (sql.includes("from users")) {
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Db;

  return {
    fake,
    setMessages(userId: string, msgs: Message[]) {
      rows.set(`messages:${userId}`, [...msgs].reverse());
    },
  };
}

test("listHistory never hands the LLM an unredacted calendar link", async () => {
  const { fake, setMessages } = createRepoDb();
  const oldLink = "https://ecos.example.com/auth/google?token=deadbeef.old.token&theme=dark";
  const freshLink = "https://ecos.example.com/auth/google?token=new.fresh.token&theme=dark";

  // A message from days ago pasted the expired link into its reply.
  await setMessages("user-1", [
    {
      id: "m-old",
      user_id: "user-1",
      direction: "outbound",
      body: `Here is the link from last week: ${oldLink}`,
      channel: "whatsapp",
      created_at: new Date(),
    },
    {
      id: "m-new",
      user_id: "user-1",
      direction: "outbound",
      body: `Here is a new link: ${freshLink}`,
      channel: "whatsapp",
      created_at: new Date(),
    },
  ]);

  const history = await listHistory(fake, "user-1", 20);
  const bodies = history.map((m) => m.body);

  // The old link must be redacted everywhere it appeared; only its presence
  // (or the link text with the token value clamped) may remain.
  for (const body of bodies) {
    // token= values are redacted whether a signed token or a fresh build token.
    assert.ok(body.includes("token=[redacted]"), `expected [redacted] in: ${body}`);
  }

  // The redaction helper behaves the same on an arbitrary list of messages.
  const redacted = redactMessageBodies([
    {
      id: "x",
      user_id: "u",
      direction: "outbound",
      body: `check ${freshLink} and also say token=not-a-link-here`, // not a URL: left alone
      channel: "whatsapp",
      created_at: new Date(),
    },
  ]);
  // The URL's token= value is redacted; the bare token= text that is not part
  // of a URL is left alone.
  assert.equal(
    redacted[0].body,
    `check https://ecos.example.com/auth/google?token=[redacted]&theme=dark and also say token=not-a-link-here`,
  );
});
