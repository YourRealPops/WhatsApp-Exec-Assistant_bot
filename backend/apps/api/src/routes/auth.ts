import { Router } from "express";
import {
  getUserById,
  upsertCalendarAccount,
  type Db,
} from "@exec-assistant/db";
import { buildAuthUrl, exchangeCode } from "@exec-assistant/calendar";

export interface AuthConfig {
  db: Db;
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  configured: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function authRouter(cfg: AuthConfig): Router {
  const router = Router();

  // Step 1: send the user's browser to Google's consent screen.
  // state carries the user id (a UUID) so the callback can attribute tokens.
  router.get("/auth/google", async (req, res) => {
    if (!cfg.configured || !cfg.clientId || !cfg.clientSecret) {
      return res
        .status(400)
        .type("text/plain")
        .send(
          "Google OAuth is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see .env.example).",
        );
    }
    const userId = String(req.query.user ?? "");
    if (!userId) return res.status(400).type("text/plain").send("missing ?user=");
    const user = await getUserById(cfg.db, userId);
    if (!user) return res.status(404).type("text/plain").send("unknown user");

    res.redirect(
      buildAuthUrl({
        clientId: cfg.clientId,
        redirectUri: cfg.redirectUri,
        state: user.id,
      }),
    );
  });

  // Step 2: exchange the code, persist the tokens, confirm in the browser.
  router.get("/auth/google/callback", async (req, res) => {
    try {
      const code = String(req.query.code ?? "");
      const state = String(req.query.state ?? "");
      if (!code || !state) {
        return res.status(400).type("text/plain").send("missing code or state");
      }
      const user = await getUserById(cfg.db, state);
      if (!user) return res.status(404).type("text/plain").send("unknown user");

      const tokens = await exchangeCode({
        clientId: cfg.clientId!,
        clientSecret: cfg.clientSecret!,
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
