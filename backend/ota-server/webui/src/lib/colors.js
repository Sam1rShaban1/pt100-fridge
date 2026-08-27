// Temperature -> color on a chiller-focused scale (-10..15 C).
const STOPS = [
  [-10, [26, 42, 92]], // deep navy (well below freezing)
  [-5, [43, 87, 196]], // blue
  [0, [42, 163, 201]], // cyan (setpoint low)
  [5, [56, 217, 150]], // green (setpoint high)
  [15, [227, 91, 52]], // red (alarm / warm)
];

export function tempColor(t, min, max) {
  let a = STOPS[0];
  let b = STOPS[STOPS.length - 1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (t >= STOPS[i][0] && t <= STOPS[i + 1][0]) {
      a = STOPS[i];
      b = STOPS[i + 1];
      break;
    }
  }
  const span = b[0] - a[0] || 1;
  const k = Math.max(0, Math.min(1, (t - a[0]) / span));
  const rgb = [
    Math.round(a[1][0] + k * (b[1][0] - a[1][0])),
    Math.round(a[1][1] + k * (b[1][1] - a[1][1])),
    Math.round(a[1][2] + k * (b[1][2] - a[1][2])),
  ];
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

export function cssTempColor(t, min, max) {
  if (t == null || isNaN(t)) return "#8aa0b4";
  return tempColor(t, min, max);
}

// CSS gradient string for the legend bar.
export function scaleGradient(min, max) {
  const stops = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = min + ((max - min) * i) / n;
    stops.push(`${tempColor(t, min, max)} ${Math.round((i / n) * 100)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}
