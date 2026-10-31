"use client";

import Link from "next/link";
import { useState } from "react";
import CtaButton from "./CtaButton";
import ThemeToggle from "./ThemeToggle";
import { APP_NAME, APP_TAGLINE } from "@/lib/site";

export default function Nav() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <header className={`nav${open ? " nav-open" : ""}`}>
      <div className="container nav-inner">
        <Link className="brand" href="/#top" onClick={close}>
          {APP_NAME}
          <small>{APP_TAGLINE}</small>
        </Link>

        <nav
          id="site-menu"
          className={`nav-links${open ? " is-open" : ""}`}
          aria-label="Main"
        >
          <Link href="/#capabilities" onClick={close}>
            Capabilities
          </Link>
          <Link href="/#how" onClick={close}>
            How it works
          </Link>
          <CtaButton size="sm" onClick={close}>
            Start on WhatsApp
          </CtaButton>
        </nav>

        <div className="nav-actions">
          <ThemeToggle />

          <button
            type="button"
            className="menu-toggle"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="site-menu"
            onClick={() => setOpen((v) => !v)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </div>
    </header>
  );
}
