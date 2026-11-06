import { disconnectCalendarAccount, getCalendarAccount, listUpcomingEvents, type Db } from "@exec-assistant/db";
import { buildConnectionsUrl, CONNECTIONS_TOKEN_TTL_MS, describeScopes, revokeToken } from "@exec-assistant/calendar";
import type {
  ConnectionStatusResult,
  DisconnectResult,
  ManageConnectionsResult,
} from "@exec-assistant/ai";
import type { GoogleConfig } from "./calendar-access.js";

export interface ConnectionsContext {
  db: Db;
  userId: string;
  google: GoogleConfig | null;
  /** Needed to mint the signed connections link. */
  publicBaseUrl?: string;
  oauthStateSecret?: string;
  /** The user's current message — the confirmation step reads it. */
  currentMessage: string;
}

/** Everything "what's connected?" reports, in plain words. */
export async function connectionStatus(
  ctx: ConnectionsContext,
): Promise<ConnectionStatusResult> {
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
export function manageConnections(
  ctx: ConnectionsContext,
): ManageConnectionsResult {
  if (!ctx.publicBaseUrl || !ctx.oauthStateSecret) {
    throw new Error("Connections page is not configured on this server.");
  }
  return {
    url: buildConnectionsUrl({
      baseUrl: ctx.publicBaseUrl,
      secret: ctx.oauthStateSecret,
      uid: ctx.userId,
    }),
    expiresInMinutes: Math.round(CONNECTIONS_TOKEN_TTL_MS / 60_000),
  };
}

const AFFIRMATIVE = /^(yes|yeah|yep|yup|confirm|sure|do it|go ahead|disconnect)\b/i;

/**
 * Disconnect is deliberately two steps: a message that merely mentions the
 * calendar never deletes anything. Only an explicit yes to our question, in
 * that same message, does.
 */
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
