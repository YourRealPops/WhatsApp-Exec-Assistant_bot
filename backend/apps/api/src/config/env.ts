import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import { MIN_OAUTH_STATE_SECRET_LENGTH } from "@exec-assistant/calendar";

/**
 * Load env files up the directory chain: the monorepo root .env is canonical
 * (values from it win), nearer files like apps/api/.env only fill in gaps.
 * First loaded wins because dotenv never overrides an existing key.
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
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
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

function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const port = Number(process.env.PORT ?? 3000);
const publicBaseUrl = optional("PUBLIC_BASE_URL") ?? `http://localhost:${port}`;
const googleClientId = optional("GOOGLE_CLIENT_ID");
const googleClientSecret = optional("GOOGLE_CLIENT_SECRET");
const oauthStateSecret = optional("OAUTH_STATE_SECRET");

// The connect/callback state is only trustworthy if it is signed, so Google
// OAuth is unusable without a secret: fail at boot rather than at the first
// consent screen.
if (googleClientId && googleClientSecret) {
  if (!oauthStateSecret || oauthStateSecret.length < MIN_OAUTH_STATE_SECRET_LENGTH) {
    throw new Error(
      `OAUTH_STATE_SECRET must be set to at least ${MIN_OAUTH_STATE_SECRET_LENGTH} characters when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are configured (generate one with: openssl rand -base64 32). See .env.example.`,
    );
  }
}

export const env = {
  port,
  publicBaseUrl,
  databaseUrl(): string {
    return requireEnv("DATABASE_URL");
  },
  senderMode: (optional("SENDER") ?? "console") as "console" | "whatsapp",
  allowUnsignedWebhook: bool("ALLOW_UNSIGNED_WEBHOOK", false),
  debugRoutes: bool("DEBUG_ROUTES", false),
  defaultTimezone: optional("DEFAULT_TIMEZONE") ?? systemTimezone(),
  // Fixture calendar (standup / investor call / gym) until Google is connected.
  devCalendar: bool("DEV_CALENDAR", !googleClientId),

  // Read lazily so `pnpm dev:api` still boots with a blank .env — they only
  // throw the moment the code path actually needs them.
  meta: {
    get appSecret() {
      return requireEnv("META_APP_SECRET");
    },
    get verifyToken() {
      return requireEnv("META_VERIFY_TOKEN");
    },
    get accessToken() {
      return requireEnv("META_ACCESS_TOKEN");
    },
    get phoneNumberId() {
      return requireEnv("META_PHONE_NUMBER_ID");
    },
    apiVersion: optional("META_API_VERSION") ?? "v21.0",
    /** Non-throwing variants for dev-mode paths. */
    tryAppSecret: () => optional("META_APP_SECRET"),
    tryVerifyToken: () => optional("META_VERIFY_TOKEN"),
    tryAccessToken: () => optional("META_ACCESS_TOKEN"),
    tryPhoneNumberId: () => optional("META_PHONE_NUMBER_ID"),
  },

  // The opener is free-form text inside the 24h window and this approved
  // template outside it (see intro.ts).
  intro: {
    templateName: optional("INTRO_TEMPLATE_NAME"),
    templateLanguage: optional("INTRO_TEMPLATE_LANGUAGE") ?? "en",
  },

  llm: {
    baseUrl: optional("LLM_BASE_URL") ?? "https://api.openai.com/v1",
    apiKey: optional("LLM_API_KEY") ?? "",
    model: optional("LLM_MODEL") ?? "gpt-4o-mini",
  },

  google: {
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    redirectUri: `${publicBaseUrl}/auth/google/callback`,
    configured: !!(googleClientId && googleClientSecret),
    stateSecret: oauthStateSecret,
  },
};
