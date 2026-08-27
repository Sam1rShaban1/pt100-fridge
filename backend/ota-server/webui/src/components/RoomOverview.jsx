import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import { gsap, SplitText } from "../lib/gsapSetup.js";
import FridgeModel from "./FridgeModel.jsx";
import AlarmBanner from "./AlarmBanner.jsx";
import ScrambleValue from "./ScrambleValue.jsx";
import { scaleGradient } from "../lib/colors.js";

function dims(room) {
  const d = room?.dims_m;
  if (!d) return "";
  return `${d.length} × ${d.width} × ${d.height} m`;
}

function roomStatus(room, latest) {
  if (!room) return { label: "", cls: "text-mut" };
  const th = room.thresholds || {};
  let fault = false;
  let alarm = false;
  let warn = false;
  (room.sensors || []).forEach((s) => {
    const r = latest[s.id];
    if (!r) return;
    if (r.fault) fault = true;
    else if (r.temp != null) {
      if (r.temp > th.alarm_max) alarm = true;
      else if (r.temp > th.warn_max) warn = true;
    }
  });
  if (fault) return { label: "Fault", cls: "text-alarm" };
  if (alarm) return { label: "Alarm", cls: "text-alarm" };
  if (warn) return { label: "Warning", cls: "text-warn" };
  return { label: "Nominal", cls: "text-cold" };
}

function Legend({ colorScale }) {
  return (
    <div className="flex items-center gap-3">
      <span className="num text-[11px] text-mut">{colorScale.min}°</span>
      <div
        className="h-2.5 flex-1 rounded-full"
        style={{ background: scaleGradient(colorScale.min, colorScale.max), minWidth: 120 }}
      />
      <span className="num text-[11px] text-mut">{colorScale.max}°</span>
    </div>
  );
}

export default function RoomOverview({ room, latest, colorScale, selectedSensor, onSelectSensor }) {
  const ref = useRef(null);
  const titleRef = useRef(null);

  useGSAP(
    () => {
      if (!titleRef.current) return;
      const split = new SplitText(titleRef.current, { type: "chars" });
      gsap.from(split.chars, {
        opacity: 0.12,
        y: 22,
        stagger: 0.025,
        duration: 0.6,
        ease: "power3.out",
      });
      return () => split.revert();
    },
    { scope: ref }
  );

  const st = roomStatus(room, latest);

  return (
    <section ref={ref} className="px-5 pt-24 md:px-10">
      <div className="mx-auto max-w-shell">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 ref={titleRef} className="text-[40px] font-black leading-[1.02] tracking-tight md:text-[56px]">
              {room?.name || "Cold Room"}
            </h1>
            <p className="mt-1 num text-[13px] text-mut">{dims(room)}</p>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-[12px] text-mut">Primary probe</span>
              <ScrambleValue
                value={
                  (() => {
                    const s0 = room?.sensors?.[0];
                    const r = s0 && latest[s0.id];
                    return r && r.time != null ? r.temp.toFixed(1) + "°" : "--.-";
                  })()
                }
                className="num text-[20px] text-text"
              />
            </div>
          </div>
          <div
            className={`rounded-full border border-line bg-panel/60 px-4 py-1.5 text-[13px] font-semibold ${st.cls}`}
          >
            {st.label}
          </div>
        </div>

        <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_320px]">
          <div className="relative h-[58vh] min-h-[420px] overflow-hidden rounded-2xl border border-line bg-panel/50">
            <FridgeModel
              room={room}
              latest={latest}
              colorScale={colorScale}
              selectedSensor={selectedSensor}
              onSelect={onSelectSensor}
            />
            <div className="pointer-events-none absolute bottom-4 left-4 right-4">
              <Legend colorScale={colorScale} />
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <AlarmBanner room={room} latest={latest} isStale={() => false} />
            <div className="rounded-2xl border border-line bg-panel/60 p-4">
              <div className="mb-3 text-[10px] uppercase tracking-[0.22em] text-mut">Target band</div>
              <div className="flex items-center justify-between text-[14px]">
                <span className="text-mut">Range</span>
                <span className="num">
                  {room?.thresholds?.target_min?.toFixed(1)}–{room?.thresholds?.target_max?.toFixed(1)}°C
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-[14px]">
                <span className="text-mut">Warn</span>
                <span className="num text-warn">{room?.thresholds?.warn_max?.toFixed(1)}°C</span>
              </div>
              <div className="mt-2 flex items-center justify-between text-[14px]">
                <span className="text-mut">Alarm</span>
                <span className="num text-alarm">{room?.thresholds?.alarm_max?.toFixed(1)}°C</span>
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-panel/60 p-4 text-[12px] leading-relaxed text-mut">
              Volumetric model interpolates sensor readings across every face of the room. Drag to orbit and
              read the live wind-field flowing through the volume.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
