"use client";

import CtaButton from "./CtaButton";
import { APP_NAME, APP_TAGLINE } from "@/lib/site";

export default function Nav() {
  return (
    <header className="nav">
      <div className="container nav-inner">
        <a className="brand" href="#top">
          {APP_NAME}
          <small>{APP_TAGLINE}</small>
        </a>

        <nav className="nav-links">
          <a href="#capabilities">Capabilities</a>
          <a href="#how">How it works</a>
          <CtaButton size="sm">Start on WhatsApp</CtaButton>
        </nav>
      </div>
    </header>
  );
}
