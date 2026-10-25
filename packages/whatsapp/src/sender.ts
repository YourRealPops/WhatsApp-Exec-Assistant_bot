import { randomUUID } from "node:crypto";

/** Outbound channel abstraction — dev logs, production talks to Meta. */
export interface Sender {
  readonly kind: string;
  sendText(to: string, text: string): Promise<string>;
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
