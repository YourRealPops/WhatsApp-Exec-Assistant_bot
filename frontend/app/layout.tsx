import type { Metadata } from "next";
import "./globals.css";
import { APP_NAME, APP_TAGLINE, SITE_URL } from "@/lib/site";

const description =
  "ECOS is your Electronic Chief Of Staff, living in WhatsApp. Calendar, reminders and follow-ups handled from a single chat.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: `${APP_NAME} — ${APP_TAGLINE}`,
  description,
  applicationName: APP_NAME,
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: APP_NAME,
    title: `${APP_NAME} — ${APP_TAGLINE}`,
    description,
    locale: "en_US",
  },
  twitter: {
    card: "summary",
    title: `${APP_NAME} — ${APP_TAGLINE}`,
    description,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
