import type { Metadata } from "next";
import StaticPage from "@/components/StaticPage";
import CtaButton from "@/components/CtaButton";
import { APP_NAME, APP_TAGLINE, COMPANY } from "@/lib/site";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata(
  "About Us",
  `${APP_NAME} is an Electronic Chief Of Staff that lives in WhatsApp, built for people who are tired of managing their own admin.`,
  "/about",
);

export default function AboutPage() {
  return (
    <StaticPage
      eyebrow="About us"
      title="Built for people who are their own chief of staff."
      lead={`${APP_NAME}, the ${APP_TAGLINE}, exists because the busywork of running a day should not eat the day itself.`}
    >
      <div className="prose">
        <h2>Why we started</h2>
        <p>
          Most knowledge workers don&apos;t need another app. They need
          someone (or something) to catch the follow-up that slipped, move
          the meeting that clashed, and remind them about the thing they said
          they&apos;d do on Tuesday. That work is real, but it isn&apos;t the
          work only you can do.
        </p>
        <p>
          So we didn&apos;t build another dashboard. We built a chief of staff
          that lives where you already talk: WhatsApp. Open the chat, say what
          you need, and it handles the logistics.
        </p>

        <h2>What we believe</h2>
        <ul>
          <li>
            <strong>Meet people where they are.</strong> No app to install, no
            login to remember, no new habit to build.
          </li>
          <li>
            <strong>Software should take work off your plate</strong>, not add
            another queue for you to monitor.
          </li>
          <li>
            <strong>You stay in control.</strong> ECOS proposes and executes
            what you ask for; you approve the things that matter.
          </li>
          <li>
            <strong>Privacy is the default.</strong> We collect only what the
            service needs. See our <a href="/privacy">Privacy Policy</a>.
          </li>
        </ul>

        <h2>How it works</h2>
        <p>
          Message ECOS the way you would message a person. It reads the
          context, uses your connected calendar and contacts when you allow it,
          and comes back with the result: a rescheduled event, a reminder set,
          a follow-up sent. Everything happens in the conversation, and
          everything is visible in the thread.
        </p>

        <h2>Who it&apos;s for</h2>
        <p>
          Founders, consultants, operators and anyone whose calendar is
          fuller than their to-do list. If your day is mostly coordination,
          ECOS is built for you.
        </p>

        <h2>The company behind ECOS</h2>
        <p>
          ECOS is a product of {COMPANY.name}, built and operated from Lagos,
          Nigeria. We are a small team building software that gives people
          their time back.
        </p>
        <p>
          <strong>Registered address:</strong> {COMPANY.address}
          <br />
          <strong>Phone:</strong>{" "}
          <a href={`tel:${COMPANY.phone}`}>{COMPANY.phoneDisplay}</a>
        </p>

        <div className="contact-actions">
          <CtaButton>Chat with ECOS</CtaButton>
          <a className="btn btn-ghost" href="/contact">
            Contact us
          </a>
        </div>
      </div>
    </StaticPage>
  );
}
