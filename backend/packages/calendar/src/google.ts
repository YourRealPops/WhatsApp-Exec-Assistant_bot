import type { CalendarClient, CalendarEvent, OAuthTokens } from "./types.js";
import { startOfDayInTz } from "./time.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars";
/** Google caps a page at 2500; more than this many pages means something is off. */
const MAX_PAGES = 40;

const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export interface GoogleEventDetail {
  event: {
    externalId: string;
    title: string;
    start: Date;
    end: Date;
    allDay?: boolean;
    location?: string | null;
    description?: string | null;
    status: string;
  };
  etag: string | null;
  attendees: number;
  organizerSelf: boolean;
  guestsCanModify: boolean;
  rawStatus: string;
  htmlLink: string | null;
}

/**
 * `openid email` identify the account the user connected (shown in status and
 * on the connections page); calendar.events is the only calendar permission —
 * read and edit events, nothing else (no settings, no sharing, no deletes).
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
];

/** Plain words for what a Google consent screen will ask for. */
export const CALENDAR_PERMISSION_PLAIN = "view and edit your calendar events";

/** Human description of the scopes actually granted on an account. */
export function describeScopes(scopes: string[]): string {
  const has = (needle: string) => scopes.some((s) => s.includes(needle));
  const labels: string[] = [];
  if (has("calendar.events")) labels.push("view and edit your calendar events");
  if (has("calendar.readonly")) labels.push("view your calendar");
  if (has("email")) labels.push("see which Google account you connected");
  return labels.length > 0
    ? labels.join("; ")
    : "no calendar access recorded — reconnect to renew the permission";
}

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

/** The event changed on Google's side since the proposal was made (412). */
export class EventConflictError extends Error {
  constructor(message = "the event changed since the proposal was made") {
    super(message);
    this.name = "EventConflictError";
  }
}

/**
 * The write may or may not have landed: timeout, network error, 429 or 5xx.
 * The only safe next step is to re-read the event before deciding anything.
 */
export class TransientCalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientCalendarError";
  }
}

/** One event as Google returns it, plus the fields approvals depend on. */
export interface GoogleEventDetail {
  event: CalendarEvent;
  /** Conditional-write token: a PATCH with a stale ETag is rejected with 412. */
  etag: string | null;
  attendees: number;
  organizerSelf: boolean;
  guestsCanModify: boolean;
  rawStatus: string;
  htmlLink: string | null;
}

export function mapGoogleEventDetail(
  item: Record<string, any>,
  timezone = "UTC",
): GoogleEventDetail | null {
  const event = mapGoogleEvent(item, timezone);
  if (!event) return null;
  return {
    event,
    etag: typeof item.etag === "string" ? item.etag : null,
    attendees: Array.isArray(item.attendees) ? item.attendees.length : 0,
    organizerSelf: item.organizer?.self === true,
    guestsCanModify: item.guestsCanModify === true,
    rawStatus: typeof item.status === "string" ? item.status : "confirmed",
    htmlLink: typeof item.htmlLink === "string" ? item.htmlLink : null,
  };
}

/**
 * Best-effort revoke at Google. A dead grant or a network failure is not an
 * error: the local tokens are removed either way.
 */
/** The account's email from Google's userinfo endpoint, or null when unavailable. */
export async function fetchUserEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    return typeof data.email === "string" ? data.email : null;
  } catch {
    return null;
  }
}

export async function revokeToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );
    return res.ok;
  } catch {
    return false;
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
    scopes: typeof data.scope === "string" ? data.scope.split(" ").filter(Boolean) : undefined,
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
  getEvent(eventId: string): Promise<GoogleEventDetail | null>;
  patchEventTimes(input: { eventId: string;
    etag: string | null;
    start: Date;
    end: Date;
    sendUpdates: "all" | "none";
  }): Promise<GoogleEventDetail>;
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

  function eventUrl(eventId: string): string {
    return `${CALENDAR_ENDPOINT}/${calendarId}/events/${encodeURIComponent(eventId)}`;
  }

  /** Retry exactly once after a refresh when Google answers 401. */
  async function authorized(
    doRequest: (accessToken: string) => Promise<Response>,
  ): Promise<Response> {
    await ensureFreshToken();
    const first = await doRequest(tokens.accessToken);
    if (first.status !== 401) return first;
    if (!tokens.refreshToken) {
      throw new CalendarAuthError(
        "Google rejected the access token and there is no refresh token",
        "invalid_token",
      );
    }
    await refresh();
    return doRequest(tokens.accessToken);
  }

  return {
    provider: "google",
    getTokens: () => tokens,

    async getEvent(eventId: string): Promise<GoogleEventDetail | null> {
      const res = await authorized((accessToken) =>
        fetch(eventUrl(eventId), {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      if (res.status === 404) return null;
      const data = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (!res.ok) {
        throw new Error(
          `Google Calendar read failed (${res.status}): ${data?.error?.message ?? "unknown"}`,
        );
      }
      return mapGoogleEventDetail(data, timezone);
    },

    /**
     * Move one event. Conditional on the ETag the user approved, so a change
     * made in between fails with EventConflictError instead of overwriting it.
     * Only start/end are sent: the proposal is a reschedule, nothing else.
     */
    async patchEventTimes(input): Promise<GoogleEventDetail> {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (input.etag) headers["If-Match"] = input.etag;
      const body = JSON.stringify({
        start: {
          dateTime: input.start.toISOString(),
          timeZone: timezone,
        },
        end: { dateTime: input.end.toISOString(), timeZone: timezone },
      });

      let res: Response;
      try {
        res = await authorized((accessToken) =>
          fetch(eventUrl(input.eventId), {
            method: "PATCH",
            headers: { ...headers, Authorization: `Bearer ${accessToken}` },
            body,
          }),
        );
      } catch (err) {
        // A dead grant must stay a CalendarAuthError; anything else during the
        // request means the write state is unknown.
        if (err instanceof CalendarAuthError) throw err;
        throw new TransientCalendarError(
          `Google Calendar update did not complete: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const data = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (res.status === 412) throw new EventConflictError();
      if (res.status === 429 || res.status >= 500) {
        throw new TransientCalendarError(
          `Google Calendar update failed (${res.status}): the write state is unknown`,
        );
      }
      if (!res.ok) {
        throw new Error(
          `Google Calendar update failed (${res.status}): ${data?.error?.message ?? "unknown"}`,
        );
      }
      const detail = mapGoogleEventDetail(data, timezone);
      if (!detail) {
        throw new TransientCalendarError(
          "Google returned a response we could not read",
        );
      }
      return detail;
    },
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
