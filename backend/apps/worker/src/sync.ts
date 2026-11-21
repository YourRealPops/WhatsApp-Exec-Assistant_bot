import {
  cancelEventReminders,
  cancelEventsByExternalIds,
  claimAccountForSync,
  listAccountsDueSync,
  listUpcomingEvents,
  listUsersWithoutCalendar,
  markReauthRequired,
  markSynced,
  materializeAllReminders,
  reconcileMissingEvents,
  recordSyncFailure,
  updateAccountTokens,
  upsertEvents,
  type CalendarAccount,
  type Db,
} from "@exec-assistant/db";
import {
  CalendarAuthError,
  buildConnectUrl,
  createGoogleClient,
  decryptToken,
  defaultDevEvents,
  encryptToken,
  isEncrypted,
  reconnectNotice,
} from "@exec-assistant/calendar";
import type { Sender } from "@exec-assistant/whatsapp";
import type { LlmConfig } from "@exec-assistant/ai";
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
  google: {
    clientId?: string;
    clientSecret?: string;
    /** AES-256-GCM key for stored OAuth tokens; null when legacy plaintext. */
    tokenKey?: Buffer | null;
  };
  /** Consecutive failed syncs before a longer (capped) wait. */
  maxSyncAttempts?: number;
  /** Authoring model for general-purpose documents; null = deterministic draft. */
  llm?: LlmConfig | null;
  /** Asynchronous document generation and its retention policy. */
  document: {
    concurrency: number;
    pollMs: number;
    retentionDays: number;
    maxBytes: number;
    maxEvents: number;
    tmpDir?: string;
  };
  template: { name?: string; language: string };
  /** Needed to mint reconnect links; without them the nudge is skipped. */
  publicBaseUrl?: string;
  oauthStateSecret?: string;
}

type GoogleClient = ReturnType<typeof createGoogleClient>;

/**
 * Decrypt one stored token for Google. A v1: ciphertext without the key is a
 * configuration error, not an auth failure: syncing with ciphertext would
 * make Google reject the account and ask the user to reconnect for no reason.
 */
function plainToken(value: string, cfg: WorkerConfig): string {
  if (!isEncrypted(value)) return value;
  if (!cfg.google.tokenKey) {
    throw new Error(
      "calendar tokens are encrypted but TOKEN_ENCRYPTION_KEY is not set on the worker",
    );
  }
  return decryptToken(value, cfg.google.tokenKey);
}

function buildGoogleClient(
  cfg: WorkerConfig,
  account: CalendarAccount,
): GoogleClient | null {
  if (!cfg.google.clientId || !cfg.google.clientSecret) return null;
  return createGoogleClient({
    clientId: cfg.google.clientId,
    clientSecret: cfg.google.clientSecret,
    tokens: {
      accessToken: plainToken(account.access_token, cfg),
      refreshToken: account.refresh_token
        ? plainToken(account.refresh_token, cfg)
        : null,
      expiresAt: account.expires_at,
    },
    calendarId: account.calendar_id,
    timezone: account.timezone ?? "UTC",
    onTokenRefresh: async (tokens) => {
      await updateAccountTokens(cfg.db, account.id, {
        accessToken: cfg.google.tokenKey
          ? encryptToken(tokens.accessToken, cfg.google.tokenKey)
          : tokens.accessToken,
        expiresAt: tokens.expiresAt ?? null,
      });
    },
  });
}

/**
 * How long to wait after a failed sync. Starts at 30s and doubles per failure,
 * capped at the normal sync interval (and at 30 minutes) so a broken account
 * neither hot-loops nor waits indefinitely.
 */
