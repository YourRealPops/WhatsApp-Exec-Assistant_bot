import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as dotenvConfig } from "dotenv";

/**
 * Load env files up the directory chain: the monorepo root .env is canonical
 * (values from it win), nearer files only fill in gaps.
 */
function loadDotenv(): void {
  const files: string[] = [];
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) files.push(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (files.length === 0) {
    dotenvConfig();
    return;
  }
  for (const file of files.reverse()) {
    dotenvConfig({ path: file });
  }
}
loadDotenv();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optional(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function bool(key: string, fallback: boolean): boolean {
  const value = optional(key);
  if (value === undefined) return fallback;
  return value === "true" || value === "1" || value === "yes";
}

function num(key: string, fallback: number): number {
  const value = Number(optional(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function parseOffsets(raw: string | undefined): number[] {
  const list = (raw ?? "15,10,5,0")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return list.length > 0 ? list : [15, 10, 5, 0];
}

const offsets = parseOffsets(optional("REMINDER_OFFSETS"));

export const env = {
  databaseUrl(): string {
    return requireEnv("DATABASE_URL");
  },
  tickMs: num("TICK_MS", 15_000),
  syncIntervalMs: num("SYNC_INTERVAL_MIN", 5) * 60_000,
  offsets,
  maxOffsetMinutes: Math.max(...offsets),
  lookaheadDays: num("LOOKAHEAD_DAYS", 14),
  maxSendAttempts: num("MAX_SEND_ATTEMPTS", 3),
  batchSize: num("DISPATCH_BATCH", 50),
  defaultTimezone: optional("DEFAULT_TIMEZONE") ?? systemTimezone(),
  senderMode: (optional("SENDER") ?? "console") as "console" | "whatsapp",
  devCalendar: bool("DEV_CALENDAR", !optional("GOOGLE_CLIENT_ID")),
  google: {
    clientId: optional("GOOGLE_CLIENT_ID"),
    clientSecret: optional("GOOGLE_CLIENT_SECRET"),
  },
  meta: {
    apiVersion: optional("META_API_VERSION") ?? "v21.0",
    accessToken: optional("META_ACCESS_TOKEN"),
    phoneNumberId: optional("META_PHONE_NUMBER_ID"),
  },
  /**
   * Proactive sends outside the 24h session window must use a pre-approved
   * utility template. Set REMINDER_TEMPLATE_NAME to switch the ladder to it;
   * params are [title, time] — design your template copy around that.
   */
  reminderTemplate: {
    name: optional("REMINDER_TEMPLATE_NAME"),
    language: optional("REMINDER_TEMPLATE_LANGUAGE") ?? "en",
  },
};
