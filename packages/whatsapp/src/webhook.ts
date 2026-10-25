/** A normalised inbound WhatsApp message extracted from a webhook payload. */
export interface InboundMessage {
  /** Meta's message id — stable across webhook redeliveries, so it dedupes. */
  id: string;
  from: string;
  timestamp: Date;
  type: string;
  /** Text body for text/button/interactive messages, null for media etc. */
  text: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract inbound messages from a Meta Cloud API webhook POST body.
 * Returns [] for anything unexpected — webhook payloads must never throw,
 * or Meta will keep retrying delivery forever.
 */
export function parseInboundMessages(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  if (!isRecord(body)) return out;

  const entries = Array.isArray(body.entry) ? body.entry : [];
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change)) continue;
      const value = change.value;
      if (!isRecord(value) || !Array.isArray(value.messages)) continue;

      for (const raw of value.messages) {
        if (!isRecord(raw)) continue;
        if (typeof raw.id !== "string" || typeof raw.from !== "string") continue;

        const type = typeof raw.type === "string" ? raw.type : "unknown";
        let text: string | null = null;
        if (type === "text" && isRecord(raw.text) && typeof raw.text.body === "string") {
          text = raw.text.body;
        } else if (type === "button" && isRecord(raw.button) && typeof raw.button.text === "string") {
          text = raw.button.text;
        } else if (type === "interactive" && isRecord(raw.interactive)) {
          const interactive = raw.interactive;
          if (isRecord(interactive.button_reply) && typeof interactive.button_reply.title === "string") {
            text = interactive.button_reply.title;
          } else if (isRecord(interactive.list_reply) && typeof interactive.list_reply.title === "string") {
            text = interactive.list_reply.title;
          }
        }

        const ts = Number(raw.timestamp);
        out.push({
          id: raw.id,
          from: raw.from,
          timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
          type,
          text,
        });
      }
    }
  }
  return out;
}

/** Shape of Meta's GET /webhub handshake (returned as query params). */
export interface WebhookVerifyQuery {
  "hub.mode"?: string;
  "hub.verify_token"?: string;
  "hub.challenge"?: string;
}

export function verifyHandshake(
  query: WebhookVerifyQuery,
  expectedToken: string,
): boolean {
  return (
    query["hub.mode"] === "subscribe" &&
    !!expectedToken &&
    query["hub.verify_token"] === expectedToken
  );
}