export function syncRetryDelayMs(
  attempts: number,
  intervalMs: number,
): number {
  const grown = 30_000 * 2 ** Math.min(Math.max(attempts, 0), 6);
  return Math.max(5_000, Math.min(grown, intervalMs, 30 * 60_000));
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
  const nextSuccess = new Date(now + cfg.syncIntervalMs);
  let saved_count = 0;

  for (const account of accounts) {
    const label = account.user_id.slice(0, 8);
    // Two workers (or two ticks) can never fetch the same account at once.
    if (!(await claimAccountForSync(cfg.db, account.id).catch(() => false))) {
      continue;
    }
    try {
      const client = buildGoogleClient(cfg, account);
      if (!client) {
        // Never mark a skipped sync as successful: synced_at is the promise
        // that the local events are current, and they are not.
        const message = "Google credentials are not configured on the worker";
        const attempts = Math.min(
          (account.sync_attempts ?? 0) + 1,
          cfg.maxSyncAttempts ?? 3,
        );
        const retryAt = new Date(now + syncRetryDelayMs(attempts - 1, cfg.syncIntervalMs));
        await recordSyncFailure(cfg.db, account.id, message, attempts, retryAt);
        console.warn(`[worker] sync skipped for user ${label}: ${message}`);
        continue;
      }

      // An existing cursor makes this an incremental fetch; a full fetch is
      // the authoritative window used to reconcile events deleted elsewhere.
      const result = await client.syncWindow({
        from,
        to,
        syncToken: account.sync_token,
      });
      const saved = await upsertEvents(cfg.db, account.user_id, result.events);
      const cancelled = saved.filter((e) => e.status === "cancelled").map((e) => e.id);
      if (cancelled.length > 0) {
        await cancelEventReminders(cfg.db, cancelled);
      }
      const deleted = await cancelEventsByExternalIds(
        cfg.db,
        account.user_id,
        result.deletedExternalIds,
      );
      // Absence is only evidence on a complete full fetch: an incremental
      // response lists changes, not the whole calendar.
      const reconciled = result.full
        ? await reconcileMissingEvents(cfg.db, account.user_id, {
            from,
            to,
            seenExternalIds: result.events.map((e) => e.externalId),
          })
        : { cancelled: 0, remindersRemoved: 0 };

      await markSynced(cfg.db, account.id, {
        nextSyncAt: nextSuccess,
        // A full fetch is authoritative: replace (or clear) the cursor. An
        // incremental response keeps the previous one if Google omits it.
        syncToken: result.full
          ? result.nextSyncToken
          : (result.nextSyncToken ?? account.sync_token),
        attempts: 0,
      });
      saved_count += saved.length;
      console.log(
        `[worker] ${result.full ? "full" : "incremental"} sync: ${saved.length} events for user ${label}` +
          (cancelled.length ? ` (${cancelled.length} cancelled)` : "") +
          (deleted.cancelled
            ? ` (${deleted.cancelled} deleted on Google, ${deleted.remindersRemoved} reminders dropped)`
            : "") +
          (reconciled.cancelled
            ? ` (${reconciled.cancelled} no longer on Google, ${reconciled.remindersRemoved} reminders dropped)`
            : ""),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = Math.min(
        (account.sync_attempts ?? 0) + 1,
        cfg.maxSyncAttempts ?? 3,
      );
      const retryAt = new Date(now + syncRetryDelayMs(attempts - 1, cfg.syncIntervalMs));

      if (err instanceof CalendarAuthError) {
        // A dead grant is not a transient failure: pause the account and ask
        // the user to reconnect. Only the first transition messages them.
        await recordSyncFailure(cfg.db, account.id, message, attempts, retryAt).catch(
          () => {},
        );
        const first = await markReauthRequired(cfg.db, account.id).catch(() => false);
        console.warn(
          `[worker] Google grant rejected for user ${label} (${err.code}): ${message} — syncing paused`,
        );
        if (first) await notifyReauth(cfg, account);
      } else {
        // synced_at stays at its last successful value: the local events are
        // still the old ones and must not be reported as freshly synced.
        await recordSyncFailure(cfg.db, account.id, message, attempts, retryAt).catch(
          () => {},
        );
        console.error(
          `[worker] sync failed for user ${label} (attempt ${attempts}, retry in ${Math.round(
            (retryAt.getTime() - now) / 1000,
          )}s):`,
          message,
        );
      }
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
