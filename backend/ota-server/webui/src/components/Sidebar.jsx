import { useRef } from "react";
import { gsap } from "../lib/gsapSetup.js";
import { cssTempColor } from "../lib/colors.js";

function SensorRow({ s, latest, isStale, selected, onSelect }) {
  const ref = useRef(null);
  const xTo = useRef(null);
  const yTo = useRef(null);

  const ensure = () => {
    if (!xTo.current) {
      xTo.current = gsap.quickTo(ref.current, "x", { duration: 0.4, ease: "power3" });
      yTo.current = gsap.quickTo(ref.current, "y", { duration: 0.4, ease: "power3" });
    }
  };
  const onMove = (e) => {
    ensure();
    const r = ref.current.getBoundingClientRect();
    xTo.current((e.clientX - (r.left + r.width / 2)) * 0.25);
    yTo.current((e.clientY - (r.top + r.height / 2)) * 0.25);
  };
  const onLeave = () => {
    ensure();
    xTo.current(0);
    yTo.current(0);
  };

  const r = latest[s.id];
  const stale = isStale(s.id);
  const col = stale ? "#8aa0b4" : cssTempColor(r?.temp, -10, 15);
  return (
    <button
      ref={ref}
      onClick={() => onSelect(s.id)}
      className={`group flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors ${
        selected ? "bg-cold/10 ring-1 ring-cold/40" : "hover:bg-white/5"
      }`}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: col, boxShadow: `0 0 8px ${col}` }} />
      <span className="flex-1 text-[13px] text-text/90">{s.label}</span>
      <span className="num text-[12px] text-mut">
        {stale ? "--.-" : (r?.temp ?? 0).toFixed(1)}°
      </span>
    </button>
  );
}

export default function Sidebar({ rooms, selectedRoom, selectedSensor, latest, isStale, onSelectRoom, onSelectSensor }) {
  const ref = useRef(null);

  return (
    <aside className="flex h-full flex-col gap-2 p-4">
      <div className="px-1 pb-1 text-[10px] uppercase tracking-[0.24em] text-mut">Cold Rooms</div>
      <div ref={ref} className="flex flex-col gap-1.5">
        {rooms.map((room) => {
          const open = selectedRoom === room.id;
          return (
            <div key={room.id} className="rounded-2xl border border-line bg-panel/60">
              <button
                onClick={() => onSelectRoom(room.id)}
                className={`flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-left transition-colors ${
                  open ? "bg-white/5" : "hover:bg-white/5"
                }`}
              >
                <span
                  className={`text-[10px] text-mut transition-transform ${open ? "rotate-90" : ""}`}
                >
                  ▸
                </span>
                <span className={`text-[14px] ${open ? "text-text" : "text-text/85"}`}>{room.name}</span>
              </button>
              {open && (
                <div className="flex flex-col gap-0.5 px-2 pb-2 pt-1">
                  {(room.sensors || []).map((s) => (
                    <SensorRow
                      key={s.id}
                      s={s}
                      latest={latest}
                      isStale={isStale}
                      selected={selectedSensor === s.id}
                      onSelect={onSelectSensor}
                    />
                  ))}
                  {(room.sensors || []).length === 0 && (
                    <div className="px-3 py-2 text-[12px] text-mut">No sensors assigned</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
