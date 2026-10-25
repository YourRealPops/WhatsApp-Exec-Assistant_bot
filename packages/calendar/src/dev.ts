import type { CalendarClient, CalendarEvent } from "./types.js";

/**
 * Fixture events for development: stable external ids (keyed by anchor date)
 * so repeated syncs upsert instead of duplicating or drifting.
 */
export function defaultDevEvents(now: Date = new Date()): CalendarEvent[] {
  const at = (dayOffset: number, hour: number, minute = 0): Date => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, minute, 0, 0);
    return d;
  };
  const day = (offset: number) =>
    at(offset, 12).toISOString().slice(0, 10);

  return [
    {
      externalId: `dev:standup:${day(0)}`,
      title: "Daily standup",
      start: at(0, 9),
      end: at(0, 9, 30),
      location: "Google Meet",
      description: "Fixture event from the dev calendar",
      status: "confirmed",
    },
    {
      externalId: `dev:investor-call:${day(0)}`,
      title: "Investor call",
      start: at(0, 15),
      end: at(0, 15, 45),
      location: "Zoom",
      description: "Fixture event from the dev calendar",
      status: "confirmed",
    },
    {
      externalId: `dev:gym:${day(1)}`,
      title: "Gym session",
      start: at(1, 7),
      end: at(1, 8),
      location: "City gym",
      description: "Fixture event from the dev calendar",
      status: "confirmed",
    },
  ];
}

/**
 * Stand-in used while Google credentials don't exist yet: returns fixture
 * events filtered to the requested window. Same interface as the Google client,
 * so sync code swaps between them without changes.
 */
export function createDevClient(events?: CalendarEvent[]): CalendarClient {
  return {
    provider: "dev",
    async listEvents(from, to) {
      const source = events ?? defaultDevEvents();
      return source.filter((e) => e.start >= from && e.start < to);
    },
  };
}
