import { getCalendarAccount, updateAccountTokens, type CalendarAccount, type Db } from "@exec-assistant/db";
import { createGoogleClient, decryptToken, encryptToken } from "@exec-assistant/calendar";

/**
 * The Google credentials and the at-rest token key, in one place. Apps decrypt
 * here and hand a ready client to the tools; the database only ever holds
 * ciphertext.
 */
export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** AES-256-GCM key (32 bytes) for tokens at rest. */
  tokenKey: Buffer;
}

/** Decrypt an account's stored tokens for one API call. */
export function tokensFor(account: CalendarAccount, tokenKey: Buffer) {
  return {
    accessToken: decryptToken(account.access_token, tokenKey),
    refreshToken: account.refresh_token
      ? decryptToken(account.refresh_token, tokenKey)
      : null,
    expiresAt: account.expires_at,
  };
}

/**
 * A client for the user's connected account. A silent refresh is persisted
 * re-encrypted, so a long-lived session never writes plaintext back.
 */
export async function connectedGoogleClient(
  cfg: GoogleConfig,
  db: Db,
  account: CalendarAccount,
) {
  return createGoogleClient({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    tokens: tokensFor(account, cfg.tokenKey),
    calendarId: account.calendar_id,
    timezone: account.timezone ?? "UTC",
    onTokenRefresh: async (tokens) => {
      await updateAccountTokens(db, account.id, {
        accessToken: encryptToken(tokens.accessToken, cfg.tokenKey),
        expiresAt: tokens.expiresAt ?? null,
      });
    },
  });
}

/** Load the user's account or explain, in plain words, why we can't proceed. */
export async function requireGoogleAccount(
  db: Db,
  userId: string,
): Promise<CalendarAccount> {
  const account = await getCalendarAccount(db, userId);
  if (!account) {
    throw new Error(
      "No calendar is connected yet — say \"connect my calendar\" and I'll send a private link.",
    );
  }
  if (account.reauth_required_at) {
    throw new Error(
      "Google needs you to reconnect before I can read or change anything — say \"reconnect my calendar\" for a fresh link.",
    );
  }
  return account;
}
