import {
  chat,
  hasLlmConfig,
  type LlmConfig,
  type LlmMessage,
  type ToolDefinition,
} from "./llm.js";
import { toolDefinitionFor } from "./tools.js";
import { runFallbackAgent } from "./fallback.js";
import {
  parseCalendarIntent,
  type CalendarOperation,
  type CalendarRouteName,
} from "./dispatch.js";

export interface ToolExecution {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  ok: boolean;
}

export type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

export interface AgentDeps {
  /** Leave empty/without apiKey to use the rule-based fallback assistant. */
  llm?: LlmConfig | null;
  systemPrompt: string;
  /** User's IANA timezone — used for dates in the fallback responder. */
  timezone: string;
  /** Prior conversation turns (no tool-call scaffolding). */
  history: LlmMessage[];
  userMessage: string;
  tools: Record<string, ToolHandler>;
  maxTurns?: number;
  onToolCall?: (execution: ToolExecution) => void;
}

export interface AgentResult {
  reply: string;
  toolCalls: ToolExecution[];
  /**
   * "onboarding" is the fixed first-contact introduction and "decision" the
   * deterministic Approve/Reject handler — neither is a model reply.
   */
  mode: "llm" | "fallback" | "onboarding" | "decision";
}

/**
 * When the reply must contain a link (connect/reconnect/connections), the
 * code that built it is the only place that writes it. Never write a URL in
 * plain text — a URL that a model re-emits from earlier turns is the exact
 * way a stale, expired link survives into the current turn.
 *
 * - Never write a link yourself; the system inserts it.
 * - Never repeat a link you saw earlier in the conversation.
 * - When a user asks to connect or reconnect the calendar, call
 *   connect_calendar and let the tool result carry the link.
 */
