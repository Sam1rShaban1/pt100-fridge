import { useMemo } from "react";

export default function AlarmBanner({ room, latest, isStale }) {
  const { cls, text } = useMemo(() => {
    if (!room) return { cls: "", text: "" };
    const th = room.thresholds || {};
    const sensors = room.sensors || [];
    let faultLabel = null;
    let worst = null;
    let worstTemp = null;
    let offline = 0;
    sensors.forEach((s) => {
      const r = latest[s.id];
      if (!r) {
        offline++;
        return;
      }
      if (r.fault) {
        faultLabel = faultLabel || s.label;
        return;
      }
      if (r.temp != null) {
        if (r.temp > th.alarm_max && (!worstTemp || r.temp > worstTemp)) {
          worst = "alarm";
          worstTemp = r.temp;
        } else if (r.temp > th.warn_max && worst !== "alarm") {
          worst = "warn";
        }
      }
    });
    if (faultLabel) return { cls: "alarm", text: `Sensor fault detected — ${faultLabel}` };
    if (worst === "alarm")
      return { cls: "alarm", text: `ALARM: ${worstTemp.toFixed(1)}°C exceeds ${th.alarm_max.toFixed(1)}°C` };
    if (worst === "warn")
      return { cls: "warn", text: `Warning: temperature above ${th.warn_max.toFixed(1)}°C` };
    if (offline > 0 && offline === sensors.length)
      return { cls: "", text: "Waiting for sensor data…" };
    return { cls: "", text: "All sensors within target range" };
  }, [room, latest, isStale]);

  const tone =
    cls === "alarm"
      ? "border-alarm/50 bg-alarm/10 text-[#fecaca]"
      : cls === "warn"
      ? "border-warn/50 bg-warn/10 text-[#fde68a]"
      : "border-cold/40 bg-cold/10 text-[#bbf7d0]";

  return (
    <div
      className={`rounded-xl border px-4 py-2.5 text-[13px] font-medium ${tone}`}
      role="status"
    >
      {text}
    </div>
  );
}
