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
        "Set a one-off reminder at an absolute time (for things not on the calendar). By default the reminder also rings the user's phone as an alarm; pass alarm=false when they only want a message.",
      parameters: {
        type: "object",
        properties: {
          at: { type: "string", description: "ISO 8601 timestamp with offset." },
          message: { type: "string", description: "What to remind about." },
          alarm: {
            type: "boolean",
            description:
              "Ring the phone with a spoken reminder. Defaults to true; false sends the WhatsApp message only.",
          },
        },
        required: ["at", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "connect_calendar",
      description:
        "Get a link the user can open to connect or reconnect Google Calendar. Use when they ask to connect their calendar, or when their calendar stopped syncing.",
      parameters: { type: "object", properties: {}, required: [] },
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
  {
    type: "function",
    function: {
      name: "connection_status",
      description:
        "Report which calendar is connected, the account email, what ECOS is allowed to do, when it last synced and whether it needs reconnecting. Use for \"what's connected?\".",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_connections",
      description:
        "Get a private, time-limited link to the connections page, where the user can see the connection and disconnect it. Use when they say \"manage my connections\".",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "disconnect_calendar",
      description:
        "Disconnect Google Calendar and delete the stored access. Two steps: call it without confirm to ask the user, and only call it again with confirm=true after they have explicitly said yes in their latest message.",
      parameters: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            description:
              "True only when the user's latest message is an explicit yes to your disconnect question.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_event_change",
      description:
        "Propose new start/end times for an existing event. This never changes anything: it stores the exact change and sends the user Approve/Reject buttons. Use it for every reschedule request — never say an event was moved before the tool reports it succeeded.",
      parameters: {
        type: "object",
        properties: {
          event: {
            type: "string",
            description:
              "Which event, by title or a distinctive part of it (e.g. \"board review\").",
          },
          event_id: {
            type: "string",
            description: "External event id from list_events, when known. Preferred over a title.",
          },
          start: {
            type: "string",
            description: "New start: ISO 8601 with offset, or YYYY-MM-DDTHH:mm in the user's timezone.",
          },
          end: {
            type: "string",
            description: "New end. Omit it to keep the event's current duration.",
          },
        },
        required: ["start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_profile",
      description:
        "Save or edit the user's name and designation on their profile. Call it when they tell you their name or role, or ask to be called something else. Pass only what changed — an omitted field keeps its stored value.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name the user wants to be addressed by.",
          },
          designation: {
            type: "string",
            description: "Their role or job title, e.g. 'CTO at Analytic Engines'.",
          },
        },
        required: [],
      },
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
  /** External id (Google's event id) — needed to propose a change to it. */
  id: string;
  title: string;
  start: string;
  end: string;
  /** Date-only event: show "All day" instead of a clock time. */
  allDay?: boolean;
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
  /** True when calendar writes are off: the event is a local placeholder
   *  until Google Calendar is connected. */
  needsConnect: boolean;
}

export interface SetReminderResult {
  created: boolean;
  at: string;
  message: string;
  /** Whether the reminder will also ring the phone as an alarm. */
  alarm: boolean;
}

export interface ConnectCalendarResult {
  url: string;
  expiresInMinutes: number;
}

export interface ConnectionStatusResult {
  connected: boolean;
  provider?: string;
  accountEmail?: string | null;
  /** Plain words, e.g. "view and edit your calendar events". */
  permission?: string;
  connectedAt?: string | null;
  lastSyncAt?: string | null;
  lastSyncError?: string | null;
  /** Google rejected the grant: the user must reconnect before anything syncs. */
  needsReconnect: boolean;
  eventsTracked?: number;
}

export interface ManageConnectionsResult {
  url: string;
  expiresInMinutes: number;
}

export interface ProposeEventChangeResult {
  proposalId: string;
  /** The exact change, formatted for the chat — send this text as-is. */
  message: string;
  before: { start: string; end: string };
  after: { start: string; end: string };
  conflictWarning: string | null;
  attendees: number;
  /** Google will notify guests when this executes. */
  notifiesAttendees: boolean;
  expiresInMinutes: number;
}

export interface DisconnectResult {
  status: "needs-confirmation" | "disconnected" | "not-connected";
  message: string;
  cancelledEvents?: number;
  removedReminders?: number;
}

export interface SaveProfileResult {
  /** Stored name — null when the user has never given one. */
  name: string | null;
  designation: string | null;
}

export interface ListRemindersResult {
  reminders: Array<{
    fireAt: string;
    message: string;
    status: string;
    eventTitle?: string | null;
  }>;
}
