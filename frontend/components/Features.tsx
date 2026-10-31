"use client";

import Reveal from "./Reveal";

const CAPABILITIES = [
  {
    title: "Calendar on command",
    body: "“Move my 3pm with Ada to Thursday morning.” ECOS reads your calendar, checks what's free and books it. No app-switching, no back-and-forth.",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="5" width="18" height="16" rx="2.5" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </svg>
    ),
  },
  {
    title: "Reminders that actually land",
    body: "Say it once in chat and ECOS holds the thread, pinging you at the right moment, in your timezone, until it's done.",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
        <path d="M10.5 20a2 2 0 0 0 3 0" />
      </svg>
    ),
  },
  {
    title: "Follow-ups on autopilot",
    body: "Commitments made in passing rarely survive the week. ECOS tracks what you promised and nudges you before it slips.",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M20 11.5a8 8 0 1 1-3.2-6.4" />
        <path d="M21 4v5h-5" />
      </svg>
    ),
  },
  {
    title: "It runs where you already are",
    body: "The interface is the messenger you open forty times a day. Nothing to learn, nothing to adopt, no new inbox to feed.",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.7-.8L3 21l1.9-5a8.3 8.3 0 0 1-.9-3.8A8.4 8.4 0 0 1 12.4 3 8.4 8.4 0 0 1 21 11.5Z" />
      </svg>
    ),
  },
];

export default function Features() {
  return (
    <section className="section" id="capabilities">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">Capabilities</span>
          <h2>The operational layer behind your day.</h2>
          <p>
            ECOS takes the coordination work (the scheduling, the chasing, the
            remembering) off your plate and quietly keeps it moving.
          </p>
        </Reveal>

        <div className="grid-3">
          {CAPABILITIES.map((item, i) => (
            <Reveal key={item.title} delay={i * 0.07}>
              <article className="card">
                <div className="icon">{item.icon}</div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
