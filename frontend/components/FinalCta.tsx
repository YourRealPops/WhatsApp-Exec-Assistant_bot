"use client";

import CtaButton from "./CtaButton";
import Reveal from "./Reveal";

export default function FinalCta() {
  return (
    <section className="section">
      <div className="container">
        <Reveal>
          <div className="cta-band">
            <span className="eyebrow">Get started</span>
            <h2>
              Delegate your first task {" "}
              <span className="gradient-text">in one message.</span>
            </h2>
            <p>
              Open WhatsApp, say hello, and hand over the first thing on your
              plate. That's the whole setup.
            </p>
            <CtaButton>Start the conversation</CtaButton>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
