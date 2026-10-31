import type { Metadata } from "next";
import StaticPage from "@/components/StaticPage";
import { APP_NAME, COMPANY } from "@/lib/site";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata(
  "Privacy Policy",
  `How ${APP_NAME} collects, uses and protects your personal information.`,
  "/privacy",
);

export default function PrivacyPage() {
  return (
    <StaticPage
      eyebrow="Legal"
      title="Privacy Policy"
      lead="This policy explains what we collect when you use ECOS, why we collect it, and the choices you have. We keep it to what actually happens with your data."
    >
      <div className="prose">
        <span className="updated">Last updated: 31 October 2026</span>

        <h2>1. Information we collect</h2>
        <p>Depending on how you use {APP_NAME} (\"ECOS\", \"we\", \"us\"), we may collect:</p>
        <ul>
          <li>
            <strong>Information you give us</strong>: your name, WhatsApp
            number, email address and any details you share while chatting with
            ECOS.
          </li>
          <li>
            <strong>Content you submit</strong>: messages, reminders,
            tasks, notes and calendar details you ask ECOS to handle, so it can
            deliver the service you requested.
          </li>
          <li>
            <strong>Connected services data</strong>: calendar events and
            similar records from services you choose to connect (for example
            Google Calendar or Microsoft Outlook), used only to perform the
            actions you ask for.
          </li>
          <li>
            <strong>Usage and device data</strong>: log data such as IP
            address, browser type, pages viewed and timestamps, used for
            security, debugging and improving the service.
          </li>
        </ul>

        <h2>2. How we use your information</h2>
        <p>We use the information we collect to:</p>
        <ul>
          <li>Provide, operate and maintain ECOS: scheduling, reminders, follow-ups and the replies you ask for;</li>
          <li>Personalise and improve the service, including response quality and new features;</li>
          <li>Respond to your questions and provide support;</li>
          <li>Send service-related notices (such as changes to this policy);</li>
          <li>Detect, prevent and address fraud, abuse and security issues;</li>
          <li>Comply with legal obligations.</li>
        </ul>
        <p>
          We do <strong>not</strong> sell your personal information, and we do
          not use the content of your conversations to build advertising
          profiles.
        </p>

        <h2>3. WhatsApp and messaging platforms</h2>
        <p>
          ECOS works through WhatsApp, so your messages travel over Meta&apos;s
          infrastructure. Meta processes your data under its own terms; see the{" "}
          <a
            href="https://www.whatsapp.com/legal/privacy-policy"
            target="_blank"
            rel="noopener noreferrer"
          >
            WhatsApp Privacy Policy
          </a>
          . We only receive the messages that reach ECOS and the metadata
          needed to deliver replies to you.
        </p>

        <h2>4. How we share your information</h2>
        <p>We share information only with:</p>
        <ul>
          <li>
            <strong>Service providers</strong> who host our infrastructure,
            databases and messaging integrations, bound to process data on our
            behalf;
          </li>
          <li>
            <strong>Connected third-party services</strong> you explicitly link
            (such as your calendar provider), at your direction;
          </li>
          <li>
            <strong>Authorities</strong>, where required by law or to protect
            the rights, safety and property of ECOS, our users or the public;
          </li>
          <li>
            <strong>A successor entity</strong>, in connection with a merger,
            acquisition or sale of assets. We will notify you first.
          </li>
        </ul>

        <h2>5. Data retention</h2>
        <p>
          We keep your information for as long as your account is active and as
          needed to provide the service. You can ask us to delete your data at
          any time (see below). We retain some records for a limited period
          afterwards where required for legal, security or accounting purposes,
          after which they are deleted or anonymised.
        </p>

        <h2>6. Security</h2>
        <p>
          We use reasonable technical and organisational measures (including
          encryption in transit and access controls) to protect your
          information. No method of transmission or storage is completely
          secure, so we cannot guarantee absolute security.
        </p>

        <h2>7. Your rights</h2>
        <p>
          Depending on where you live (including under the GDPR and the CCPA),
          you may have the right to access, correct, export or delete your
          personal information, to object to or restrict certain processing,
          and to withdraw consent at any time. To exercise any of these rights,
          contact us using the details on the{" "}
          <a href="/contact">Contact Us</a> page. We will respond within the
          timeframe required by applicable law.
        </p>

        <h2>8. Children</h2>
        <p>
          ECOS is not directed at children under 16, and we do not knowingly
          collect their information. If you believe a child has provided us
          with personal data, contact us and we will delete it.
        </p>

        <h2>9. International transfers</h2>
        <p>
          Your information may be processed in countries other than your own.
          Where we transfer data internationally, we use appropriate safeguards
          required by applicable data-protection law.
        </p>

        <h2>10. Changes to this policy</h2>
        <p>
          We may update this Privacy Policy from time to time. When we do, we
          will revise the date at the top of this page and, for material
          changes, notify you through WhatsApp or by email. Continued use of
          ECOS after an update means you accept the revised policy.
        </p>

        <h2>11. Contact us</h2>
        <p>
          Questions about this policy? Reach us any time on the{" "}
          <a href="/contact">Contact Us</a> page, email{" "}
          <a href="mailto:privacy@ecos.app">privacy@ecos.app</a>, or call{" "}
          <a href={`tel:${COMPANY.phone}`}>{COMPANY.phoneDisplay}</a>.
        </p>
        <p>
          {COMPANY.name}, {COMPANY.address}
        </p>
      </div>
    </StaticPage>
  );
}
