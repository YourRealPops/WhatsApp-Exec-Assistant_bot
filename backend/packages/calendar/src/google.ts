import type { CalendarClient, CalendarEvent, OAuthTokens } from "./types.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
];

export interface AuthUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}

/** Authorization-code URL that sends the user to Google's consent screen. */
export function buildAuthUrl(opts: AuthUrlOptions): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (opts.scopes ?? GOOGLE_SCOPES).join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", opts.state);
  return url.toString();
}

async function requestTokens(params: Record<string, string>): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    throw new Error(
      `Google token request failed (${res.status}): ${data?.error_description ?? data?.error ?? "unknown"}`,
    );
  }
  return {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in
      ? new Date(Date.now() + Number(data.expires_in) * 1000)
      : null,
  };
}

export function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<OAuthTokens> {
  return requestTokens({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
  });
}

export function refreshAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<OAuthTokens> {
  return requestTokens({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
    grant_type: "refresh_token",
  });
}

/**
 * Map one Google Calendar API event resource into our shape.
 * All-day events carry `date` instead of `dateTime`.
 */
export function mapGoogleEvent(item: Record<string, any>): CalendarEvent | null {
  if (!item || typeof item.id !== "string") return null;
  const startRaw = item.start?.dateTime ?? item.start?.date;
  const endRaw = item.end?.dateTime ?? item.end?.date;
  if (typeof startRaw !== "string" || typeof endRaw !== "string") return null;
  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return {
    externalId: item.id,
    title: typeof item.summary === "string" && item.summary ? item.summary : "(untitled)",
    start,
    end,
    location: typeof item.location === "string" ? item.location : null,
    description: typeof item.description === "string" ? item.description : null,
    status: item.status === "cancelled" ? "cancelled" : "confirmed",
  };
}

export interface GoogleClientOptions {
  clientId: string;
  clientSecret: string;
  tokens: OAuthTokens;
  calendarId?: string;
  /** Called after a silent refresh so the caller can persist the new token. */
  onTokenRefresh?: (tokens: OAuthTokens) => void | Promise<void>;
}

/** Calendar client for one connected Google account. */
export function createGoogleClient(opts: GoogleClientOptions): CalendarClient & {
  getTokens(): OAuthTokens;
} {
  let tokens = opts.tokens;
  const calendarId = encodeURIComponent(opts.calendarId ?? "primary");

  async function ensureFreshToken(): Promise<void> {
    const expiresSoon =
      tokens.expiresAt && tokens.expiresAt.getTime() - Date.now() < 60_000;
    if (!expiresSoon) return;
    if (!tokens.refreshToken) return;
    const refreshed = await refreshAccessToken({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      refreshToken: tokens.refreshToken,
    });
    tokens = {
      accessToken: refreshed.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: refreshed.expiresAt,
    };
    await opts.onTokenRefresh?.(tokens);
  }

  return {
    provider: "google",
    getTokens: () => tokens,
    async listEvents(from, to): Promise<CalendarEvent[]> {
      await ensureFreshToken();
      const url = new URL(`${CALENDAR_ENDPOINT}/${calendarId}/events`);
      url.searchParams.set("timeMin", from.toISOString());
      url.searchParams.set("timeMax", to.toISOString());
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", "2500");

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (!res.ok) {
        throw new Error(
          `Google Calendar list failed (${res.status}): ${data?.error?.message ?? "unknown"}`,
        );
      }
      const items: Record<string, any>[] = Array.isArray(data.items) ? data.items : [];
      return items
        .map(mapGoogleEvent)
        .filter((e): e is CalendarEvent => e !== null);
    },
  };
}
