import { createDb, runMigrations } from "@exec-assistant/db";
import { createConfiguredSender } from "@exec-assistant/whatsapp";
import { env } from "./config/env.js";
import { materialize, seedDevCalendars, syncCalendars, type WorkerConfig } from "./sync.js";
import { dispatchDue } from "./dispatch.js";

async function main(): Promise<void> {
  const db = createDb(env.databaseUrl(), { max: 5 });
  await runMigrations(db);

  const sender = createConfiguredSender({
    mode: env.senderMode,
    accessToken: env.meta.accessToken,
    phoneNumberId: env.meta.phoneNumberId,
    apiVersion: env.meta.apiVersion,
  });

  const cfg: WorkerConfig = {
    db,
    sender,
    offsets: env.offsets,
    maxOffsetMinutes: env.maxOffsetMinutes,
    lookaheadDays: env.lookaheadDays,
    syncIntervalMs: env.syncIntervalMs,
    maxSendAttempts: env.maxSendAttempts,
    batchSize: env.batchSize,
    devCalendar: env.devCalendar,
    google: env.google,
    template: env.reminderTemplate,
  };

  console.log("[worker] boot");
  console.log(`[worker]   sender:    ${sender.kind}`);
  console.log(`[worker]   ladder:    T-${env.offsets.join("/T-")} minutes`);
  console.log(`[worker]   tick:      every ${env.tickMs}ms`);
  console.log(`[worker]   calendar:  ${env.devCalendar ? "dev fixtures enabled" : "google sync only"}`);
  console.log(
    `[worker]   templates: ${env.reminderTemplate.name ?? "none (free-form text within the 24h window)"}`,
  );

  let running = false;
  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const synced = await syncCalendars(cfg);
      const seeded = await seedDevCalendars(cfg);
      const ladder = await materialize(cfg);
      const { sent, failed } = await dispatchDue(cfg);
      if (synced || seeded || ladder || sent || failed) {
        console.log(
          `[worker] tick: synced=${synced} seeded=${seeded} ladder=${ladder} sent=${sent} failed=${failed}`,
        );
      }
    } catch (err) {
      console.error("[worker] tick failed:", err);
    } finally {
      running = false;
    }
  }

  await tick();
  const timer = setInterval(() => void tick(), env.tickMs);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[worker] ${signal} — shutting down`);
    clearInterval(timer);
    await db.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] failed to start:", err);
  process.exit(1);
});
