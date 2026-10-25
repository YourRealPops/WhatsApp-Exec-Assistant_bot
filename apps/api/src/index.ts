import { createDb, runMigrations } from "@exec-assistant/db";
import { createConfiguredSender } from "@exec-assistant/whatsapp";
import { env } from "./config/env.js";
import { createApp } from "./app.js";
import type { PipelineDeps } from "./pipeline.js";

async function main(): Promise<void> {
  const db = createDb(env.databaseUrl(), { max: 5 });
  await runMigrations(db);
  console.log("[api] migrations ok");

  const sender = createConfiguredSender({
    mode: env.senderMode,
    accessToken: env.meta.tryAccessToken(),
    phoneNumberId: env.meta.tryPhoneNumberId(),
    apiVersion: env.meta.apiVersion,
  });

  const llm = {
    baseUrl: env.llm.baseUrl,
    apiKey: env.llm.apiKey,
    model: env.llm.model,
  };

  const pipeline: PipelineDeps = {
    db,
    sender,
    llm,
    devCalendar: env.devCalendar,
    defaultTimezone: env.defaultTimezone,
  };

  const app = createApp({
    pipeline,
    db,
    webhook: {
      appSecret: env.meta.tryAppSecret(),
      verifyToken: env.meta.tryVerifyToken(),
      allowUnsigned: env.allowUnsignedWebhook,
    },
    auth: {
      db,
      clientId: env.google.clientId,
      clientSecret: env.google.clientSecret,
      redirectUri: env.google.redirectUri,
      configured: env.google.configured,
    },
    debug: env.debugRoutes,
  });

  const server = app.listen(env.port, () => {
    console.log(`[api] listening on port ${env.port}`);
    console.log(`[api]   sender:   ${sender.kind}`);
    console.log(
      `[api]   llm:      ${llm.apiKey ? `${llm.model} @ ${llm.baseUrl}` : "disabled (rule-based fallback)"}`,
    );
    console.log(
      `[api]   calendar: ${env.devCalendar ? "dev fixtures (set GOOGLE_* to go live)" : "google only"}`,
    );
    console.log(`[api]   webhook:  ${env.publicBaseUrl}/webhook`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[api] ${signal} — shutting down`);
    server.close();
    await db.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[api] failed to start:", err);
  process.exit(1);
});
