import type { Metadata } from "next";
import StaticPage from "@/components/StaticPage";
import { APP_NAME, COMPANY } from "@/lib/site";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata(
  "Terms of Service",
  `The terms that apply when you use ${APP_NAME}.`,
  "/terms",
);

export default function TermsPage() {
  return (
    <StaticPage
      eyebrow="Legal"
      title="Terms of Service"
      lead="These terms govern your use of ECOS. By messaging ECOS or using this site, you agree to them. Please read them carefully."
    >
      <div className="prose">
        <span className="updated">Last updated: 31 October 2026</span>

        <h2>1. Agreement to these terms</h2>
        <p>
          These Terms of Service (\"Terms\") are a binding agreement between you
          and {COMPANY.name}, the company behind {APP_NAME} (\"ECOS\", \"we\",
          \"us\"). By accessing this website,
          starting a chat with ECOS, or using any part of the service, you
          confirm that you have read and agree to these Terms and to our{" "}
          <a href="/privacy">Privacy Policy</a>. If you do not agree, do not
          use ECOS.
        </p>

        <h2>2. The service</h2>
        <p>
          ECOS is a digital chief of staff delivered through messaging. It can
          help you manage your calendar, reminders, tasks and follow-ups by
          interpreting the instructions you send it. Features may change,
          improve or be discontinued as we develop the service.
        </p>

        <h2>3. Your account and responsibilities</h2>
        <ul>
          <li>
            You must be at least 18 years old and capable of entering a legally
            binding agreement.
          </li>
          <li>
            You agree to provide accurate information and to keep your
            WhatsApp account and device secure.
          </li>
          <li>
            You are responsible for everything done through your ECOS session,
            including instructions you send and actions ECOS takes on your
            behalf at your request.
          </li>
          <li>
            You must have the rights and permissions for any calendar,
            contact or other service you connect to ECOS.
          </li>
        </ul>

        <h2>4. Acceptable use</h2>
        <p>You agree not to use ECOS to:</p>
        <ul>
          <li>Break any applicable law, regulation or third-party right;</li>
          <li>
            Send spam, deceptive content or messages that impersonate another
            person;
          </li>
          <li>
            Probe, disrupt or circumvent our security, rate limits or
            infrastructure;
          </li>
          <li>
            Resell, sublicense or commercially exploit the service without our
            written consent;
          </li>
          <li>
            Use ECOS to make decisions about other people in areas with legal
            consequences, such as credit, employment or housing.
          </li>
        </ul>

        <h2>5. Third-party services</h2>
        <p>
          ECOS interoperates with third-party services such as WhatsApp and
          calendar providers. Those services are governed by their own terms
          and privacy policies, and we are not responsible for their
          availability, actions or content. You may need your own accounts with
          them to use the related features.
        </p>

        <h2>6. Fees and payment</h2>
        <p>
          Some features of ECOS may be offered for a fee. If you choose a paid
          plan, the price, billing cycle and what is included will be shown
          before you subscribe. Except where the law requires otherwise, fees
          already paid are non-refundable, and we may change pricing with at
          least 30 days&apos; notice.
        </p>

        <h2>7. Your content and our intellectual property</h2>
        <p>
          You keep all rights to the content you send to ECOS. You grant us a
          limited, non-exclusive licence to host, process and transmit that
          content solely to operate the service for you. The ECOS name,
          website, software, branding and materials are owned by us or our
          licensors and are not licensed to you except for your personal use of
          the service.
        </p>

        <h2>8. No professional advice</h2>
        <p>
          ECOS helps with logistics and organisation. It does not provide
          medical, legal, financial or other professional advice, and its
          output is not a substitute for consulting a qualified professional.
          Always review important actions before they are finalised.
        </p>

        <h2>9. Disclaimers</h2>
        <p>
          The service is provided \"as is\" and \"as available\" without
          warranties of any kind, whether express or implied, including
          warranties of merchantability, fitness for a particular purpose and
          non-infringement. We do not warrant that ECOS will be uninterrupted,
          error-free, or that reminders and scheduled actions will always fire
          exactly on time.
        </p>

        <h2>10. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, ECOS and its team will not be
          liable for any indirect, incidental, special, consequential or
          punitive damages, or for any loss of profits, data, goodwill or
          business opportunity, arising from your use of the service. Our total
          liability for any claim relating to the service will not exceed the
          amount you paid us in the 12 months before the claim arose (or, if
          none, USD $100).
        </p>

        <h2>11. Indemnity</h2>
        <p>
          You agree to indemnify and hold ECOS harmless from claims, damages
          and expenses (including reasonable legal fees) arising from your
          misuse of the service, your content, or your breach of these Terms.
        </p>

        <h2>12. Termination</h2>
        <p>
          You may stop using ECOS at any time by messaging us or deleting the
          chat. We may suspend or terminate your access if you breach these
          Terms, if required by law, or to protect the service and its users.
          Sections that by their nature should survive termination will survive.
        </p>

        <h2>13. Changes to these terms</h2>
        <p>
          We may update these Terms from time to time. The date at the top of
          this page always reflects the latest version, and for material changes
          we will notify you in advance. Continuing to use ECOS after an update
          means you accept the new Terms.
        </p>

        <h2>14. Contact us</h2>
        <p>
          Questions about these Terms? Reach us any time on the{" "}
          <a href="/contact">Contact Us</a> page, email{" "}
          <a href="mailto:legal@ecos.app">legal@ecos.app</a>, or call{" "}
          <a href={`tel:${COMPANY.phone}`}>{COMPANY.phoneDisplay}</a>.
        </p>
        <p>
          {COMPANY.name}, {COMPANY.address}
        </p>
      </div>
    </StaticPage>
  );
}
