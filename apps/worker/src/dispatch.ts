import {
  claimDueReminders,
  markReminderFailed,
  markReminderSent,
  type ReminderDetail,
} from "@exec-assistant/db";
import { safeTimezone } from "@exec-assistant/ai";
import type { WorkerConfig } from "./sync.js";

function formatClock(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** Copy for one reminder row — the same text the assistant shows in lists. */
export function buildReminderText(r: ReminderDetail): string {
  const tz = safeTimezone(r.timezone);
  if (!r.event_id) {
    return `⏰ Reminder: ${r.note} (${r.fire_at ? formatClock(new Date(r.fire_at), tz) : ""})`;
  }
  const title = r.event_title ?? "your event";
  const start = r.event_start ? formatClock(new Date(r.event_start), tz) : "";
  const offset = r.offset_minutes ?? 0;
  if (offset === 0) {
    return `🔔 It's time — ${title} starts now (${start}).`;
  }
  const unit = offset === 1 ? "minute" : "minutes";
  return `⏰ ${title} starts in ${offset} ${unit} (${start}).`;
}

/** Template params must match your approved utility template: [title, time]. */
function templateParams(r: ReminderDetail): string[] {
  const tz = safeTimezone(r.timezone);
  const title = r.event_id ? (r.event_title ?? "your event") : r.note;
  const when = r.event_start
    ? formatClock(new Date(r.event_start), tz)
    : r.fire_at
      ? formatClock(new Date(r.fire_at), tz)
      : "";
  return [title, when];
}

export interface DispatchResult {
  sent: number;
  failed: number;
}

/** Claim due reminders and deliver them; failures retry until max attempts. */
export async function dispatchDue(cfg: WorkerConfig): Promise<DispatchResult> {
  const claimed = await claimDueReminders(cfg.db, new Date(), cfg.batchSize);
  let sent = 0;
  let failed = 0;

  for (const reminder of claimed) {
    const label = reminder.event_title ?? reminder.note;
    if (!reminder.phone) {
      await markReminderFailed(cfg.db, reminder.id, "no recipient phone", false);
      failed += 1;
      console.warn(`[worker] no phone for reminder ${reminder.id}`);
      continue;
    }

    try {
      if (cfg.template.name) {
        await cfg.sender.sendTemplate(
          reminder.phone,
          cfg.template.name,
          cfg.template.language,
          templateParams(reminder),
        );
      } else {
        await cfg.sender.sendText(reminder.phone, buildReminderText(reminder));
      }
      await markReminderSent(cfg.db, reminder.id);
      sent += 1;
      console.log(`[worker] sent "${label}" → ${reminder.phone}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retry = reminder.attempts < cfg.maxSendAttempts;
      await markReminderFailed(cfg.db, reminder.id, message, retry);
      failed += 1;
      console.error(
        `[worker] send failed for "${label}": ${message}${retry ? " (will retry)" : " (giving up)"}`,
      );
    }
  }

  return { sent, failed };
}
