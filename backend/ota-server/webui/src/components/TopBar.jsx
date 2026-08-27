import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import { gsap } from "../lib/gsapSetup.js";

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="num text-mut text-[12px]">
      {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}

export default function TopBar({ connected, brand = "Veze Sharri" }) {
  const ref = useRef(null);

  useGSAP(
    () => {
      gsap.from(ref.current, { y: -28, opacity: 0, duration: 0.9, ease: "power3.out" });
    },
    { scope: ref }
  );

  return (
    <header className="fixed top-3 left-1/2 -translate-x-1/2 z-50 w-[min(96vw,1180px)]">
      <div
        ref={ref}
        className="glass flex items-center justify-between rounded-2xl px-5 py-2.5 shadow-[0_10px_40px_rgba(0,0,0,0.45)]"
      >
        <div className="flex items-center gap-3">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-frost to-cold shadow-[0_0_18px_rgba(56,189,248,0.5)]" />
          <div className="leading-tight">
            <div className="text-[15px] font-black tracking-tight">{brand}</div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-mut">Cold-Chain Monitor</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Clock />
          <div className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-cold" : "bg-alarm"}`}
              style={{ boxShadow: connected ? "0 0 10px #22d3ee" : "0 0 10px #f87171" }}
            />
            <span className="text-[12px] text-mut">{connected ? "Live" : "Offline"}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
