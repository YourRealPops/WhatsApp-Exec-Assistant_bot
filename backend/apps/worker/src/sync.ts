import {
  cancelEventReminders,
  listAccountsDueSync,
  listUpcomingEvents,
  listUsersWithoutCalendar,
  markReauthRequired,
  markSynced,
  materializeAllReminders,
  reconcileMissingEvents,
  updateAccountTokens,
  upsertEvents,
  type CalendarAccount,
  type Db,
} from "@exec-assistant/db";
import {
  CalendarAuthError,
  buildConnectUrl,
  createGoogleClient,
  defaultDevEvents,
  reconnectNotice,
  type CalendarClient,
} from "@exec-assistant/calendar";
import type { Sender } from "@exec-assistant/whatsapp";
import type { Alarm } from "./alarm.js";

export interface WorkerConfig {
  db: Db;
  sender: Sender;
  /** Phone-ringing channel for reminders marked as alarms; null = disabled. */
  alarm: Alarm | null;
  offsets: number[];
  maxOffsetMinutes: number;
  lookaheadDays: number;
  syncIntervalMs: number;
  maxSendAttempts: number;
  batchSize: number;
  devCalendar: boolean;
  google: { clientId?: string; clientSecret?: string };
  template: { name?: string; language: string };
  /** Needed to mint reconnect links; without them the nudge is skipped. */
  publicBaseUrl?: string;
  oauthStateSecret?: string;
}

function buildGoogleClient(
  cfg: WorkerConfig,
  account: CalendarAccount,
): CalendarClient | null {
  if (!cfg.google.clientId || !cfg.google.clientSecret) return null;
  return createGoogleClient({
    clientId: cfg.google.clientId,
    clientSecret: cfg.google.clientSecret,
    tokens: {
      accessToken: account.access_token,
      refreshToken: account.refresh_token,
      expiresAt: account.expires_at,
    },
    calendarId: account.calendar_id,
    timezone: account.timezone ?? "UTC",
    onTokenRefresh: async (tokens) => {
      await updateAccountTokens(cfg.db, account.id, {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt ?? null,
      });
    },
  });
}

/**
 * Tell the user, once, that Google needs re-consent. The 24h session window
 * may be closed, so a failed send is only logged: the pipeline repeats the
 * notice on their next message, where delivery is guaranteed.
 */
export async function notifyReauth(
  cfg: WorkerConfig,
  account: CalendarAccount,
): Promise<void> {
  const label = account.user_id.slice(0, 8);
  if (!cfg.publicBaseUrl || !cfg.oauthStateSecret) {
    console.warn(
      `[worker] cannot build a reconnect link for user ${label}: set PUBLIC_BASE_URL and OAUTH_STATE_SECRET`,
    );
    return;
  }
  if (!account.phone) {
    console.warn(`[worker] no phone on record for user ${label} — reconnect notice skipped`);
    return;
  }
  try {
    const link = buildConnectUrl({
      baseUrl: cfg.publicBaseUrl,
      secret: cfg.oauthStateSecret,
      uid: account.user_id,
    });
    await cfg.sender.sendText(account.phone, reconnectNotice(link));
    console.log(`[worker] reconnect notice sent to user ${label}`);
  } catch (err) {
    // Never puts the link in the log: it is a bearer credential.
    console.warn(
      `[worker] reconnect notice failed for user ${label}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Pull fresh events for every account due a sync. Returns events saved. */
export async function syncCalendars(cfg: WorkerConfig): Promise<number> {
  const accounts = await listAccountsDueSync(cfg.db, cfg.syncIntervalMs);
  if (accounts.length === 0) return 0;

  const now = Date.now();
  const from = new Date(now - 24 * 3_600_000);
  const to = new Date(now + cfg.lookaheadDays * 86_400_000);
  let saved_count = 0;

  for (const account of accounts) {
    const label = account.user_id.slice(0, 8);
    try {
      const client = buildGoogleClient(cfg, account);
      if (!client) {
        console.warn(`[worker] GOOGLE_* not configured — skipping sync for user ${label}`);
        await markSynced(cfg.db, account.id);
        continue;
      }
      const events = await client.listEvents(from, to);
      const saved = await upsertEvents(cfg.db, account.user_id, events);
      const cancelled = saved.filter((e) => e.status === "cancelled").map((e) => e.id);
      if (cancelled.length > 0) {
        await cancelEventReminders(cfg.db, cancelled);
      }
      // The list is complete (listEvents follows every page), so anything
      // Google did not return is gone: cancel it by absence.
      const reconciled = await reconcileMissingEvents(cfg.db, account.user_id, {
        from,
        to,
        seenExternalIds: events.map((e) => e.externalId),
      });
      await markSynced(cfg.db, account.id);
      saved_count += saved.length;
      console.log(
        `[worker] synced ${saved.length} events for user ${label}` +
          (cancelled.length ? ` (${cancelled.length} cancelled)` : "") +
          (reconciled.cancelled
            ? ` (${reconciled.cancelled} no longer on Google, ${reconciled.remindersRemoved} reminders dropped)`
            : ""),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof CalendarAuthError) {
        // Pause the account and ask the user to reconnect. Only the first
        // transition messages them, so a dead token can't spam every tick.
        const first = await markReauthRequired(cfg.db, account.id).catch(() => false);
        console.warn(
          `[worker] Google grant rejected for user ${label} (${err.code}): ${message} — syncing paused`,
        );
        if (first) await notifyReauth(cfg, account);
      } else {
        console.error(`[worker] sync failed for user ${label}:`, message);
      }
      // Mark synced anyway so one broken account can't hot-loop every tick.
      await markSynced(cfg.db, account.id).catch(() => {});
    }
  }
  return saved_count;
}

/**
 * Users without a connected Google account get the dev fixture calendar so
 * the ladder (and the CLI/webhook demos) work before OAuth exists.
 * Only seeds when they have nothing upcoming — no churn on every tick.
 */
export async function seedDevCalendars(cfg: WorkerConfig): Promise<number> {
  if (!cfg.devCalendar) return 0;
  const users = await listUsersWithoutCalendar(cfg.db);
  if (users.length === 0) return 0;

  const from = new Date(Date.now() - 30 * 60_000);
  const to = new Date(Date.now() + cfg.lookaheadDays * 86_400_000);
  let seeded = 0;

  for (const user of users) {
    const existing = await listUpcomingEvents(cfg.db, user.id, from, to, 1);
    if (existing.length > 0) continue;
    await upsertEvents(cfg.db, user.id, defaultDevEvents());
    seeded += 1;
  }
  if (seeded > 0) {
    console.log(`[worker] seeded dev fixture calendar for ${seeded} user(s)`);
  }
  return seeded;
}

/** Ensure every confirmed event in the window has its T-15/10/5/0 rows. */
export async function materialize(cfg: WorkerConfig): Promise<number> {
  return materializeAllReminders(cfg.db, {
    offsets: cfg.offsets,
    lookaheadDays: cfg.lookaheadDays,
    maxOffsetMinutes: cfg.maxOffsetMinutes,
  });
}
