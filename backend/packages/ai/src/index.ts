export * from "./llm.js";
export * from "./tools.js";
export * from "./agent.js";
export * from "./fallback.js";
export * from "./profile.js";

/**
 * A copy of a message in which every calendar link's query values have been
 * replaced with [redacted]. Used for the LLM context and for any message that
 * is stored for later turns, so a link that was in the conversation history
 * can never be re-quoted by the model or recorded back to the database.
 */
export interface RedactedOutbound {
  /** The same reply text, with `?token=` / `?state=` values replaced by
   * `[redacted]`. The text is still suitable for sending to the user.
   * Anything that does not parse as a link is returned unchanged.
   */
  reply: string;
}

/**
 * Replace the query values of `token=` and `state=` in a URL or any piece of
 * text that contains one. The scheme, host, path and any *other* query
 * parameters are left untouched, so a redirect target that legitimately
 * carries other parameters is not mangled.
 *
 * `https://ecos.example.com/auth/google?token=abc.def&theme=dark`
 *   -> `https://ecos.example.com/auth/google?token=[redacted]&theme=dark`
 */
export function redactQueryValues(text: string): string {
  // Whitespace around a link matters to a model, so we keep the surrounding
  // text intact and only clamp the value.
  const urlPattern = /(\b(https?:\/\/[^\s<>"']+))/g;

  return text.replace(urlPattern, (match, url) => {
    try {
      const parsed = new URL(url);
      const changed = Array.from(parsed.searchParams.entries())
        .some(([key]) => key === "token" || key === "state");
      if (!changed) return match;

      const search = Array.from(parsed.searchParams.entries())
        .map(([key, value]) => (key === "token" || key === "state" ? `${key}=[redacted]` : `${key}=${value}`))
        .join("&");
      const redacted = `${parsed.origin}${parsed.pathname}?${search}`;
      return redacted;
    } catch {
      // Not a URL at all — leave the token-looking text as-is so a model
      // seeing something it cannot parse cannot learn to re-quote it.
      return match;
    }
  });
}
