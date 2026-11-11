import { disconnectCalendarAccount, getCalendarAccount, listUpcomingEvents, type Db } from "@exec-assistant/db";
import { buildConnectionsUrl, CONNECTIONS_TOKEN_TTL_MS, describeScopes, revokeToken } from "@exec-assistant/calendar";
import { tokensFor } from "./calendar-access.js";
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

  // The worker pauses a grant that Google rejected (an expired or revoked
  // access token, invalid_grant). Report the record as present and trusted, but
  // flag it so callers know to ask for a fresh consent before syncing again.
  if (account.reauth_required_at) {
    return {
      connected: true,
      provider: account.provider,
      accountEmail: account.account_email ?? null,
      permission: describeScopes(account.scopes ?? []),
      connectedAt: account.connected_at ? account.connected_at.toISOString() : null,
      lastSyncAt: account.synced_at ? account.synced_at.toISOString() : null,
      lastSyncError: account.last_sync_error ?? null,
      needsReconnect: true,
      eventsTracked: 0,
      connectionError: "reauth-required",
    };
  }

  // Stored credentials are first-class evidence. An access token is
  // short-lived, so a stored refresh token is the durable signal that the
  // grant is still valid: the assistant can rotate to a fresh token whenever
  // this one expires. Decrypting (which can throw on malformed ciphertext) is
  // the only step worth doing here; the at-rest key travels with the API.
  const google = ctx.google;
  let usable = false;
  let credentialError: string | null = null;

  if (google) {
    try {
      const tokens = tokensFor(account, google.tokenKey);
      usable = Boolean(tokens.refreshToken) || Boolean(tokens.accessToken);
    } catch (err) {
      credentialError = err instanceof Error ? err.message : "credential-invalid";
    }
  } else {
    // No configuration bearing the at-rest key in this process: trust the
    // record (paused refs are already visible through reauth_required_at) and
    // report the connection as healthy for the status itself.
    usable = true;
  }

  // Count activity in a window that matches the scheduled sync horizon, so a
  // freshly synced account is not reported as "no calendar access recorded"
  // just because nothing falls in the next 14 days.
  let eventsTracked = 0;
  if (account.synced_at) {
    // A window that matches the scheduled sync horizon (one day), so a
    // freshly synced account is not reported as "no calendar access recorded"
    // because nothing falls in the next 14 days.
    const from = new Date(now - 24 * 3_600_000);
    const to = new Date(now + 14 * 86_400_000);
    const events = await listUpcomingEvents(ctx.db, ctx.userId, from, to, 250);
    eventsTracked = events.length;
  }

  const connected = usable && !credentialError;
  const needsReconnect = account.reauth_required_at !== null || credentialError !== null;

  return {
    connected,
    provider: account.provider,
    accountEmail: account.account_email ?? null,
    permission: describeScopes(account.scopes ?? []),
    connectedAt: account.connected_at ? account.connected_at.toISOString() : null,
    lastSyncAt: account.synced_at ? account.synced_at.toISOString() : null,
    lastSyncError: account.last_sync_error ?? null,
    needsReconnect,
    eventsTracked,
    connectionError: connected ? null : credentialError ?? "credential-invalid",
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
