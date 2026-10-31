import type { Metadata } from "next";
import StaticPage from "@/components/StaticPage";
import CtaButton from "@/components/CtaButton";
import { APP_NAME, COMPANY } from "@/lib/site";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata(
  "Contact Us",
  `Questions, feedback or support for ${APP_NAME}? Here is the fastest way to reach us.`,
  "/contact",
);

export default function ContactPage() {
  return (
    <StaticPage
      eyebrow="Get in touch"
      title="Contact Us"
      lead="A real person reads everything that comes in. Pick whichever channel is easiest for you — WhatsApp is usually the fastest."
    >
      <div className="grid-3 contact-grid">
        <div className="card">
          <div className="icon" aria-hidden="true">
            💬
          </div>
          <h3>WhatsApp</h3>
          <p>
            The same chat you use for ECOS. Best for support, quick questions
            and feedback — typically answered within a few hours.
          </p>
          <div className="contact-actions">
            <CtaButton size="sm">Message us</CtaButton>
          </div>
        </div>

        <div className="card">
          <div className="icon" aria-hidden="true">
            ✉️
          </div>
          <h3>Email</h3>
          <p>
            For longer requests, partnerships, billing or press:
            <br />
            <a href="mailto:hello@ecos.app">hello@ecos.app</a>
          </p>
          <p>We aim to reply within one business day.</p>
        </div>

        <div className="card">
          <div className="icon" aria-hidden="true">
            📞
          </div>
          <h3>Phone</h3>
          <p>
            Prefer to talk? Call us on{" "}
            <a href={`tel:${COMPANY.phone}`}>{COMPANY.phoneDisplay}</a>.
          </p>
          <p>Weekdays, 9am–5pm (WAT).</p>
        </div>

        <div className="card">
          <div className="icon" aria-hidden="true">
            ⚖️
          </div>
          <h3>Legal &amp; privacy</h3>
          <p>
            Data requests, deletion and legal notices:
            <br />
            <a href="mailto:legal@ecos.app">legal@ecos.app</a>
          </p>
          <p>
            See also our <a href="/privacy">Privacy Policy</a> and{" "}
            <a href="/terms">Terms of Service</a>.
          </p>
        </div>
      </div>

      <div className="prose">
        <h2>Before you write</h2>
        <p>
          If ECOS did something unexpected in your chat, sending us the date
          and a short description of what happened helps us find it quickly —
          and yes, you can just tell ECOS itself; it forwards anything it
          cannot solve.
        </p>
        <p>
          Looking for how the product works? Start with{" "}
          <a href="/about">About Us</a>, or open WhatsApp and ask.
        </p>
        <p>
          <strong>Office:</strong> {COMPANY.address}
        </p>
      </div>
    </StaticPage>
  );
}
