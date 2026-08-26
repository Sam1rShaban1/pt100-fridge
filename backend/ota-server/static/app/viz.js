/* Rendering: temperature color scale, IDW heat field, room chrome,
   trend chart, legend. Pure canvas, no dependencies. */

export function tempColor(t, min, max) {
  // Thermal stops in degrees C. Data encoding, not decoration.
  const stops = [
    [-25, [35, 48, 110]],
    [-12, [43, 88, 196]],
    [-4, [42, 163, 201]],
    [0, [57, 198, 183]],
    [4, [126, 217, 138]],
    [8, [226, 201, 79]],
    [13, [239, 155, 61]],
    [18, [227, 91, 52]],
    [25, [194, 40, 35]],
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      a = stops[i]; b = stops[i + 1]; break;
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
  return tempColor(t, min, max);
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Plane axes: "floor" maps sensors to (x, y); "wall" to (x, z).
export function planeOf(room, plane) {
  const d = room.dims_m;
  return plane === "wall"
    ? { U: d.length, V: d.height }
    : { U: d.length, V: d.width };
}

export function sensorUV(sensor, plane) {
  return plane === "wall"
    ? { u: sensor.x_m, v: sensor.z_m ?? sensor.y_m }
    : { u: sensor.x_m, v: sensor.y_m };
}

/* Inverse-distance weighting over a coarse grid, upscaled with smoothing.
   One active sensor naturally yields a uniform field. */
export function drawField(canvas, room, plane, readings, cfg) {
  const wrap = canvas.parentElement.clientWidth || 600;
  const { U, V } = planeOf(room, plane);
  const pad = 12;
  const scale = Math.max((wrap - pad * 2) / U, 10); // px per meter
  const W = Math.round(U * scale);
  const H = Math.round(V * scale);
  const dpr = window.devicePixelRatio || 1;

  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);

  const ctx = canvas.getContext("2d");
  const cs = cfg.color_scale || { min: -25, max: 25 };

  // Active points for interpolation.
  const pts = [];
  for (const s of room.sensors || []) {
    const r = readings[s.id];
    if (!r || r.temp == null || isNaN(r.temp)) continue;
    const { u, v } = sensorUV(s, plane);
    pts.push({ u, v, t: r.temp });
  }

  // Coarse grid -> ImageData -> smoothed upscale.
  const gw = Math.max(24, Math.round(U / 0.12));
  const gh = Math.max(14, Math.round(V / 0.12));
  const off = document.createElement("canvas");
  off.width = gw; off.height = gh;
  const octx = off.getContext("2d");
  const img = octx.createImageData(gw, gh);

  const eps = 0.05; // m^2, avoids singularity at sensor positions
  for (let j = 0; j < gh; j++) {
    const vv = ((j + 0.5) * V) / gh;
    for (let i = 0; i < gw; i++) {
      const uu = ((i + 0.5) * U) / gw;
      let num = 0, den = 0;
      if (pts.length === 1) {
        num = pts[0].t; den = 1;
      } else {
        for (const p of pts) {
          const du = p.u - uu, dv = p.v - vv;
          const w = 1 / (du * du + dv * dv + eps);
          num += w * p.t; den += w;
        }
      }
      const t = den ? num / den : cs.min;
      const col = tempColor(t, cs.min, cs.max).match(/\d+/g).map(Number);
      const o = (j * gw + i) * 4;
      img.data[o] = col[0];
      img.data[o + 1] = col[1];
      img.data[o + 2] = col[2];
      img.data[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);

  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(off, 0, 0, W, H);

  drawChrome(ctx, W, H, room, plane, scale);
  return { W, H, scale };
}

function drawChrome(ctx, W, H, room, plane, scale) {
  const { U, V } = planeOf(room, plane);

  // 1 m reference grid.
  ctx.strokeStyle = "rgba(11, 16, 21, 0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let m = 1; m < U; m++) { ctx.moveTo(m * scale, 0); ctx.lineTo(m * scale, H); }
  for (let m = 1; m < V; m++) { ctx.moveTo(0, m * scale); ctx.lineTo(W, m * scale); }
  ctx.stroke();

  // Walls.
  ctx.strokeStyle = "rgba(226, 232, 240, 0.85)";
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, W - 3, H - 3);

  // Door gap on the front wall.
  const door = room.door;
  if (door && door.x_m != null) {
    const dw = (door.width_m || 1.2) * scale;
    const dx = door.x_m * scale;
    ctx.strokeStyle = "#0b1015";
    ctx.lineWidth = 5;
    ctx.beginPath();
    if (plane === "wall") {
      ctx.moveTo(dx, H - 2); ctx.lineTo(dx + dw, H - 2);
    } else {
      ctx.moveTo(dx, H - 2); ctx.lineTo(dx + dw, H - 2);
    }
    ctx.stroke();
  }

  // Meter tick labels along the top edge.
  ctx.fillStyle = "rgba(226, 232, 240, 0.75)";
  ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
  for (let m = 1; m < U; m += 1) {
    ctx.fillText(`${m}m`, m * scale + 3, 12);
  }
}

/* Trend chart: one line per sensor, threshold bands, sparse mono axes. */
const LINE_COLORS = ["#7dd3fc", "#fcd34d", "#86efac", "#fda4af", "#a5b4fc", "#f0abfc"];

export function lineColor(i) {
  return LINE_COLORS[i % LINE_COLORS.length];
}

export function drawChart(canvas, series, room, minutes, heightCss = 190) {
  const wrap = canvas.parentElement.clientWidth || 600;
  const Hcss = heightCss;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap * dpr;
  canvas.height = Hcss * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, wrap, Hcss);

  const padL = 44, padR = 12, padT = 10, padB = 24;
  const iw = wrap - padL - padR, ih = Hcss - padT - padB;
  const now = Date.now();
  const t0 = now - minutes * 60000;

  let lo = Infinity, hi = -Infinity;
  for (const sid in series) {
    for (const [, t] of series[sid]) {
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
  }
  const th = room.thresholds || {};
  if (th.target_min != null) lo = Math.min(lo, th.target_min);
  if (th.target_max != null) hi = Math.max(hi, th.target_max);
  if (!isFinite(lo)) { lo = 0; hi = 5; }
  const padY = Math.max((hi - lo) * 0.15, 0.5);
  lo -= padY; hi += padY;

  const X = ms => padL + ((ms - t0) / (now - t0)) * iw;
  const Y = t => padT + ih - ((t - lo) / (hi - lo)) * ih;

  // Horizontal gridlines.
  ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
  ctx.fillStyle = "rgba(143, 163, 181, 0.9)";
  ctx.strokeStyle = "rgba(148, 163, 184, 0.12)";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const tv = lo + ((hi - lo) * g) / 4;
    const y = Y(tv);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(wrap - padR, y); ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(tv.toFixed(1) + "\u00B0", padL - 6, y + 3);
  }

  // Threshold lines.
  ctx.setLineDash([4, 4]);
  for (const key of ["target_min", "target_max"]) {
    if (th[key] == null) continue;
    const y = Y(th[key]);
    ctx.strokeStyle = "rgba(143, 163, 181, 0.45)";
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(wrap - padR, y); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Time ticks: about 5.
  const stepMs = (minutes * 60000) / 5;
  ctx.textAlign = "center";
  for (let i = 0; i <= 5; i++) {
    const ms = t0 + stepMs * i;
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    ctx.fillText(`${hh}:${mm}`, X(ms), Hcss - 8);
  }

  // Series lines.
  let idx = 0;
  for (const sid in series) {
    const pts = series[sid].filter(([ms]) => ms >= t0 - stepMs);
    if (pts.length < 2) { idx++; continue; }
    ctx.strokeStyle = lineColor(idx);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    pts.forEach(([ms, t], i) => {
      const x = Math.max(padL, X(ms)), y = Y(t);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    idx++;
  }
}

export function drawLegend(canvas, cfg) {
  const cs = cfg.color_scale || { min: -25, max: 25 };
  const w = 340, h = 10;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = "100%";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (let x = 0; x < w; x++) {
    const t = cs.min + ((cs.max - cs.min) * x) / (w - 1);
    ctx.fillStyle = tempColor(t, cs.min, cs.max);
    ctx.fillRect(x, 0, 1, h);
  }
}
