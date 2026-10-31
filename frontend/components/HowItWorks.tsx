"use client";

import Reveal from "./Reveal";

const STEPS = [
  {
    title: "Save the number",
    body: "One message opens the channel. ECOS greets you and picks up context from there.",
  },
  {
    title: "Say what you need",
    body: "Plain language, the way you'd brief a person. Times, people, deadlines: no forms, no syntax.",
  },
  {
    title: "It executes and reports back",
    body: "Events land on your calendar, reminders are set, loose ends get chased. You get a confirmation, not a chore.",
  },
];

export default function HowItWorks() {
  return (
    <section className="section" id="how">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">How it works</span>
          <h2>Three messages and your day is under control.</h2>
        </Reveal>

        <div className="steps">
          {STEPS.map((step, i) => (
            <Reveal key={step.title} delay={i * 0.09}>
              <div className="step">
                <div className="num">{`0${i + 1}`}</div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
