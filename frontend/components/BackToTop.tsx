"use client";

/**
 * Round arrow button at the end of the footer. Scrolls back to the top —
 * smooth by default, instant when the visitor prefers reduced motion (the
 * global `scroll-behavior` rule takes care of that).
 */
export default function BackToTop() {
  return (
    <button
      type="button"
      className="back-to-top"
      onClick={() => window.scrollTo(0, 0)}
      aria-label="Back to top"
      title="Back to top"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 19V5" />
        <path d="m5 12 7-7 7 7" />
      </svg>
    </button>
  );
}
