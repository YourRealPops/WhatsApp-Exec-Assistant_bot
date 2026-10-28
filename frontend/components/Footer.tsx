import { APP_NAME, APP_TAGLINE } from "@/lib/site";

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <span>
          © {new Date().getFullYear()} {APP_NAME} — {APP_TAGLINE}
        </span>
        <span>Built to be messaged, not logged into.</span>
      </div>
    </footer>
  );
}
