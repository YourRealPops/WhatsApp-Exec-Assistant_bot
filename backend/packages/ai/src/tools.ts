import type { ToolDefinition } from "./llm.js";

// ---------------------------------------------------------------------------
// Tool schemas handed to the model
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_events",
      description:
        "List calendar events for a day or a range of days. Defaults to today.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Start day in YYYY-MM-DD (user's local time). Defaults to today.",
          },
          days: {
            type: "number",
            description: "Number of days ahead to include. Default 1, max 14.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_free_time",
      description:
        "Find gaps in the calendar that fit a meeting of a given duration.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Day in YYYY-MM-DD. Defaults to today." },
          duration_minutes: { type: "number", description: "Meeting length in minutes." },
        },
        required: ["duration_minutes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_event",
      description: "Create a calendar event (a local placeholder until Google is connected).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Event title." },
          start: {
            type: "string",
            description: "ISO 8601 start with offset, e.g. 2026-10-25T14:00:00+01:00",
          },
          end: {
            type: "string",
            description: "ISO 8601 end with offset. Defaults to 1 hour after start.",
          },
          location: { type: "string", description: "Optional location or meeting link." },
        },
        required: ["title", "start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description:
        "Set a one-off reminder at an absolute time (for things not on the calendar).",
      parameters: {
        type: "object",
        properties: {
          at: { type: "string", description: "ISO 8601 timestamp with offset." },
          message: { type: "string", description: "What to remind about." },
        },
        required: ["at", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description: "List upcoming reminders, including the automatic calendar reminder ladder.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.function.name);

export function toolDefinitionFor(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((t) => t.function.name === name);
}

// ---------------------------------------------------------------------------
// Result shapes — handlers return these; the LLM sees them as JSON and the
// no-key fallback formats them for a human.
// ---------------------------------------------------------------------------

export interface EventSlot {
  title: string;
  start: string;
  end: string;
  location?: string | null;
}

export interface ListEventsResult {
  date: string;
  events: EventSlot[];
}

export interface FindFreeTimeResult {
  date: string;
  slots: Array<{ start: string; end: string }>;
}

export interface CreateEventResult {
  created: boolean;
  title: string;
  start: string;
  end: string;
}

export interface SetReminderResult {
  created: boolean;
  at: string;
  message: string;
}

export interface ListRemindersResult {
  reminders: Array<{
    fireAt: string;
    message: string;
    status: string;
    eventTitle?: string | null;
  }>;
}
