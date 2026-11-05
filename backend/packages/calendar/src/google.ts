import type { CalendarClient, CalendarEvent, OAuthTokens } from "./types.js";
import { startOfDayInTz } from "./time.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars";
/** Google caps a page at 2500; more than this many pages means something is off. */
const MAX_PAGES = 40;

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
];

/**
 * The account's credentials are dead and no retry will help: Google answered
 * `invalid_grant`, or rejected the access token and there is no refresh token
 * to replace it. Network errors, 5xx and 429 are ordinary errors and must
 * never be reported as this.
 */
export class CalendarAuthError extends Error {
  readonly code: "invalid_grant" | "invalid_token";

  constructor(
    message: string,
    code: "invalid_grant" | "invalid_token" = "invalid_grant",
  ) {
    super(message);
    this.name = "CalendarAuthError";
    this.code = code;
  }
}

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
    const detail = data?.error_description ?? data?.error ?? "unknown";
    if (data?.error === "invalid_grant") {
      throw new CalendarAuthError(
        `Google token request failed (${res.status}): ${detail}`,
        "invalid_grant",
      );
    }
    throw new Error(`Google token request failed (${res.status}): ${detail}`);
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
 * All-day events carry `date` instead of `dateTime`; those are *dates*, so
 * they are anchored to local midnight in the user's timezone (and Google's
 * end date is exclusive, which local midnight of that date already is).
 */
export function mapGoogleEvent(
  item: Record<string, any>,
  timezone = "UTC",
): CalendarEvent | null {
  if (!item || typeof item.id !== "string") return null;
  const startRaw = item.start?.dateTime ?? item.start?.date;
  const endRaw = item.end?.dateTime ?? item.end?.date;
  if (typeof startRaw !== "string" || typeof endRaw !== "string") return null;
  const allDay = !item.start?.dateTime && typeof item.start?.date === "string";
  const start = allDay ? startOfDayInTz(startRaw, timezone) : new Date(startRaw);
  const end = allDay ? startOfDayInTz(endRaw, timezone) : new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return {
    externalId: item.id,
    title: typeof item.summary === "string" && item.summary ? item.summary : "(untitled)",
    start,
    end,
    allDay,
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
  /** IANA zone used to anchor all-day events; defaults to UTC. */
  timezone?: string;
  /** Called after a silent refresh so the caller can persist the new token. */
  onTokenRefresh?: (tokens: OAuthTokens) => void | Promise<void>;
}

/** Calendar client for one connected Google account. */
export function createGoogleClient(opts: GoogleClientOptions): CalendarClient & {
  getTokens(): OAuthTokens;
} {
  let tokens = opts.tokens;
  const calendarId = encodeURIComponent(opts.calendarId ?? "primary");
  const timezone = opts.timezone ?? "UTC";

  async function refresh(): Promise<void> {
    const refreshToken = tokens.refreshToken;
    if (!refreshToken) {
      throw new CalendarAuthError(
        "Google rejected the access token and there is no refresh token",
        "invalid_token",
      );
    }
    const refreshed = await refreshAccessToken({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      refreshToken,
    });
    tokens = {
      accessToken: refreshed.accessToken,
      refreshToken,
      expiresAt: refreshed.expiresAt,
    };
    await opts.onTokenRefresh?.(tokens);
  }

  async function ensureFreshToken(): Promise<void> {
    const expiresSoon =
      tokens.expiresAt && tokens.expiresAt.getTime() - Date.now() < 60_000;
    if (!expiresSoon) return;
    if (!tokens.refreshToken) return;
    await refresh();
  }

  async function fetchPage(
    from: Date,
    to: Date,
    pageToken?: string,
  ): Promise<Record<string, any>> {
    const url = new URL(`${CALENDAR_ENDPOINT}/${calendarId}/events`);
    url.searchParams.set("timeMin", from.toISOString());
    url.searchParams.set("timeMax", to.toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "2500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      if (res.status === 401) {
        throw new CalendarAuthError(
          tokens.refreshToken
            ? "Google still rejected the access token after a refresh"
            : "Google rejected the access token and there is no refresh token",
          "invalid_token",
        );
      }
      throw new Error(
        `Google Calendar list failed (${res.status}): ${data?.error?.message ?? "unknown"}`,
      );
    }
    return data;
  }

  return {
    provider: "google",
    getTokens: () => tokens,
    async listEvents(from, to): Promise<CalendarEvent[]> {
      await ensureFreshToken();

      let data: Record<string, any>;
      try {
        data = await fetchPage(from, to);
      } catch (err) {
        // A stale-but-not-expired token: force one refresh and retry, which
        // is the only case where a 401 is recoverable at all.
        if (!(err instanceof CalendarAuthError) || err.code !== "invalid_token") {
          throw err;
        }
        if (!tokens.refreshToken) throw err;
        await refresh();
        data = await fetchPage(from, to);
      }

      const events: CalendarEvent[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const items: Record<string, any>[] = Array.isArray(data.items) ? data.items : [];
        for (const item of items) {
          const mapped = mapGoogleEvent(item, timezone);
          if (mapped) events.push(mapped);
        }
        const next = data.nextPageToken;
        if (typeof next !== "string" || next.length === 0) return events;
        data = await fetchPage(from, to, next);
      }
      // Reconciling by absence is only safe on a complete list, so a list we
      // could not finish must fail loudly instead of looking truncated.
      throw new Error(
        `Google Calendar list did not finish after ${MAX_PAGES} pages`,
      );
    },
  };
}
