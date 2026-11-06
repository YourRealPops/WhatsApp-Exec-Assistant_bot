import HeroCanvas from "@/components/HeroCanvas";

/**
 * Dedicated chat demo page.
 *
 * The standalone form of `HeroCanvas` — the animated phone screen showing
 * the ECOS conversation. It is arranged on its own, centered, so the demo
 * stands on its own away from the landing hero.
 */
export default function DemoPage() {
  return (
    <main
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        padding: "40px 24px",
      }}
    >
      <HeroCanvas />
    </main>
  );
}
