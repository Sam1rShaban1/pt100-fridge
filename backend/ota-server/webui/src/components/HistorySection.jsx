import { useEffect, useRef } from "react";
import { useGSAP } from "@gsap/react";
import { gsap } from "../lib/gsapSetup.js";
import SensorChart from "./SensorChart.jsx";
import { cssTempColor } from "../lib/colors.js";

const LINE = ["#38bdf8", "#22d3ee", "#a78bfa", "#34d399", "#f472b6", "#fbbf24"];
const RANGES = [
  { m: 60, label: "1h" },
  { m: 360, label: "6h" },
  { m: 1440, label: "24h" },
];

function SegButton({ active, label, onClick, innerRef }) {
  return (
    <button
      ref={innerRef}
      onClick={onClick}
      className={`rounded-lg px-4 py-1.5 text-[13px] font-medium transition-colors ${
        active ? "bg-cold/20 text-text ring-1 ring-cold/50" : "text-mut hover:text-text"
      }`}
    >
      {label}
    </button>
  );
}

export default function HistorySection({
  room,
  history,
  latest,
  colorScale,
  rangeMin,
  setRangeMin,
  selectedSensor,
  onSelectSensor,
}) {
  const ref = useRef(null);
  const segRefs = useRef([]);

  useEffect(() => {
    const cleanups = [];
    segRefs.current.forEach((el) => {
      if (!el) return;
      const xTo = gsap.quickTo(el, "x", { duration: 0.4, ease: "power3" });
      const yTo = gsap.quickTo(el, "y", { duration: 0.4, ease: "power3" });
      const move = (e) => {
        const r = el.getBoundingClientRect();
        xTo((e.clientX - (r.left + r.width / 2)) * 0.25);
        yTo((e.clientY - (r.top + r.height / 2)) * 0.25);
      };
      const leave = () => {
        xTo(0);
        yTo(0);
      };
      el.addEventListener("mousemove", move);
      el.addEventListener("mouseleave", leave);
      cleanups.push(() => {
        el.removeEventListener("mousemove", move);
        el.removeEventListener("mouseleave", leave);
      });
    });
    return () => cleanups.forEach((c) => c());
  }, [rangeMin]);

  useGSAP(
    () => {
      gsap.from(".chart-card", {
        y: 40,
        opacity: 0,
        duration: 0.7,
        ease: "power3.out",
        stagger: 0.08,
        scrollTrigger: { trigger: ref.current, start: "top 80%" },
      });
    },
    { scope: ref }
  );

  const sensors = room?.sensors || [];
  const th = room?.thresholds;

  return (
    <section ref={ref} className="px-5 py-16 md:px-10">
      <div className="mx-auto max-w-shell">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-[28px] font-black tracking-tight md:text-[34px]">Temperature history</h2>
            <p className="mt-1 text-[13px] text-mut">
              Drag across a chart to zoom the time window. Double-click the zoom control to reset.
            </p>
          </div>
          <div className="glass flex items-center gap-1 rounded-xl p-1">
            {RANGES.map((r, i) => (
              <SegButton
                key={r.m}
                innerRef={(el) => (segRefs.current[i] = el)}
                active={rangeMin === r.m}
                label={r.label}
                onClick={() => setRangeMin(r.m)}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {sensors.map((s, idx) => {
            const r = latest[s.id];
            const stale = !r || r.time == null;
            const col = LINE[idx % LINE.length];
            const temp = stale ? "--.-" : (r?.temp ?? 0).toFixed(1) + "°";
            return (
              <div
                key={s.id}
                className={`chart-card cursor-pointer rounded-2xl border bg-panel/70 p-4 transition-colors ${
                  selectedSensor === s.id ? "border-cold/60" : "border-line hover:border-linestrong"
                }`}
                onClick={() => onSelectSensor(s.id)}
              >
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="text-[14px] font-semibold text-text">{s.label}</span>
                  <span className="num text-[18px]" style={{ color: stale ? "#8aa0b4" : cssTempColor(r?.temp, colorScale.min, colorScale.max) }}>
                    {temp}
                  </span>
                </div>
                <SensorChart
                  sensor={{ id: s.id, label: s.label, color: col }}
                  data={history[s.id] || []}
                  thresholds={th}
                />
              </div>
            );
          })}
          {sensors.length === 0 && (
            <div className="col-span-full rounded-2xl border border-line p-10 text-center text-mut">
              No sensors assigned to this room.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
