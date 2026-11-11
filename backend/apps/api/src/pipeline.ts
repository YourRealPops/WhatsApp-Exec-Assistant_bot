import { randomUUID } from "node:crypto";
import {
  ensureUser,
  getCalendarAccount,
  getUserById,
  listHistory,
  saveMessage,
  setUserProfile,
  type Db,
} from "@exec-assistant/db";
import { buildConnectUrl } from "@exec-assistant/calendar";
import { redactQueryValues } from "@exec-assistant/ai";

import {
  buildSystemPrompt,
  parseProfile,
  runAgent,
  type AgentResult,
  type LlmConfig,
  type LlmMessage,
} from "@exec-assistant/ai";
import type { Button, InboundMessage, Sender } from "@exec-assistant/whatsapp";
import { buildTools, ensureDevEvents } from "./tools.js";
import type { GoogleConfig } from "./calendar-access.js";
import { handleDecision } from "./decisions.js";

/**
 * The first thing a brand-new user ever hears from ECOS. It is fixed copy on
 * purpose: it introduces the assistant and asks for name + designation, so the
 * opening turn is a handshake rather than an answer to whatever they happened
 * to type first.
 */
export const FIRST_CONTACT_GREETING =
  "Hello, I am your new e Chief of Staff, can I know your name and designation?";

export interface PipelineDeps {
  db: Db;
  sender: Sender;
  llm?: LlmConfig | null;
  devCalendar: boolean;
  defaultTimezone: string;
  /** Both needed to append a reconnect link to a reply. */
  publicBaseUrl?: string;
  oauthStateSecret?: string;
  /** Google credentials + token key; absent disables calendar writes. */
  google?: GoogleConfig | null;
  /** How long an approval stays valid (APPROVAL_TTL_MINUTES). */
  approvalTtlMinutes?: number;
}

/**
 * Delivers ECOS's introduction and records it, so the user's reply is read as
 * the answer to it (name + designation). This is the only place the opener is
 * sent: the first-contact branch below, the local CLI at startup, and
 * `pnpm intro` for outbound outreach all go through here.
 *
 * Delivery happens before the record is written: if the send fails, the
 * conversation stays empty and the user is introduced on their next message
 * instead of being silently treated as already greeted.
 */
