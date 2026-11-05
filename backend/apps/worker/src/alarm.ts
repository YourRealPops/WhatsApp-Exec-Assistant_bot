import { randomUUID } from "node:crypto";

/**
 * Outbound alarm channel — the attention-getting counterpart to the WhatsApp
 * `Sender`. A reminder marked as an alarm is delivered as a phone call that
 * rings and reads the reminder out loud, so it alerts the user even when the
 * chat notification is missed.
 */
export interface Alarm {
  readonly kind: string;
  /** Ring `to` (E.164) and speak `text`. Returns the provider's call id. */
  ring(to: string, text: string): Promise<string>;
}

/** Dev alarm: prints to the terminal so the pipeline is observable without telephony. */
export function createConsoleAlarm(label = "console"): Alarm {
  return {
    kind: `console:${label}`,
    async ring(to, text) {
      console.log(`\n[alarm:console] ☎ ringing ${to}\n  speaks: "${text}"\n`);
      return `console:${randomUUID()}`;
    },
  };
}

export interface TwilioConfig {
  accountSid: string;
  apiKey?: string;
  apiSecret?: string;
  authToken?: string;
  /** Provisioned Twilio number the user sees as the caller (E.164). */
  from: string;
  /** Twilio Say voice, e.g. Polly.Joanna. */
  voice?: string;
  language?: string;
  /** How long to let the phone ring before giving up, in seconds. */
  ringSeconds?: number;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Inline TwiML: the reminder is spoken twice, because a single pass is easy to
 * miss while the user is still reaching for the phone.
 */
export function buildTwiML(
  text: string,
  voice: string,
  language: string,
): string {
  const say = `<Say voice="${voice}" language="${language}">${escapeXml(text)}</Say>`;
  return `<Response>${say}${say}</Response>`;
}

/** Real alarm against the Twilio Voice REST API. */
export function createTwilioAlarm(cfg: TwilioConfig): Alarm {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`;
  // An API key/secret pair authenticates as (key SID, secret); the account
  // SID with the auth token is the fallback.
  const useKey = Boolean(cfg.apiKey && cfg.apiSecret);
  const auth = Buffer.from(
    `${useKey ? cfg.apiKey : cfg.accountSid}:${
      useKey ? cfg.apiSecret : (cfg.authToken ?? "")
    }`,
  ).toString("base64");
  const voice = cfg.voice ?? "Polly.Joanna";
  const language = cfg.language ?? "en-US";

  return {
    kind: "twilio",
    async ring(to, text) {
      const body = new URLSearchParams({
        To: to,
        From: cfg.from,
        Twiml: buildTwiML(text, voice, language),
        Timeout: String(cfg.ringSeconds ?? 30),
      });
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (!res.ok) {
        const detail = data?.message ?? JSON.stringify(data);
        throw new Error(`Twilio call failed (${res.status}): ${detail}`);
      }
      return String(data?.sid ?? "");
    },
  };
}

export interface AlarmConfig {
  mode: "off" | "console" | "twilio";
  /** All optional here so a partial env fails with our error, not a type error. */
  twilio: {
    accountSid?: string;
    apiKey?: string;
    apiSecret?: string;
    authToken?: string;
    from?: string;
  };
  voice: string;
  language: string;
  ringSeconds: number;
}

/**
 * Pick the alarm from config; `null` means alarms are disabled.
 * Fails loudly when twilio mode lacks the credentials to actually place a call.
 */
export function createConfiguredAlarm(cfg: AlarmConfig): Alarm | null {
  if (cfg.mode === "off") return null;
  if (cfg.mode === "console") return createConsoleAlarm();

  const { accountSid, from } = cfg.twilio;
  const secret = cfg.twilio.apiSecret || cfg.twilio.authToken;
  if (!accountSid || !from || !secret) {
    throw new Error(
      "ALARM_MODE=twilio requires TWILIO_ACCOUNT_SID, TWILIO_FROM_NUMBER and either TWILIO_AUTH_TOKEN or TWILIO_API_KEY/TWILIO_API_SECRET",
    );
  }
  return createTwilioAlarm({
    accountSid,
    apiKey: cfg.twilio.apiKey,
    apiSecret: cfg.twilio.apiSecret,
    authToken: cfg.twilio.authToken,
    from,
    voice: cfg.voice,
    language: cfg.language,
    ringSeconds: cfg.ringSeconds,
  });
}
