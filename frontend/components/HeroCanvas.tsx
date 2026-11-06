"use client";

import { useEffect, useRef, useState } from "react";

/**
 * HeroCanvas renders the ECOS chat demo as an animated phone screen only:
 * the phone scrolls through the ECOS conversation with chat bubbles entering
 * with a stagger. No headings, no hero-level text — just the phone, so it can
 * sit beside the landing hero's title/lead/actions.
 */

const STYLES = `
:host,.e-demo{box-sizing:border-box}
.e-demo{color:#14181a;font-family:'DM Sans',system-ui,-apple-system,'Segoe UI',sans-serif}
.e-demo .phone{background:#101416;border-radius:42px;padding:10px;width:100%;max-width:360px;margin:0 auto;box-shadow:0 30px 70px rgba(0,0,0,.35)}
.e-demo .screen{background:#0b141a;border-radius:33px;height:640px;display:flex;flex-direction:column;overflow:hidden;color:#e9edef}
.e-demo .screen .top{background:#1f2c34;padding:14px 16px;display:flex;align-items:center;gap:12px}
.e-demo .screen .av{width:36px;height:36px;border-radius:50%;background:#0b141a;border:1.5px solid #25d366;display:grid;place-items:center;font-weight:700;font-size:12px;color:#25d366}
.e-demo .screen .top b{display:block;font-size:15px}.e-demo .screen .top span{font-size:12px;color:#8696a0}
.e-demo .screen .feed{flex:1;padding:14px 12px;display:flex;flex-direction:column;gap:8px;overflow:hidden;justify-content:flex-end;background:radial-gradient(circle at 20% 10%,#0f1c24,transparent 60%),#0b141a}
.e-demo .screen .m{max-width:84%;padding:8px 11px;border-radius:12px;font-size:14px;line-height:1.4;opacity:0;transform:translateY(8px);transition:opacity .35s,transform .35s}
.e-demo .screen .m.show{opacity:1;transform:none}
.e-demo .screen .m.out{align-self:flex-end;background:#005c4b;border-top-right-radius:3px}
.e-demo .screen .m.in{align-self:flex-start;background:#202c33;border-top-left-radius:3px}
.e-demo .screen .m small{display:block;text-align:right;font-size:10px;color:#8696a0;margin-top:3px}
.e-demo .screen .m .k{color:#8696a0;font-size:12px}
.e-demo .screen .btns{display:flex;gap:6px;margin-top:8px}
.e-demo .screen .btn{flex:1;text-align:center;padding:8px 0;border-radius:8px;background:#0b141a;color:#53bdeb;font-weight:500;font-size:13px;border:1px solid #2a3942;transition:background .2s,color .2s}
.e-demo .screen .btn.tap{background:#25d366;color:#06210f;border-color:#25d366}
.e-demo .screen .ok{color:#25d366;font-weight:700}
.e-demo .screen .brief{background:#1a262d;border-left:3px solid #25d366}
.e-demo .screen .brief div{display:flex;justify-content:space-between;gap:12px;padding:2px 0}
.e-demo .screen .dots{display:inline-flex;gap:4px;padding:4px 2px}.e-demo .screen .dots i{width:6px;height:6px;border-radius:50%;background:#8696a0;animation:b 1s infinite}
.e-demo .screen .dots i:nth-child(2){animation-delay:.15s}.e-demo .screen .dots i:nth-child(3){animation-delay:.3s}
@keyframes b{0%,60%,100%{opacity:.3}30%{opacity:1}}
.e-demo .screen .bar{background:#1f2c34;padding:12px 16px;font-size:13px;color:#8696a0}
@media (max-width:860px){.e-demo .screen{height:600px}}
@media (prefers-reduced-motion:reduce){.e-demo .screen .m{transition:none}.e-demo .screen .dots i{animation:none}}
`;


export default function HeroCanvas() {
  const feedRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("online");
  const reduce = typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, reduce ? 0 : ms));

  const add = (cls: string, html: React.ReactNode) => {
    const d = document.createElement("div");
    d.className = `m ${cls}`;
    d.innerHTML = String(html);
    feedRef.current?.appendChild(d);
    requestAnimationFrame(() => requestAnimationFrame(() => d.classList.add("show")));
    return d;
  };

  const typing = async (ms: number) => {
    setStatus("typing…");
    const d = add("in", '<span class="dots"><i></i><i></i><i></i></span>');
    await wait(ms);
    d.remove();
    setStatus("online");
  };

  useEffect(() => {
    let cancelled = false;

    (async () => {
      while (!cancelled) {
        const feed = feedRef.current;
        if (feed) feed.innerHTML = "";
        await wait(900);
        add(
          "out",
          'Book 30 mins with Tobi next Tuesday after 11.<small>9:41 ✓✓</small>'
        );
        await wait(1000);
        await typing(1400);
        const p = add(
          "in",
          `I found a slot:<br><b>Tue 10 Nov, 11:30–12:00 (WAT)</b><br><span class="k">Tobi's calendar isn't connected, so his availability is unchecked.</span><div class="btns"><div class="btn" id="ap">Approve</div><div class="btn">Change</div></div><small>9:41</small>`
        );
        await wait(2400);
        const ap = p.querySelector("#ap");
        if (ap) {
          ap.classList.add("tap");
          await wait(500);
        }
        add("out", 'Approve<small>9:42 ✓✓</small>');
        await wait(900);
        await typing(1100);
        add("in", '<span class="ok">✓ Done.</span> Added to your Google Calendar and invite sent to Tobi.<small>9:42</small>');
        await wait(2200);
        add(
          "in",
          `<b>Tomorrow's briefing · 7:30 am</b><div class="brief" style="margin-top:6px;padding:8px 10px;border-radius:8px"><div><span>Meetings</span><b>3</b></div><div><span>Clashes</span><b>1</b></div><div><span>Tasks due</span><b>2</b></div><div><span>Waiting for you</span><b>1 approval</b></div></div><small>9:43</small>`
        );
        await wait(4500);
        if (reduce) return;
        const finalFeed = feedRef.current;
        if (finalFeed) {
          finalFeed.style.transition = "opacity .5s";
          finalFeed.style.opacity = "0";
          await wait(600);
          finalFeed.style.opacity = "1";
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="e-demo">
      <style>{STYLES}</style>
      <div
        className="phone"
        aria-label="Animated example of an ECOS conversation on WhatsApp"
      >
        <div className="screen">
          <div className="top">
            <div className="av">EC</div>
            <div>
              <b>ECOS</b>
              <span id="status">{status}</span>
            </div>
          </div>
          <div ref={feedRef} className="feed" id="feed" />
          <div className="bar">Message</div>
        </div>
      </div>
    </div>
  );
}
