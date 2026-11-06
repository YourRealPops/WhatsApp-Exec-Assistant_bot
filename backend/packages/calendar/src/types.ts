/** Provider-agnostic calendar event. */
export interface CalendarEvent {
  externalId: string;
  title: string;
  start: Date;
  end: Date;
  /** Date-only event (no clock time); start/end are local midnight. */
  allDay?: boolean;
  location?: string | null;
  description?: string | null;
  status: "confirmed" | "cancelled" | string;
}

/** Anything the sync layer can pull events from (Google today, more later). */
export interface CalendarClient {
  readonly provider: string;
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
}

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
}

/** A window of time that must be kept free. */
export interface TimeRange {
  start: Date;
  end: Date;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  /** Exactly what Google granted, from the token response's `scope`. */
  scopes?: string[];
}