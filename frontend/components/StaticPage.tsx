import Nav from "./Nav";
import Footer from "./Footer";

type Props = {
  eyebrow: string;
  title: string;
  lead: string;
  children: React.ReactNode;
};

/**
 * Shared chrome for the standalone pages linked from the footer:
 * sticky nav, a page header and the footer.
 */
export default function StaticPage({ eyebrow, title, lead, children }: Props) {
  return (
    <>
      <Nav />
      <main className="page">
        <section className="page-head">
          <div className="container">
            <span className="eyebrow">{eyebrow}</span>
            <h1>{title}</h1>
            <p className="lead">{lead}</p>
          </div>
        </section>

        <section className="page-body">
          <div className="container">{children}</div>
        </section>
      </main>
      <Footer />
    </>
  );
}
