import { Router, raw } from "express";
import {
  parseInboundMessages,
  verifyHandshake,
  verifySignature,
  type WebhookVerifyQuery,
} from "@exec-assistant/whatsapp";
import { processInbound, type PipelineDeps } from "../pipeline.js";

export interface WebhookConfig {
  pipeline: PipelineDeps;
  appSecret?: string;
  verifyToken?: string;
  allowUnsigned: boolean;
}

export function webhookRouter(cfg: WebhookConfig): Router {
  const router = Router();

  // Meta's subscription handshake: echo hub.challenge when the token matches.
  router.get("/webhook", (req, res) => {
    const query = req.query as WebhookVerifyQuery;
    if (!cfg.verifyToken) {
      return res
        .status(503)
        .type("text/plain")
        .send("META_VERIFY_TOKEN is not configured");
    }
    if (!verifyHandshake(query, cfg.verifyToken)) {
      console.warn("[webhook] verification handshake failed");
      return res.status(403).type("text/plain").send("verification failed");
    }
    res.status(200).type("text/plain").send(query["hub.challenge"] ?? "");
  });

  // Inbound messages. Signature is checked against the *raw* body.
  router.post("/webhook", raw({ type: () => true }), (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

    if (cfg.appSecret) {
      const header = req.get("x-hub-signature-256");
      if (!verifySignature(rawBody, header, cfg.appSecret)) {
        console.warn("[webhook] rejected: invalid x-hub-signature-256");
        return res.status(403).type("text/plain").send("invalid signature");
      }
    } else if (!cfg.allowUnsigned) {
      console.warn(
        "[webhook] rejected: META_APP_SECRET not set (set ALLOW_UNSIGNED_WEBHOOK=true for local curl testing)",
      );
      return res
        .status(503)
        .type("text/plain")
        .send("META_APP_SECRET is not configured");
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      // Never make Meta retry forever over a malformed payload.
      console.warn("[webhook] unparseable body — ignored");
      return res.status(200).type("text/plain").send("ignored");
    }

    const messages = parseInboundMessages(body);

    // Acknowledge immediately; processing happens async (Meta retries on non-2xx).
    res.status(200).type("text/plain").send("ok");

    if (messages.length > 0) {
      void processInbound(cfg.pipeline, messages).catch((err) =>
        console.error("[pipeline] fatal:", err),
      );
    }
  });

  return router;
}
