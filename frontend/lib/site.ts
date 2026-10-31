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
  "Hi ECOS, I'd like to hand over my busywork.";

export const WHATSAPP_URL = `https://wa.me/${number}?text=${encodeURIComponent(
  message,
)}`;

export const APP_NAME = "ECOS";
export const APP_TAGLINE = "Electronic Chief Of Staff";

/** The legal business behind ECOS. Used in the footer and contact pages. */
export const COMPANY = {
  name: "Enkindle Africa",
  address: "14 Montgomery Rd, Yaba, Lagos State, Nigeria",
  phone: "+2348039243070",
  phoneDisplay: "+234 803 924 3070",
} as const;

/**
 * Canonical origin used for sitemaps, canonical URLs and Open Graph tags.
 * Override with NEXT_PUBLIC_SITE_URL when the site is served from another
 * domain.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://ecos.app"
).replace(/\/$/, "");
