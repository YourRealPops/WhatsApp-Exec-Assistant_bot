import express, { type Express } from "express";
import type { Db } from "@exec-assistant/db";
import type { PipelineDeps } from "./pipeline.js";
import { webhookRouter, type WebhookConfig } from "./routes/webhook.js";
import { authRouter, type AuthConfig } from "./routes/auth.js";
import { debugRouter } from "./routes/debug.js";

export interface AppConfig {
  pipeline: PipelineDeps;
  db: Db;
  webhook: Omit<WebhookConfig, "pipeline">;
  auth: AuthConfig;
  debug: boolean;
}

export function createApp(cfg: AppConfig): Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(webhookRouter({ ...cfg.webhook, pipeline: cfg.pipeline }));
  app.use(authRouter(cfg.auth));

  if (cfg.debug) {
    app.use(debugRouter(cfg.db, cfg.pipeline.defaultTimezone));
  } else {
    app.use("/debug", (_req, res) => {
      res.status(404).json({ error: "debug routes are disabled" });
    });
  }

  return app;
}
