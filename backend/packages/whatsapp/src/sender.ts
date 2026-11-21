import { randomUUID } from "node:crypto";

/** Outbound channel abstraction — dev logs, production talks to Meta. */
/** One tappable reply button; Meta allows at most three, titles ≤ 20 chars. */
export interface Button {
  /** Echoed back in the webhook as the button reply id, e.g. "appr:<uuid>". */
  id: string;
  title: string;
}

/** A file to upload through the WhatsApp media endpoint. */
export interface MediaFile {
  data: Buffer | Uint8Array;
  mimeType: string;
  filename: string;
}

export interface Sender {
  readonly kind: string;
  sendText(to: string, text: string): Promise<string>;
  /**
   * Official WhatsApp typing indicator, tied to the inbound message id. It
   * also marks that message read and disappears after 25s or on our reply.
   */
  sendTypingIndicator?(messageId: string): Promise<void>;
  /** Upload a file to the Cloud API media store; returns the media id. */
  uploadMedia?(file: MediaFile): Promise<string>;
  /** Send an already-uploaded file as a document attachment. */
  sendDocument?(
    to: string,
    mediaId: string,
    filename: string,
    caption?: string,
  ): Promise<string>;
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
    async sendTypingIndicator(messageId) {
      console.log(`[whatsapp:console] typing… (for ${messageId})`);
    },
    async uploadMedia(file) {
      console.log(
        `[whatsapp:console] uploaded ${file.filename} (${file.mimeType}, ${file.data.length} bytes)`,
      );
      return `console-media:${randomUUID()}`;
    },
    async sendDocument(to, mediaId, filename, caption) {
      console.log(
        `\n[whatsapp:console] → ${to} (document ${filename}, media ${mediaId})` +
          (caption ? `\n${caption}` : "") +
          "\n",
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

  async function post(payload: Record<string, unknown>): Promise<Record<string, any>> {
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
      const code = data?.error?.code ? ` [${data.error.code}]` : "";
      const detail = data?.error?.message ?? JSON.stringify(data);
      throw new Error(`WhatsApp send failed (${res.status})${code}: ${detail}`);
    }
    return data;
  }

  async function postMessage(payload: Record<string, unknown>): Promise<string> {
    const data = await post(payload);
    return data?.messages?.[0]?.id ?? "";
  }

  return {
    kind: "whatsapp-cloud",
    async sendText(to, text) {
      return postMessage({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { preview_url: false, body: text },
      });
    },
    async sendButtons(to, text, buttons) {
      return postMessage({
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
      return postMessage({
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
    async sendTypingIndicator(messageId) {
      // The documented call: a read receipt for the inbound message, with the
      // typing indicator attached. It is not a message and returns success.
      await post({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      });
    },
    async uploadMedia(file) {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", file.mimeType);
      form.append(
        "file",
        new Blob([new Uint8Array(file.data)], { type: file.mimeType }),
        file.filename,
      );
      const res = await fetch(`${endpoint.replace(/\/messages$/, "")}/media`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.accessToken}` },
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (!res.ok || typeof data.id !== "string") {
        const code = data?.error?.code ? ` [${data.error.code}]` : "";
        const detail = data?.error?.message ?? JSON.stringify(data);
        throw new Error(`WhatsApp media upload failed (${res.status})${code}: ${detail}`);
      }
      return data.id;
    },
    async sendDocument(to, mediaId, filename, caption) {
      return postMessage({
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: {
          id: mediaId,
          filename,
          ...(caption ? { caption: caption.slice(0, 1024) } : {}),
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
