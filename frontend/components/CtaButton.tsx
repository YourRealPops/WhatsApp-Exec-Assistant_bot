"use client";

import { motion } from "framer-motion";
import { WHATSAPP_URL } from "@/lib/site";

type Props = {
  children: React.ReactNode;
  variant?: "primary" | "ghost";
  size?: "sm" | "md";
  className?: string;
};

/**
 * The one CTA on the site: opens WhatsApp (app on mobile, wa.me on desktop)
 * with a prefilled message.
 */
export default function CtaButton({
  children,
  variant = "primary",
  size = "md",
  className = "",
}: Props) {
  return (
    <motion.a
      href={WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""} ${className}`}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
    >
      <WhatsAppGlyph />
      {children}
    </motion.a>
  );
}

function WhatsAppGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.46 1.32 4.97L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.9-4.45 9.9-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 1.82c2.16 0 4.19.84 5.72 2.37a8.05 8.05 0 0 1 2.37 5.72c0 4.46-3.63 8.09-8.09 8.09a8.1 8.1 0 0 1-4.13-1.13l-.3-.18-3.11.82.83-3.04-.19-.31a8.03 8.03 0 0 1-1.24-4.3c0-4.46 3.63-8.09 8.14-8.04Zm-4.4 4.1c-.2 0-.53.07-.81.37-.28.3-1.06 1.04-1.06 2.53s1.09 2.94 1.24 3.14c.15.2 2.1 3.36 5.14 4.58 2.53 1.02 3.05.82 3.6.77.55-.05 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48a9 9 0 0 1-1.66-2.06c-.17-.3-.02-.46.13-.61.14-.14.3-.35.45-.53.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.66-1.63-.91-2.23-.24-.58-.48-.5-.66-.51h-.58Z" />
    </svg>
  );
}
