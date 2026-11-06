import { randomUUID } from "node:crypto";

/** Outbound channel abstraction — dev logs, production talks to Meta. */
/** One tappable reply button; Meta allows at most three, titles ≤ 20 chars. */
export interface Button {
  /** Echoed back in the webhook as the button reply id, e.g. "appr:<uuid>". */
  id: string;
  title: string;
}

export interface Sender {
  readonly kind: string;
  sendText(to: string, text: string): Promise<string>;
  /**
   * Text plus tappable reply buttons. Taps come back as inbound interactive
   * messages carrying the button id, so approvals never rely on free text.
   */
  sendButtons(to: string, text: string, buttons: Button[]): Promise<string>;
  /**
   * Proactive/outside-window send using a pre-approved Meta template.
   * Not all senders support it (console simply renders a placeholder).
   */
  sendTemplate(
    to: string,
    name: string,
    language: string,
    params: string[],
  ): Promise<string>;
}

/** Dev sender: prints to the terminal so the whole pipeline is observable. */
export function createConsoleSender(label = "console"): Sender {
  return {
    kind: `console:${label}`,
    async sendText(to, text) {
      console.log(`\n[whatsapp:console] → ${to}\n${text}\n`);
      return `console:${randomUUID()}`;
    },
    async sendButtons(to, text, buttons) {
      const list = buttons.map((b) => `[${b.title}] (${b.id})`).join("  ");
      console.log(`\n[whatsapp:console] → ${to}\n${text}\n${list}\n`);
      return `console:${randomUUID()}`;
    },
    async sendTemplate(to, name, language, params) {
      console.log(
        `\n[whatsapp:console] → ${to} (template ${name}/${language} ${JSON.stringify(params)})\n`,
      );
      return `console:${randomUUID()}`;
    },
  };
}

export interface CloudApiConfig {
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
}

/** Real sender against the Meta WhatsApp Cloud API (Graph). */
export function createCloudApiSender(cfg: CloudApiConfig): Sender {
  const endpoint = `https://graph.facebook.com/${cfg.apiVersion ?? "v21.0"}/${cfg.phoneNumberId}/messages`;

  async function post(payload: Record<string, unknown>): Promise<string> {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      const detail = data?.error?.message ?? JSON.stringify(data);
      throw new Error(`WhatsApp send failed (${res.status}): ${detail}`);
    }
    return data?.messages?.[0]?.id ?? "";
  }

  return {
    kind: "whatsapp-cloud",
    async sendText(to, text) {
      return post({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { preview_url: false, body: text },
      });
    },
    async sendButtons(to, text, buttons) {
      return post({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text },
          action: {
            buttons: buttons.slice(0, 3).map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        },
      });
    },
    async sendTemplate(to, name, language, params) {
      return post({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name,
          language: { code: language },
          components:
            params.length > 0
              ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }]
              : undefined,
        },
      });
    },
  };
}

export interface SenderConfig {
  mode: "console" | "whatsapp";
  accessToken?: string;
  phoneNumberId?: string;
  apiVersion?: string;
}

/** Pick the sender from config; fails loudly when production mode lacks creds. */
export function createConfiguredSender(cfg: SenderConfig): Sender {
  if (cfg.mode === "whatsapp") {
    if (!cfg.accessToken || !cfg.phoneNumberId) {
      throw new Error(
        "SENDER=whatsapp requires META_ACCESS_TOKEN and META_PHONE_NUMBER_ID",
      );
    }
    return createCloudApiSender({
      accessToken: cfg.accessToken,
      phoneNumberId: cfg.phoneNumberId,
      apiVersion: cfg.apiVersion,
    });
  }
  return createConsoleSender();
}