export async function sendFirstContact(
  deps: Pick<PipelineDeps, "db" | "sender">,
  opts: { userId: string; phone: string; deliver?: () => Promise<unknown> },
): Promise<AgentResult> {
  if (opts.deliver) await opts.deliver();
  else await safeSend(deps, opts.phone, FIRST_CONTACT_GREETING);

  await saveMessage(deps.db, {
    id: `out:${randomUUID()}`,
    userId: opts.userId,
    direction: "outbound",
    body: FIRST_CONTACT_GREETING,
  });
  console.log(`[pipeline] → ${opts.phone} (onboarding): ${FIRST_CONTACT_GREETING}`);
  return { reply: FIRST_CONTACT_GREETING, toolCalls: [], mode: "onboarding" };
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
        replyId: msg.replyId,
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
    /** Button id from a tapped reply button, when this turn was a tap. */
    replyId?: string | null;
    excludeMessageId?: string;
  },
): Promise<AgentResult> {
  let user = await getUserById(deps.db, opts.userId);
  const timezone = user?.timezone ?? deps.defaultTimezone;

  const historyRows = await listHistory(deps.db, opts.userId, 20);
  const prior = historyRows.filter((m) => m.id !== opts.excludeMessageId);

  // First contact: ECOS speaks first, with its introduction. No agent turn is
  // spent on it — the user's reply (name, designation) is the first real turn,
  // and it arrives with the greeting already in history.
  if (prior.length === 0) return sendFirstContact(deps, opts);

  // The greeting asked for name and designation, so the reply to it is the
  // profile answer. Capture it here rather than relying on the model: with no
  // LLM key the fallback would otherwise drop the name on the floor.
  const lastTurn = prior[prior.length - 1];
  if (lastTurn?.direction === "outbound" && lastTurn.body === FIRST_CONTACT_GREETING) {
    const profile = parseProfile(opts.text);
    if (profile) {
      const saved = await setUserProfile(deps.db, opts.userId, {
        name: profile.name,
        designation: profile.designation,
      });
      if (saved) user = saved;
    }
  }

  // Approve/Reject is decided by code, not by the model: ownership, expiry,
  // one-time use and the integrity hash are all checked before any write.
  const decision = await handleDecision(
    { db: deps.db, google: deps.google ?? null },
    { userId: opts.userId, text: opts.text, replyId: opts.replyId ?? null },
  );
  if (decision) {  await saveMessage(deps.db, {
    id: `out:${randomUUID()}`,
    userId: opts.userId,
    direction: "outbound",
    body: redactQueryValues(decision.reply),
  });
    console.log(`[pipeline] → ${opts.phone} (${decision.mode}): ${decision.reply}`);
    await safeSend(deps, opts.phone, decision.reply);
    return decision;
  }

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
    publicBaseUrl: deps.publicBaseUrl,
    oauthStateSecret: deps.oauthStateSecret,
    google: deps.google ?? null,
    needsConnect: !deps.google,
    approvalTtlMinutes: deps.approvalTtlMinutes,
    currentMessage: opts.text,
  });

  const result = await runAgent({
    llm: deps.llm,
    systemPrompt: buildSystemPrompt({
      timezone,
      userName: user?.name,
      userDesignation: user?.designation,
    }),
    timezone,
    history,
    userMessage: opts.text,
    tools,
    onToolCall: (exec) =>
      console.log(
        `[agent] ${exec.name}(${JSON.stringify(exec.args)}) → ${exec.ok ? "ok" : `error: ${JSON.stringify(exec.result)}`}`,
      ),
  });

  // A created proposal is always delivered verbatim, with the buttons that
  // decide it: the exact change the user approves is the exact change stored.
  const proposal = result.toolCalls.find(
    (call) => call.name === "propose_event_change" && call.ok,
  )?.result as { proposalId?: string; message?: string } | undefined;
  let reply = result.reply;
  let buttons: Button[] | undefined;
  let saved: boolean;
  if (proposal?.proposalId && proposal.message) {
    reply = proposal.message;
    buttons = [
      { id: `appr:${proposal.proposalId}`, title: "Approve" },
      { id: `rej:${proposal.proposalId}`, title: "Reject" },
    ];
  }

  // A reply built by the model may embed a raw calendar link (the
  // connect_calendar tool result carries one, and the model can copy it back.
  // Clamp it in code only, in one place, before it is ever stored or sent.
  const safeReply = redactQueryValues(reply);

  saved = await saveMessage(deps.db, {
    id: `out:${randomUUID()}`,
    userId: opts.userId,
    direction: "outbound",
    body: safeReply,
  }) as boolean;
  if (!saved) {
    console.error(`[pipeline] failed to persist outbound for ${opts.phone}`);
  }

  console.log(`[pipeline] → ${opts.phone} (${result.mode}): ${safeReply}`);
  if (buttons) {
    try {
      // The link the user taps must reach the client unchanged, so the
      // connect/oauth/connections URL is transmitted raw and only the
      // stored copy is redacted.
      await deps.sender.sendButtons(opts.phone, reply, buttons);
    } catch (err) {
      console.error(`[pipeline] button send to ${opts.phone} failed:`, err);
      await safeSend(deps, opts.phone, `${reply}\n\nReply yes to approve or no to reject.`);
    }
  } else {
    // Push the unredacted reply to the user so the complete calendar link
    // (with the signed token) reaches their browser; storage keeps the redacted copy.
    await safeSend(deps, opts.phone, reply);
  }
  return { ...result, reply };
}

async function safeSend(
  deps: Pick<PipelineDeps, "sender">,
  to: string,
  text: string,
): Promise<void> {
  try {
    await deps.sender.sendText(to, text);
  } catch (err) {
    console.error(`[pipeline] send to ${to} failed:`, err);
  }
}
