import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import { createDb, ensureUser, runMigrations, saveMessage } from "@exec-assistant/db";
import type { Sender } from "@exec-assistant/whatsapp";
import { env } from "./config/env.js";
import { handleUserText, type PipelineDeps } from "./pipeline.js";

/**
 * Local REPL for the assistant — exercises the exact same pipeline as the
 * WhatsApp webhook (history, tools, agent, outbound persistence), so you can
 * develop without Meta credentials. Run with: pnpm dev:cli
 */
async function main(): Promise<void> {
  const db = createDb(env.databaseUrl(), { max: 3 });
  await runMigrations(db);

  const sender: Sender = {
    kind: "cli",
    async sendText(_to, text) {
      console.log(`\nassistant> ${text}\n`);
      return `cli:${randomUUID()}`;
    },
    async sendTemplate(_to, name, _language, params) {
      console.log(
        `\nassistant> [template: ${name} ${params.join(" | ")}]\n`,
      );
      return `cli:${randomUUID()}`;
    },
  };

  const deps: PipelineDeps = {
    db,
    sender,
    llm: {
      baseUrl: env.llm.baseUrl,
      apiKey: env.llm.apiKey,
      model: env.llm.model,
    },
    devCalendar: env.devCalendar,
    defaultTimezone: env.defaultTimezone,
  };

  const phone = process.env.CLI_PHONE ?? "cli-local";
  const user = await ensureUser(db, {
    phone,
    timezone: env.defaultTimezone,
    name: process.env.CLI_NAME ?? null,
  });

  console.log("Assistant CLI — same pipeline as WhatsApp, local only.");
  console.log(
    `  llm: ${env.llm.apiKey ? `${env.llm.model}` : "off (rule-based fallback)"} | calendar: ${env.devCalendar ? "dev fixtures" : "google"} | /quit to exit\n`,
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      let line: string;
      try {
        line = (await rl.question("you> ")).trim();
      } catch (err) {
        // stdin closed (Ctrl+D or piped input ended) — exit quietly.
        if ((err as NodeJS.ErrnoException)?.code === "ERR_USE_AFTER_CLOSE") break;
        throw err;
      }
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;

      const id = `cli:${randomUUID()}`;
      await saveMessage(db, {
        id,
        userId: user.id,
        direction: "inbound",
        body: line,
      });
      try {
        await handleUserText(deps, {
          userId: user.id,
          phone,
          text: line,
          excludeMessageId: id,
        });
      } catch (err) {
        console.error("error:", err instanceof Error ? err.message : err);
      }
    }
  } finally {
    rl.close();
    await db.end().catch(() => {});
  }
  console.log("bye!");
}

main().catch((err) => {
  console.error("[cli] failed:", err);
  process.exit(1);
});
