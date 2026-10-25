import {
  cancelEventReminders,
  listAccountsDueSync,
  listUpcomingEvents,
  listUsersWithoutCalendar,
  markSynced,
  materializeAllReminders,
  updateAccountTokens,
  upsertEvents,
  type CalendarAccount,
  type Db,
} from "@exec-assistant/db";
import { createGoogleClient, defaultDevEvents, type CalendarClient } from "@exec-assistant/calendar";
import type { Sender } from "@exec-assistant/whatsapp";

export interface WorkerConfig {
  db: Db;
  sender: Sender;
  offsets: number[];
  maxOffsetMinutes: number;
  lookaheadDays: number;
  syncIntervalMs: number;
  maxSendAttempts: number;
  batchSize: number;
  devCalendar: boolean;
  google: { clientId?: string; clientSecret?: string };
  template: { name?: string; language: string };
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
    onTokenRefresh: async (tokens) => {
      await updateAccountTokens(cfg.db, account.id, {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt ?? null,
      });
    },
  });
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
      await markSynced(cfg.db, account.id);
      saved_count += saved.length;
      console.log(
        `[worker] synced ${saved.length} events for user ${label}` +
          (cancelled.length ? ` (${cancelled.length} cancelled)` : ""),
      );
    } catch (err) {
      console.error(
        `[worker] sync failed for user ${label}:`,
        err instanceof Error ? err.message : err,
      );
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
