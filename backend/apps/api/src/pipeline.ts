import { randomUUID } from "node:crypto";
import {
  ensureUser,
  getUserById,
  listHistory,
  saveMessage,
  type Db,
} from "@exec-assistant/db";
import {
  buildSystemPrompt,
  runAgent,
  type AgentResult,
  type LlmConfig,
  type LlmMessage,
} from "@exec-assistant/ai";
import type { InboundMessage, Sender } from "@exec-assistant/whatsapp";
import { buildTools, ensureDevEvents } from "./tools.js";

export interface PipelineDeps {
  db: Db;
  sender: Sender;
  llm?: LlmConfig | null;
  devCalendar: boolean;
  defaultTimezone: string;
}

/** Handle each parsed webhook message; one failure never blocks the rest. */
export async function processInbound(
  deps: PipelineDeps,
  messages: InboundMessage[],
): Promise<void> {
  for (const msg of messages) {
    try {
      const user = await ensureUser(deps.db, {
        phone: msg.from,
        timezone: deps.defaultTimezone,
      });
      const inserted = await saveMessage(deps.db, {
        id: msg.id,
        userId: user.id,
        direction: "inbound",
        body: msg.text ?? `[${msg.type}]`,
      });
      if (!inserted) {
        console.log(`[pipeline] duplicate delivery of ${msg.id} — skipped`);
        continue;
      }
      console.log(`[pipeline] ← ${user.phone}: ${msg.text ?? `[${msg.type}]`}`);

      if (!msg.text) {
        await safeSend(
          deps,
          user.phone,
          "I can only read text messages for now — send me words and I'll take it from there.",
        );
        continue;
      }

      await handleUserText(deps, {
        userId: user.id,
        phone: user.phone,
        text: msg.text,
        excludeMessageId: msg.id,
      });
    } catch (err) {
      console.error(`[pipeline] failed on message ${msg.id}:`, err);
    }
  }
}

/**
 * Core conversation turn: history → agent (LLM or fallback) → reply → send.
 * Used by both the webhook pipeline and the local CLI.
 */
export async function handleUserText(
  deps: PipelineDeps,
  opts: {
    userId: string;
    phone: string;
    text: string;
    excludeMessageId?: string;
  },
): Promise<AgentResult> {
  const user = await getUserById(deps.db, opts.userId);
  const timezone = user?.timezone ?? deps.defaultTimezone;

  const historyRows = await listHistory(deps.db, opts.userId, 20);
  const prior = historyRows.filter((m) => m.id !== opts.excludeMessageId);
  const history: LlmMessage[] = prior.map((m) => ({
    role: m.direction === "inbound" ? "user" : "assistant",
    content: m.body,
  }));

  await ensureDevEvents(deps.db, opts.userId, deps.devCalendar);

  const tools = buildTools({
    db: deps.db,
    userId: opts.userId,
    timezone,
    devCalendar: deps.devCalendar,
  });

  const result = await runAgent({
    llm: deps.llm,
    systemPrompt: buildSystemPrompt({ timezone, userName: user?.name }),
    timezone,
    history,
    userMessage: opts.text,
    tools,
    onToolCall: (exec) =>
      console.log(
        `[agent] ${exec.name}(${JSON.stringify(exec.args)}) → ${exec.ok ? "ok" : `error: ${JSON.stringify(exec.result)}`}`,
      ),
  });

  await saveMessage(deps.db, {
    id: `out:${randomUUID()}`,
    userId: opts.userId,
    direction: "outbound",
    body: result.reply,
  });

  console.log(`[pipeline] → ${opts.phone} (${result.mode}): ${result.reply}`);
  await safeSend(deps, opts.phone, result.reply);
  return result;
}

async function safeSend(deps: PipelineDeps, to: string, text: string): Promise<void> {
  try {
    await deps.sender.sendText(to, text);
  } catch (err) {
    console.error(`[pipeline] send to ${to} failed:`, err);
  }
}
