/**
 * Single source of truth for the WhatsApp call-to-action.
 *
 * Swap WHATSAPP_NUMBER for the real ECOS business number in international
 * format, digits only (no "+", no spaces) — or set NEXT_PUBLIC_WHATSAPP_NUMBER
 * in frontend/.env.local.
 */
const number = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? "15551234567";

const message =
  process.env.NEXT_PUBLIC_WHATSAPP_MESSAGE ??
  "Hi ECOS — I'd like to hand over my busywork.";

export const WHATSAPP_URL = `https://wa.me/${number}?text=${encodeURIComponent(
  message,
)}`;

export const APP_NAME = "ECOS";
export const APP_TAGLINE = "Electronic Chief Of Staff";
