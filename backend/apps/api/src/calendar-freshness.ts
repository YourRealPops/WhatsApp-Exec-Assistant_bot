import {
  cancelEventReminders,
  cancelEventsByExternalIds,
  getCalendarAccount,
  markReauthRequired,
  markSynced,
  materializeAllReminders,
  reconcileMissingEvents,
  recordSyncFailure,
  upsertEvents,
  type CalendarAccount,
  type Db,
} from "@exec-assistant/db";
import { CalendarAuthError } from "@exec-assistant/calendar";
import { connectedGoogleClient, type GoogleConfig } from "./calendar-access.js";

/**
 * What the caller should tell the user about the data it is about to show.
 * `stale` is the important one: when a refresh was needed and failed, the
 * assistant must not present the local rows as if they were current.
 */
export interface CalendarFreshness {
  /** A fetch from Google ran during this read. */
  refreshed: boolean;
  /** Local data is older than the freshness threshold and the refresh failed. */
  stale: boolean;
  lastSyncedAt: string | null;
  /** Plain-words explanation to surface when stale (null when current). */
  warning: string | null;
}

export interface FreshnessDeps {
  db: Db;
  userId: string;
  google: GoogleConfig | null;
  /** Treat data older than this as needing a refresh. */
  freshnessMs: number;
  lookaheadDays: number;
  reminderOffsets: number[];
  maxOffsetMinutes: number;
  /** Injectable clock for tests. */
  now?: Date;
}

function state(
  account: CalendarAccount | null,
  refreshed: boolean,
  stale: boolean,
  warning: string | null,
): CalendarFreshness {
  return {
    refreshed,
    stale,
    lastSyncedAt: account?.synced_at
      ? new Date(account.synced_at).toISOString()
      : null,
    warning,
  };
}

function isFresh(account: CalendarAccount, now: Date, freshnessMs: number): boolean {
  if (!account.synced_at) return false;
  if (account.last_sync_error) return false;
  return now.getTime() - new Date(account.synced_at).getTime() < freshnessMs;
}

/**
 * Freshness-aware calendar read.
 *
 * The bot never trusts the local copy blindly: when an account is connected
 * and its data is older than the threshold, this fetches Google now, applies
 * upserts/deletions, updates the reminder ladder and only then reports the
 * data as current. A failed refresh leaves `synced_at` untouched and returns
 * `stale: true` with a warning, so callers can say so instead of quietly
 * answering from outdated events.
 *
 * No connected account (dev fixtures / never connected) is not "stale": there
 * is no provider to refresh from.
 */
export async function ensureFreshCalendar(
  deps: FreshnessDeps,
): Promise<CalendarFreshness> {
  const now = deps.now ?? new Date();
  const account = await getCalendarAccount(deps.db, deps.userId);
  if (!account) return state(null, false, false, null);

  if (account.reauth_required_at) {
    return state(
      account,
      false,
      true,
      "Google needs you to reconnect before I can refresh this calendar — say \"reconnect my calendar\" for a fresh link.",
    );
  }

  if (isFresh(account, now, deps.freshnessMs)) {
    return state(account, false, false, null);
  }

  // A recent failure already scheduled the next attempt. Do not hammer Google
  // on every message; report the stale state with the same explicit warning.
  if (
    account.last_sync_error &&
    account.next_sync_at &&
    new Date(account.next_sync_at).getTime() > now.getTime()
  ) {
    const when = account.synced_at
      ? new Date(account.synced_at).toISOString()
      : null;
    return state(
      account,
      false,
      true,
      when
        ? `I couldn't refresh Google Calendar just now, so these events are from the last successful sync (${when}).`
        : "I couldn't refresh Google Calendar just now, so I can't confirm these events are current.",
    );
  }

  if (!deps.google) {
    return state(
      account,
      false,
      true,
      "Calendar sync is not configured on this server, so these events may be out of date.",
    );
  }

  const from = new Date(now.getTime() - 24 * 3_600_000);
  const to = new Date(now.getTime() + deps.lookaheadDays * 86_400_000);

  try {
    const client = await connectedGoogleClient(deps.google, deps.db, account);
    const result = await client.syncWindow({
      from,
      to,
      syncToken: account.sync_token,
    });

    const saved = await upsertEvents(deps.db, deps.userId, result.events);
    const cancelled = saved.filter((e) => e.status === "cancelled").map((e) => e.id);
    if (cancelled.length > 0) {
      await cancelEventReminders(deps.db, cancelled);
    }
    await cancelEventsByExternalIds(
      deps.db,
      deps.userId,
      result.deletedExternalIds,
    );
    if (result.full) {
      await reconcileMissingEvents(deps.db, deps.userId, {
        from,
        to,
        seenExternalIds: result.events.map((e) => e.externalId),
      });
    }
    await materializeAllReminders(deps.db, {
      offsets: deps.reminderOffsets,
      lookaheadDays: deps.lookaheadDays,
      maxOffsetMinutes: deps.maxOffsetMinutes,
    });
    await markSynced(deps.db, account.id, {
      // Keep the worker's own schedule: an on-demand refresh must not shorten
      // the configured background interval. A null value falls back to the
      // worker's regular interval from the new synced_at.
      nextSyncAt:
        account.next_sync_at &&
        new Date(account.next_sync_at).getTime() > now.getTime()
          ? account.next_sync_at
          : null,
      syncToken: result.full
        ? result.nextSyncToken
        : (result.nextSyncToken ?? account.sync_token),
      attempts: 0,
    });

    return {
      refreshed: true,
      stale: false,
      lastSyncedAt: now.toISOString(),
      warning: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof CalendarAuthError) {
      await markReauthRequired(deps.db, account.id).catch(() => false);
      await recordSyncFailure(
        deps.db,
        account.id,
        message,
        (account.sync_attempts ?? 0) + 1,
        new Date(now.getTime() + 60 * 60_000),
      ).catch(() => {});
      return state(
        account,
        false,
        true,
        "Google rejected the connection, so I can't confirm these events are current — say \"reconnect my calendar\" for a fresh link.",
      );
    }

    await recordSyncFailure(
      deps.db,
      account.id,
      message,
      (account.sync_attempts ?? 0) + 1,
      new Date(now.getTime() + 60_000),
    ).catch(() => {});
    const when = account.synced_at
      ? new Date(account.synced_at).toISOString()
      : null;
    return state(
      account,
      false,
      true,
      when
        ? `I couldn't refresh Google Calendar just now, so these events are from the last successful sync (${when}).`
        : "I couldn't refresh Google Calendar just now, so I can't confirm these events are current.",
    );
  }
}