export function buildSystemPrompt(opts: {
  timezone: string;
  userName?: string | null;
  userDesignation?: string | null;
  now?: Date;
}): string {
  const now = opts.now ?? new Date();
  const tz = safeTimezone(opts.timezone);
  const date = safeFormat(now, tz, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const time = safeFormat(now, tz, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const who = opts.userName
    ? `You are assisting ${opts.userName}${
        opts.userDesignation ? `, ${opts.userDesignation}` : ""
      }. Address them as ${opts.userName}.`
    : "You do not know the user's name yet — ask for it once, and call save_profile when they answer.";
  return [
    who,
    `When the user states or changes their name or designation, call save_profile and then use the new name. Never address them by any other name once it is stored.`,
    `You are an executive assistant reached through WhatsApp.`,
    `Current date in the user's timezone (${tz}): ${date}, ${time}.`,
    `Reply in short plain text — WhatsApp renders no markdown: no headings, no asterisks, no bold.`,
    `Use bullet lines like "- 09:00 Board review" when listing things.`,
    `Always call the provided tools before answering anything about the calendar, availability or reminders.`,
    `Times in tool results are already in the user's timezone: quote startLocal/display exactly as given. Never convert to UTC, never add or subtract an offset yourself, and never state both a local and a UTC time for the same event.`,
    `You cannot change the calendar yourself. To move an event times, call propose_event_change; to remove one, call propose_event_cancellation. Both store the exact change and send Approve/Reject buttons. Never say an event was moved, created or deleted in Google until a tool result says it was verified.`,
    `When the user refers to an event by position or time ("the first one", "the 9 PM one", "it"), pass the position as ordinal or the clock as time instead of inventing a title; the resolver uses the most recent listing and asks when it is ambiguous.`,
    `Before sending a connect link, say in plain words what Google will ask for: permission to "view and edit your calendar events" — and that nothing in the calendar changes without the user's approval.`,
    `"What's connected" → connection_status. "Manage my connections" → manage_connections. Disconnecting is two steps: ask first, and only call disconnect_calendar with confirm=true after the user says yes.`,
    `If a tool fails, say so in one line and offer the best alternative.`,
    `Keep replies under 120 words unless asked for more detail.`,
    `Never write a calendar link yourself, never repeat a link you saw earlier in this conversation, and never describe a URL's contents: links are inserted by the system only.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function safeTimezone(tz: string | undefined | null): string {
  const candidate = tz || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return "UTC";
  }
}

function safeFormat(date: Date, tz: string, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** Dispatch a user message through the LLM (or the fallback when no key). */
export async function runAgent(deps: AgentDeps): Promise<AgentResult> {
  if (hasLlmConfig(deps.llm ?? null)) {
    return runLlmAgent(deps, deps.llm as LlmConfig);
  }
  return runFallbackAgent(deps);
}

function operationRoute(operation: CalendarOperation): {
  name: CalendarRouteName;
  args: Record<string, unknown>;
} {
  if (operation.action === "cancel") {
    return {
      name: "propose_event_cancellation",
      args: {
        event: operation.event ?? "",
        ...(operation.time ? { time: operation.time } : {}),
        ...(operation.ordinal !== undefined ? { ordinal: operation.ordinal } : {}),
      },
    };
  }
  return {
    name: "propose_event_change",
    args: {
      event: operation.event ?? "",
      start: operation.start,
      ...(operation.ordinal !== undefined ? { ordinal: operation.ordinal } : {}),
    },
  };
}

/** One line per operation: its own exact proposal, or why it could not run. */
function describeOperationResult(
  index: number,
  total: number,
  execution: ToolExecution,
): string {
  const prefix = total > 1 ? `${index + 1}) ` : "";
  if (!execution.ok) {
    const error = (execution.result as { error?: unknown } | null)?.error;
    return `${prefix}I couldn't do that: ${
      typeof error === "string" ? error : "something went wrong"
    }`;
  }
  const message = (execution.result as { message?: unknown } | null)?.message;
  return `${prefix}${
    typeof message === "string" && message ? message : "Done."
  }`;
}

/**
 * Route a calendar intention before the model sees it. A message that names a
 * cancel or reschedule — and the event it applies to — goes straight to that
 * tool, so the model can never convert one intent into the other. A compound
 * message becomes one independent proposal per action. Everything else
 * (including Approve/Reject, which is decided before this point) goes to the
 * normal agent.
 */
export async function dispatchOrRun(deps: AgentDeps, userMessage: string): Promise<AgentResult> {
  const { operations } = parseCalendarIntent(userMessage);
  if (operations.length === 0) return runAgent(deps);

  // A deployment without the proposing tools keeps the conversation intact
  // rather than failing a route it cannot serve.
  if (
    operations.some(
      (operation) => !deps.tools[operationRoute(operation).name],
    )
  ) {
    return runAgent(deps);
  }

  const executions: ToolExecution[] = [];
  for (const operation of operations) {
    const route = operationRoute(operation);
    const handler = deps.tools[route.name];
    try {
      const result = await handler(route.args);
      const execution: ToolExecution = {
        name: route.name,
        args: route.args,
        result,
        ok: true,
      };
      executions.push(execution);
      deps.onToolCall?.(execution);
    } catch (err) {
      const execution: ToolExecution = {
        name: route.name,
        args: route.args,
        result: { error: err instanceof Error ? err.message : String(err) },
        ok: false,
      };
      executions.push(execution);
      deps.onToolCall?.(execution);
    }
  }

  return {
    // Each operation already produced its own approval text; nothing is
    // claimed as done here, and a failure never hides the other proposal.
    reply: executions
      .map((execution, index) =>
        describeOperationResult(index, executions.length, execution),
      )
      .join("\n\n"),
    toolCalls: executions,
    mode: "fallback",
  };
}

async function runLlmAgent(deps: AgentDeps, llm: LlmConfig): Promise<AgentResult> {
  const defs = Object.keys(deps.tools)
    .map(toolDefinitionFor)
    .filter((d): d is ToolDefinition => !!d);

  const messages: LlmMessage[] = [
    { role: "system", content: deps.systemPrompt },
    ...deps.history,
    { role: "user", content: deps.userMessage },
  ];

  const executions: ToolExecution[] = [];
  const maxTurns = deps.maxTurns ?? 5;

  for (let turn = 0; turn < maxTurns; turn++) {
    const result = await chat(llm, { messages, tools: defs });

    if (result.toolCalls.length === 0) {
      return {
        reply: result.content?.trim() || "Hmm, I don't have an answer for that.",
        toolCalls: executions,
        mode: "llm",
      };
    }

    messages.push({
      role: "assistant",
      content: result.content,
      tool_calls: result.toolCalls,
    });

    for (const call of result.toolCalls) {
      const execution = await executeTool(deps, call.function.name, call.function.arguments, call.id);
      executions.push(execution);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(execution.result),
      });
    }
  }

  return {
    reply: "I hit my tool-call limit on that one — could you rephrase it more simply?",
    toolCalls: executions,
    mode: "llm",
  };
}

async function executeTool(
  deps: AgentDeps,
  name: string,
  rawArgs: string,
  _callId: string,
): Promise<ToolExecution> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}");
    if (typeof args !== "object" || args === null || Array.isArray(args)) args = {};
  } catch {
    args = {};
  }

  const handler = deps.tools[name];
  if (!handler) {
    return { name, args, result: { error: `unknown tool: ${name}` }, ok: false };
  }
  try {
    const result = await handler(args);
    const execution: ToolExecution = { name, args, result, ok: true };
    deps.onToolCall?.(execution);
    return execution;
  } catch (err) {
    const execution: ToolExecution = {
      name,
      args,
      result: { error: err instanceof Error ? err.message : String(err) },
      ok: false,
    };
    deps.onToolCall?.(execution);
    return execution;
  }
}
