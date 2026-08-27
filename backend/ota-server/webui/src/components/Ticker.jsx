import { useMemo } from "react";

export default function Ticker({ rooms, latest }) {
  const items = useMemo(() => {
    const out = [];
    rooms.forEach((r) =>
      (r.sensors || []).forEach((s) => {
        const d = latest[s.id];
        const stale = !d || d.time == null;
        out.push({ room: r.name, label: s.label, temp: stale ? "--.-" : d.temp.toFixed(1) + "°" });
      })
    );
    return out;
  }, [rooms, latest]);

  const row = items.length ? items : [{ room: "—", label: "awaiting data", temp: "--.-" }];
  const loop = [...row, ...row];

  return (
    <div className="overflow-hidden border-y border-line bg-panel/40 py-2">
      <div className="ticker-track flex gap-8 whitespace-nowrap px-4">
        {loop.map((it, i) => (
          <span key={i} className="num text-[12px] text-mut">
            <span className="text-text/80">{it.room}</span> · {it.label}:{" "}
            <span className="text-text">{it.temp}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
