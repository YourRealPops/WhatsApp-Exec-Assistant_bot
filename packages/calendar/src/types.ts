/** Provider-agnostic calendar event. */
export interface CalendarEvent {
  externalId: string;
  title: string;
  start: Date;
  end: Date;
  location?: string | null;
  description?: string | null;
  status: "confirmed" | "cancelled" | string;
}

/** Anything the sync layer can pull events from (Google today, more later). */
export interface CalendarClient {
  readonly provider: string;
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
}
