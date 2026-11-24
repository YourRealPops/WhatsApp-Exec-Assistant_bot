"use client";

import { motion, useReducedMotion } from "framer-motion";
import CtaButton from "./CtaButton";
import HeroCanvas from "./HeroCanvas";

const rise = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0 },
};

export default function Hero() {
  const reduce = useReducedMotion();

  const container = {
    hidden: {},
    show: { transition: { staggerChildren: reduce ? 0 : 0.11 } },
  } as const;

  return (
    <section className="hero" id="top">
      <div className="hero-bg">
        <div className="hero-glow" />
        <div className="hero-glow two" />
      </div>

      <div className="container hero-grid">
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
        >
          <motion.span
            className="eyebrow"
            variants={rise}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          >
            Electronic Executive Assistant
          </motion.span>

          <motion.h1
            variants={rise}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          >
            Run your day. <span className="gradient-text">Delegate</span> the rest.
          </motion.h1>

          <motion.p
            className="lead"
            variants={rise}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          >
            eEA lives inside WhatsApp. Tell it what needs to happen. It handles it, follows through, and keeps you in the loop, so you can stay on the work only you can do.
          </motion.p>

          <motion.div
            className="hero-actions"
            variants={rise}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          >
            <CtaButton>Chat with eEA</CtaButton>
            <a className="btn btn-ghost" href="#capabilities">
              See what it handles
            </a>
          </motion.div>

          <motion.p
            className="hero-note"
            variants={rise}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          >
            No app to install. Opens straight in WhatsApp.
          </motion.p>
        </motion.div>

        <HeroCanvas />
      </div>
    </section>
  );
}
