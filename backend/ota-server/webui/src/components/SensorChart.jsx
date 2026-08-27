import { useEffect, useRef } from "react";
import * as echarts from "echarts";

function baseOption(sensor) {
  return {
    backgroundColor: "transparent",
    animation: false,
    grid: { left: 48, right: 14, top: 16, bottom: 28 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#0b0e14",
      borderColor: "rgba(148,163,184,0.3)",
      borderWidth: 1,
      padding: [6, 9],
      textStyle: { color: "#e6edf5", fontFamily: "ui-monospace, monospace", fontSize: 12 },
      formatter: (ps) => {
        const p = ps[0];
        if (p.value[1] == null) return "";
        const d = new Date(p.value[0]);
        const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        return `<b style="color:${sensor.color}">${Number(p.value[1]).toFixed(1)}°C</b><br/><span style="color:#8aa0b4">${time}</span>`;
      },
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: "rgba(148,163,184,0.3)" } },
      axisLabel: {
        color: "#8aa0b4",
        fontSize: 10,
        formatter: (v) => new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: { color: "#8aa0b4", fontSize: 10, formatter: (v) => `${v.toFixed(0)}°` },
      splitLine: { lineStyle: { color: "rgba(148,163,184,0.10)" } },
    },
    dataZoom: [
      { type: "inside", zoomOnMouseWheel: true, moveOnMouseMove: false, throttle: 40 },
    ],
    toolbox: {
      right: 6,
      top: 0,
      iconStyle: { borderColor: "#8aa0b4" },
      emphasis: { iconStyle: { borderColor: "#7dd3fc" } },
      feature: {
        dataZoom: {
          yAxisIndex: "none",
          title: { zoom: "Drag to zoom", back: "Reset" },
          brushStyle: { borderColor: "#7dd3fc", color: "rgba(125,211,252,0.12)" },
        },
      },
    },
    series: [
      {
        name: sensor.label,
        type: "line",
        showSymbol: false,
        smooth: 0.18,
        lineStyle: { color: sensor.color, width: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: sensor.color + "4d" },
            { offset: 1, color: sensor.color + "00" },
          ]),
        },
        data: [],
      },
    ],
  };
}

export default function SensorChart({ sensor, data, thresholds }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    const c = echarts.init(ref.current);
    chartRef.current = c;
    c.setOption(baseOption(sensor));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    const marks = [];
    if (thresholds) {
      const push = (val, name, color) =>
        marks.push({ name, yAxis: val, lineStyle: { type: "dashed", color, width: 1 }, label: { color, fontSize: 9, formatter: () => name } });
      if (thresholds.target_min != null) push(thresholds.target_min, "min", "rgba(34,211,238,0.8)");
      if (thresholds.target_max != null) push(thresholds.target_max, "max", "rgba(34,211,238,0.8)");
      if (thresholds.warn_max != null) push(thresholds.warn_max, "warn", "rgba(251,191,36,0.8)");
      if (thresholds.alarm_max != null) push(thresholds.alarm_max, "alarm", "rgba(248,113,113,0.85)");
    }
    c.setOption({
      series: [
        {
          data: data || [],
          markLine: marks.length
            ? {
                symbol: "none",
                data: marks,
              }
            : { symbol: "none", data: [] },
        },
      ],
    });
  }, [data, thresholds]);

  return <div ref={ref} style={{ width: "100%", height: 300 }} />;
}
