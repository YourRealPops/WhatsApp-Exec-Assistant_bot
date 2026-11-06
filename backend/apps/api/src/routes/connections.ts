import { Router } from "express";
import type { Response } from "express";
import {
  getCalendarAccount,
  disconnectCalendarAccount,
  listUpcomingEvents,
  listUpcomingReminders,
  useNonce,
  type Db,
} from "@exec-assistant/db";
import {
  verifyState,
  revokeToken,
  CONNECTIONS_TOKEN_TTL_MS,
  buildConnectionsUrl,
} from "@exec-assistant/calendar";
import type {
  ConnectionStatusResult,
  DisconnectResult,
  ManageConnectionsResult,
} from "@exec-assistant/ai";

/** One generic answer for tampered, expired, wrong-purpose and missing tokens:
 * telling them apart only helps someone forging one. */
function badLink(res: Response): void {
  res
    .status(400)
    .type("text/plain")
    .send("This calendar link is invalid or has expired — ask me for a new one in WhatsApp.");
}

export interface ConnectionsContext {
  db: Db;
  userId: string;
  google: { revokeToken(token: string): Promise<boolean> } | null;
  publicBaseUrl?: string;
  oauthStateSecret?: string;
  /** The user's current message — the confirmation step reads it. */
  currentMessage: string;
}

/** Everything "what's connected?" reports, in plain words. */
export async function connectionStatus(ctx: ConnectionsContext): Promise<ConnectionStatusResult> {
  const account = await getCalendarAccount(ctx.db, ctx.userId);
  if (!account) return { connected: false, needsReconnect: false };

  const now = Date.now();
  const upcoming = await listUpcomingEvents(
    ctx.db,
    ctx.userId,
    new Date(now),
    new Date(now + 14 * 86_400_000),
    200,
  );

  return {
    connected: true,
    provider: account.provider,
    accountEmail: account.account_email ?? null,
    permission: describeScopes(account.scopes ?? []),
    connectedAt: account.connected_at ? account.connected_at.toISOString() : null,
    lastSyncAt: account.synced_at ? account.synced_at.toISOString() : null,
    lastSyncError: account.last_sync_error ?? null,
    needsReconnect: !!account.reauth_required_at,
    eventsTracked: upcoming.length,
  };
}

/** The private, time-limited link to the connections page. */
export function manageConnections(ctx: ConnectionsContext): ManageConnectionsResult {
  if (!ctx.publicBaseUrl || !ctx.oauthStateSecret) {
    throw new Error("Connections page is not configured on this server.");
  }
  return {
    url: buildConnectionsUrl({
      baseUrl: ctx.publicBaseUrl!,
      secret: ctx.oauthStateSecret!,
      uid: ctx.userId,
    }),
    expiresInMinutes: Math.round(CONNECTIONS_TOKEN_TTL_MS / 60_000),
  };
}

const AFFIRMATIVE = /^(yes|yeah|yep|yup|confirm|sure|do it|go ahead|disconnect)\b/i;

/** Disconnect is deliberately two steps: a message that merely mentions the
 * calendar never deletes anything. Only an explicit yes to our question, in
 * that same message, does. */
export async function disconnectCalendar(
  ctx: ConnectionsContext,
  args: Record<string, unknown> = {},
): Promise<DisconnectResult> {
  const account = await getCalendarAccount(ctx.db, ctx.userId);
  if (!account) {
    return {
      status: "not-connected",
      message: "No calendar is connected, so there's nothing to disconnect.",
    };
  }

  const confirmed =
    args.confirm === true && AFFIRMATIVE.test(ctx.currentMessage.trim());
  if (!confirmed) {
    const who = account.account_email ?? "your Google Calendar";
    return {
      status: "needs-confirmation",
      message: [
        `Disconnecting ${who} will:`,
        "- revoke ECOS's access at Google,",
        "- delete the stored tokens,",
        "- delete the synced events and pending reminders ECOS keeps here.",
        "Your Google Calendar itself is not touched.",
        'Reply "yes" to disconnect, or "no" to keep it.',
      ].join("\n"),
    };
  }

  // Best effort: a dead or already-revoked grant must not block cleanup.
  const token = account.refresh_token ?? account.access_token;
  const revoked = ctx.google ? await revokeToken(token) : false;

  const result = await disconnectCalendarAccount(ctx.db, ctx.userId);
  const lines = [
    revoked
      ? "Disconnected. Google access revoked."
      : "Disconnected. Google didn't confirm the revoke, but every stored token is deleted here.",
    `Removed ${result.cancelledEvents} synced event${result.cancelledEvents === 1 ? "" : "s"} and ${result.removedReminders} pending reminder${result.removedReminders === 1 ? "" : "s"}.`,
    "Your Google Calendar itself is unchanged. Say \"connect my calendar\" whenever you want it back.",
  ];

  return {
    status: "disconnected",
    message: lines.join("\n"),
    cancelledEvents: result.cancelledEvents,
    removedReminders: result.removedReminders,
  };
}

