import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import { gsap } from "../lib/gsapSetup.js";
import { cssTempColor } from "../lib/colors.js";

function statusOf(room, latest) {
  const th = room.thresholds || {};
  let worst = "ok";
  (room.sensors || []).forEach((s) => {
    const r = latest[s.id];
    if (!r) return;
    if (r.fault) worst = "fault";
    else if (r.temp != null) {
      if (r.temp > th.alarm_max) worst = "alarm";
      else if (r.temp > th.warn_max && worst === "ok") worst = "warn";
    }
  });
  return worst;
}

const TONE = {
  ok: { ring: "ring-cold/40", dot: "bg-cold", text: "text-cold", label: "Nominal" },
  warn: { ring: "ring-warn/40", dot: "bg-warn", text: "text-warn", label: "Warning" },
  alarm: { ring: "ring-alarm/50", dot: "bg-alarm", text: "text-alarm", label: "Alarm" },
  fault: { ring: "ring-alarm/50", dot: "bg-alarm", text: "text-alarm", label: "Fault" },
};

export default function BentoStatus({ rooms, latest, selectedRoom, onSelectRoom }) {
  const ref = useRef(null);

  useGSAP(
    () => {
      gsap.from(".bento-card", {
        y: 36,
        opacity: 0,
        duration: 0.6,
        ease: "power3.out",
        stagger: 0.06,
        scrollTrigger: { trigger: ref.current, start: "top 85%" },
      });
    },
    { scope: ref }
  );

  return (
    <section ref={ref} className="px-5 py-10 md:px-10">
      <div className="mx-auto max-w-shell">
        <h2 className="mb-5 text-[22px] font-black tracking-tight">Fleet overview</h2>
        <div className="grid auto-rows-fr grid-cols-2 gap-4 [grid-auto-flow:dense] md:grid-cols-3 lg:grid-cols-4">
          {rooms.map((room) => {
            const st = statusOf(room, latest);
            const tone = TONE[st];
            return (
              <button
                key={room.id}
                onClick={() => onSelectRoom(room.id)}
                className={`bento-card group flex flex-col rounded-2xl border border-line bg-panel/60 p-4 text-left transition-colors hover:border-linestrong ${
                  selectedRoom === room.id ? "ring-1 " + tone.ring : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-semibold text-text">{room.name}</span>
                  <span className={`flex items-center gap-1.5 text-[11px] ${tone.text}`}>
                    <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
                    {tone.label}
                  </span>
                </div>
                <div className="mt-3 flex flex-col gap-1.5">
                  {(room.sensors || []).map((s) => {
                    const r = latest[s.id];
                    const stale = !r || r.time == null;
                    const col = stale ? "#8aa0b4" : cssTempColor(r?.temp, -10, 15);
                    return (
                      <div key={s.id} className="flex items-center justify-between text-[12px]">
                        <span className="text-mut">{s.label}</span>
                        <span className="num" style={{ color: col }}>
                          {stale ? "--.-" : (r?.temp ?? 0).toFixed(1) + "°"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
