import type { Metadata } from "next";
import { APP_NAME, SITE_URL } from "@/lib/site";

/**
 * Metadata for a standalone page: full title, canonical URL and the Open
 * Graph / Twitter tags used when the link is shared.
 *
 * `path` is the route relative to the site root, e.g. "/privacy".
 */
export function pageMetadata(
  title: string,
  description: string,
  path: string,
): Metadata {
  const url = `${SITE_URL}${path === "/" ? "" : path}`;
  const fullTitle = `${APP_NAME} — ${title}`;

  return {
    title: fullTitle,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      url,
      siteName: APP_NAME,
      title: fullTitle,
      description,
    },
    twitter: {
      card: "summary",
      title: fullTitle,
      description,
    },
  };
}