function describeScopes(scopes: string[]): string {
  const has = (needle: string) => scopes.some((s) => s.includes(needle));
  const labels: string[] = [];
  if (has("calendar.events")) labels.push("view and edit your calendar events");
  if (has("calendar.readonly")) labels.push("view your calendar");
  if (has("email")) labels.push("see which Google account you connected");
  return labels.length > 0 ? labels.join("; ") : "no calendar access recorded — reconnect to renew the permission";
}

export function connectionsRouter(cfg: {
  db: Db;
  google: { revokeToken(token: string): Promise<boolean> } | null;
  publicBaseUrl?: string;
  oauthStateSecret?: string;
}): Router {
  const router = Router();

  // GET /connections?token=<signed, purpose "connections"> renders status and a
  // Disconnect button. No state change here: the token only reads, it never
  // executes.
  router.get("/", async (req, res) => {
    const secret = cfg.oauthStateSecret!;
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const verified = token ? verifyState({ secret, token, purpose: "connections" }) : null;
    if (!verified || !cfg.db) return badLink(res);

    const account = await getCalendarAccount(cfg.db, verified.uid);
    if (!account) return badLink(res);

    const status = await connectionStatus({
      db: cfg.db,
      userId: verified.uid,
      google: cfg.google,
      publicBaseUrl: cfg.publicBaseUrl,
      oauthStateSecret: cfg.oauthStateSecret!,
      currentMessage: "",
    });

    res.type("html").send(`<!doctype html>
<html><body style="font-family: system-ui, sans-serif; padding: 48px; max-width: 520px;">
  <h1 style="margin:0 0 12px">Calendar connected ✅</h1>
  <p style="margin:0 0 8px">You are connected to <b>${escapeHtml(account.account_email ?? "your Google account")}</b>. ${status.needsReconnect ? "It needs reconnecting — Google rejected the permission." : ""}</p>
  <p style="margin:0 0 12px"><a href="/connections/disconnect" style="display:inline-block;padding:10px 18px;background:#fee2e2;color:#b91c1c;text-decoration:none;border-radius:8px;">Disconnect my calendar</a></p>
</body></html>`);
  });

  // POST /connections/disconnect?token=<signed, purpose "connections"> + a
  // single-use nonce. Requires confirm=true matching the user's latest message.
  router.post("/disconnect", async (req, res) => {
    const secret = cfg.oauthStateSecret!;
    const linkToken = typeof req.query.token === "string" ? req.query.token : "";
    const verified = linkToken ? verifyState({ secret, token: linkToken, purpose: "connections" }) : null;
    if (!verified || !cfg.db) return badLink(res);

    const account = await getCalendarAccount(cfg.db, verified.uid);
    if (!account) return badLink(res);

    // The nonce is the one-time confirmation token. Reusing it is rejected.
    const nonce = String(req.body?.nonce ?? "");
    if (!nonce || !(await useNonce(cfg.db, nonce))) return badLink(res);

    const confirmed = req.body?.confirm === true && String(req.body?.currentMessage ?? "").trim() !== "";
    if (!confirmed) return badLink(res);

    // Best effort: a dead or already-revoked grant must not block cleanup.
    const storedToken = account.refresh_token ?? account.access_token;
    const revoked = cfg.google ? await cfg.google.revokeToken(storedToken) : false;

    const result = await disconnectCalendarAccount(cfg.db, verified.uid);
    res.type("html").send(`<!doctype html>
<html><body style="font-family: system-ui, sans-serif; padding: 48px; max-width: 520px;">
  <h1 style="margin:0 0 12px">Disconnected</h1>
  <p style="margin:0 0 12px">${revoked ? "Google access revoked." : "Google didn't confirm the revoke, but every stored token is deleted here."}</p>
  <p style="margin:0 0 12px">Removed ${result.cancelledEvents} synced event${result.cancelledEvents === 1 ? "" : "s"} and ${result.removedReminders} pending reminder${result.removedReminders === 1 ? "" : "s"}.</p>
  <p style="margin:0"><a href="/connections" style="color:#555;text-decoration:underline;">Back to connections</a></p>
</body></html>`);
  });

  return router;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}
