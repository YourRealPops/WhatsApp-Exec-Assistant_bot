import { pathToFileURL } from "node:url";
import { createDb, ensureUser, listHistory, runMigrations, type Db } from "@exec-assistant/db";
import { createConfiguredSender, type Sender } from "@exec-assistant/whatsapp";
import { env } from "./config/env.js";
import { FIRST_CONTACT_GREETING, sendFirstContact } from "./pipeline.js";

/**
 * Outbound first contact.
 *
 * On WhatsApp ECOS can only be the one who speaks first if someone does the
 * opening send: a user row is otherwise created by their own message. This
 * module sends the introduction to phone numbers that have never written in,
 * records it exactly like a pipeline turn, and the reply is then read as the
 * onboarding answer (name + designation).
 *
 * Meta only allows free-form text inside the 24h customer-service window, so a
 * cold number is messaged with the approved intro template instead — set
 * INTRO_TEMPLATE_NAME to its name. Run it with:
 *
 *   pnpm --filter @exec-assistant/api intro +2348012345678 [--force]
 */

export interface IntroOutcome {
  phone: string;
  status: "sent" | "already-greeted" | "failed";
  via?: "text" | "template";
  detail?: string;
}

export interface IntroDeps {
  db: Db;
  sender: Sender;
  defaultTimezone: string;
  templateName?: string;
  templateLanguage?: string;
}

/** True once the introduction is already part of the conversation. */
export function hasIntroduction(
  history: { direction: string; body: string }[],
): boolean {
  return history.some(
    (m) => m.direction === "outbound" && m.body === FIRST_CONTACT_GREETING,
  );
}

/** Meta's re-engagement rejection: the 24h window is closed. */
function outsideWindow(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /131047|re-engagement|24 ?h(our|r)|outside (the )?(24|messaging)/i.test(
    message,
  );
}

function normalizePhone(input: string): string {
  return input.replace(/[\s-]/g, "").replace(/^\+/, "");
}

export async function runIntro(
  deps: IntroDeps,
  phones: string[],
  opts: { force?: boolean } = {},
): Promise<IntroOutcome[]> {
  const outcomes: IntroOutcome[] = [];

  for (const raw of phones) {
    const phone = normalizePhone(raw);
    try {
      const user = await ensureUser(deps.db, {
        phone,
        timezone: deps.defaultTimezone,
      });
      const history = await listHistory(deps.db, user.id, 50);
      if (!opts.force && hasIntroduction(history)) {
        outcomes.push({ phone, status: "already-greeted" });
        continue;
      }

      // Free-form first; a closed window falls back to the approved template.
      let via: "text" | "template" = "text";
      const deliver = async (): Promise<void> => {
        try {
          await deps.sender.sendText(phone, FIRST_CONTACT_GREETING);
        } catch (err) {
          if (!deps.templateName || !outsideWindow(err)) throw err;
          via = "template";
          await deps.sender.sendTemplate(
            phone,
            deps.templateName,
            deps.templateLanguage ?? "en",
            [],
          );
        }
      };

      await sendFirstContact(deps, { userId: user.id, phone, deliver });
      outcomes.push({ phone, status: "sent", via });
    } catch (err) {
      outcomes.push({
        phone,
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcomes;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const phones = args.filter((a) => !a.startsWith("--"));

  if (phones.length === 0) {
    console.error(
      "usage: pnpm --filter @exec-assistant/api intro <phone> [more phones…] [--force]",
    );
    process.exit(1);
  }

  const db = createDb(env.databaseUrl(), { max: 3 });
  await runMigrations(db);

  const sender = createConfiguredSender({
    mode: env.senderMode,
    accessToken: env.meta.tryAccessToken(),
    phoneNumberId: env.meta.tryPhoneNumberId(),
    apiVersion: env.meta.apiVersion,
  });

  const outcomes = await runIntro(
    {
      db,
      sender,
      defaultTimezone: env.defaultTimezone,
      templateName: env.intro.templateName,
      templateLanguage: env.intro.templateLanguage,
    },
    phones,
    { force },
  );

  for (const outcome of outcomes) {
    console.log(
      `[intro] ${outcome.phone}: ${outcome.status}` +
        `${outcome.via ? ` via ${outcome.via}` : ""}` +
        `${outcome.detail ? ` — ${outcome.detail}` : ""}`,
    );
  }

  await db.end().catch(() => {});
  process.exit(outcomes.some((o) => o.status === "failed") ? 1 : 0);
}

// Only run when invoked as a script (`pnpm intro <phone>`), never when the
// module is imported by tests.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error("[intro] failed:", err);
    process.exit(1);
  });
}
