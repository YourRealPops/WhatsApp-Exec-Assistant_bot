import { Router, type Response } from "express";
import {
  getUserById,
  upsertCalendarAccount,
  type Db,
} from "@exec-assistant/db";
import {
  buildAuthUrl,
  exchangeCode,
  signState,
  verifyState,
} from "@exec-assistant/calendar";

export interface AuthConfig {
  db: Db;
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  configured: boolean;
  /** HMAC key for signed connect links and OAuth state. Required when configured. */
  stateSecret?: string;
  /** Keeps the legacy raw `?user=<id>` link for local debugging only. */
  debugRoutes?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One generic answer for tampered, expired, wrong-purpose and missing tokens:
 * telling them apart only helps someone forging one.
 */
function badLink(res: Response): void {
  res
    .status(400)
    .type("text/plain")
    .send(
      "This calendar link is invalid or has expired — ask me for a new one in WhatsApp.",
    );
}

export function authRouter(cfg: AuthConfig): Router {
  const router = Router();

  // Step 1: verify the signed connect token, then send the browser to Google
  // with a fresh, short-lived state of its own.
  router.get("/auth/google", async (req, res) => {
    const clientId = cfg.clientId;
    const clientSecret = cfg.clientSecret;
    const secret = cfg.stateSecret;

    if (!cfg.configured || !clientId || !clientSecret) {
      return res
        .status(400)
        .type("text/plain")
        .send(
          "Google OAuth is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see .env.example).",
        );
    }
    if (!secret) {
      return res
        .status(500)
        .type("text/plain")
        .send("OAUTH_STATE_SECRET is not configured — calendar links cannot be signed.");
    }

    const token = typeof req.query.token === "string" ? req.query.token : "";
    const verified = token
      ? verifyState({ secret, token, purpose: "connect" })
      : null;
    // The old raw `?user=` link survives only while debug routes are on.
    const rawUser =
      !verified && cfg.debugRoutes ? String(req.query.user ?? "") : "";
    const userId = verified?.uid ?? rawUser;
    if (!userId) return badLink(res);

    const user = await getUserById(cfg.db, userId);
    if (!user) return badLink(res);

    res.redirect(
      buildAuthUrl({
        clientId,
        redirectUri: cfg.redirectUri,
        state: signState({ secret, uid: user.id, purpose: "oauth" }),
      }),
    );
  });

  // Step 2: verify the state we minted, exchange the code, persist the tokens.
  router.get("/auth/google/callback", async (req, res) => {
    try {
      const clientId = cfg.clientId;
      const clientSecret = cfg.clientSecret;
      const secret = cfg.stateSecret;
      const code = String(req.query.code ?? "");
      const state = String(req.query.state ?? "");
      if (!code || !state || !secret || !clientId || !clientSecret) {
        return badLink(res);
      }

      const payload = verifyState({ secret, token: state, purpose: "oauth" });
      if (!payload) return badLink(res);
      const user = await getUserById(cfg.db, payload.uid);
      if (!user) return badLink(res);

      const tokens = await exchangeCode({
        clientId,
        clientSecret,
        redirectUri: cfg.redirectUri,
        code,
      });

      await upsertCalendarAccount(cfg.db, {
        userId: user.id,
        provider: "google",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        expiresAt: tokens.expiresAt ?? null,
      });

      console.log(`[auth] google calendar connected for ${user.phone}`);
      res.status(200).type("html").send(`<!doctype html>
<html><body style="font-family: system-ui, sans-serif; padding: 48px; max-width: 520px;">
  <h1 style="margin:0 0 12px">Calendar connected ✅</h1>
  <p style="margin:0 0 8px">Google Calendar is now linked for <b>${escapeHtml(user.phone)}</b>.</p>
  <p style="margin:0; color:#555">Head back to WhatsApp — your events and the 15/10/5/0 reminder ladder start syncing within a minute.</p>
</body></html>`);
    } catch (err) {
      console.error("[auth] google callback failed:", err);
      res
        .status(500)
        .type("text/plain")
        .send(
          `Calendar connection failed: ${err instanceof Error ? err.message : "unknown error"}`,
        );
    }
  });

  return router;
}
