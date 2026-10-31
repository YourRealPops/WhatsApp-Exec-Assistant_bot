import Link from "next/link";
import { APP_NAME, APP_TAGLINE, COMPANY } from "@/lib/site";

const LEGAL_LINKS = [
  { href: "/about", label: "About Us" },
  { href: "/contact", label: "Contact Us" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
];

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <span className="footer-owner">
          <span>
            © {new Date().getFullYear()} {APP_NAME} — {APP_TAGLINE}
          </span>
          <small>
            A product of {COMPANY.name} · {COMPANY.address}
          </small>
        </span>

        <nav className="footer-links" aria-label="Footer">
          {LEGAL_LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>

        <span>Built to be messaged, not logged into.</span>
      </div>
    </footer>
  );
}
