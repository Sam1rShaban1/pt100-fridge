/* Rendering: temperature color scale and 2D room (top-down) plan view with
   IDW heat field and sensor markers. Pure canvas, no dependencies. */

export function tempColor(t, min, max) {
  const stops = [
    [-50, [33, 38, 120]],
    [-20, [40, 90, 210]],
    [0,   [38, 175, 205]],
    [8,   [54, 210, 150]],
    [14,  [240, 190, 60]],
    [20,  [225, 70, 45]],
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
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

export function cssTempColor(t, min, max) { return tempColor(t, min, max); }

function rr(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawLegend(canvas, cfg) {
  const cs = (cfg && cfg.color_scale) || { min: -10, max: 15 };
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

// 2D top-down plan renderer (same API as previous 3D model)
export function createModel3D(canvas) {
  const ctx = canvas.getContext("2d");
  let fieldSig = null;
  let heatTex = null;
  let markers = [];
  let geom = null;

  function makeField(room, readings) {
    const pts = [];
    for (const s of (room.sensors || [])) {
      const r = readings[s.id];
      if (!r || r.temp == null || isNaN(r.temp)) continue;
      pts.push({ x: s.x_m, y: s.y_m, t: r.temp });
    }
    if (pts.length === 0) return null;
    if (pts.length === 1) { const c = pts[0]; return () => c.t; }
    const eps = 0.03;
    return (x, y) => {
      let num = 0, den = 0;
      for (const p of pts) {
        const dx = p.x - x, dy = p.y - y;
        const wgt = 1 / (dx * dx + dy * dy + eps);
        num += wgt * p.t; den += wgt;
      }
      return den ? num / den : 0;
    };
  }

  function buildHeat(room, field, cs) {
    const d = room.dims_m || { length: 8, width: 4.5 };
    const N = 160;
    const cv = document.createElement("canvas");
    cv.width = N; cv.height = N;
    const octx = cv.getContext("2d");
    const img = octx.createImageData(N, N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = (i + 0.5) / N * d.length;
        const y = (j + 0.5) / N * d.width;
        const t = field ? field(x, y) : (cs.min + cs.max) / 2;
        const m = tempColor(t, cs.min, cs.max).match(/\d+/g);
        const o = (j * N + i) * 4;
        img.data[o] = +m[0]; img.data[o + 1] = +m[1]; img.data[o + 2] = +m[2]; img.data[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return cv;
  }

  function render(room, readings, cfg, selectedId, t) {
    const dpr = window.devicePixelRatio || 1;
    const wrap = canvas.parentElement;
    const cw = wrap.clientWidth || 600;
    const chh = wrap.clientHeight || Math.round(cw * 0.55);
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(chh * dpr)) {
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(chh * dpr);
      canvas.style.width = cw + "px"; canvas.style.height = chh + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, chh);
    markers = [];
    geom = null;
    if (!room) return;

    const d = room.dims_m || { length: 8, width: 4.5, height: 2.25 };
    const L = Math.max(0.1, d.length || 8);
    const W = Math.max(0.1, d.width || 4.5);
    const cs = (cfg && cfg.color_scale) || { min: -10, max: 15 };

    const sig = room.id + "|" + (room.sensors || []).map(s => {
      const r = readings[s.id];
      return s.id + ":" + (r && r.temp != null ? Math.round(r.temp * 10) : "x");
    }).join(",");
    if (sig !== fieldSig || !heatTex) {
      fieldSig = sig;
      const field = makeField(room, readings);
      heatTex = buildHeat(room, field, cs);
    }

    // Fit room (length=x horizontal, width=y vertical) into canvas with padding
    const pad = 24;
    const scale = Math.min((cw - pad * 2) / L, (chh - pad * 2) / W);
    const rw = L * scale, rh = W * scale;
    const ox = (cw - rw) / 2, oy = (chh - rh) / 2;
    const toX = (mx) => ox + mx * scale;
    const toY = (my) => oy + my * scale;
    geom = { ox, oy, rw, rh, scale, L, W };

    // Background
    ctx.fillStyle = "#0d1219";
    rr(ctx, ox - 10, oy - 10, rw + 20, rh + 20, 12);
    ctx.fill();

    // Heat field clipped to room
    ctx.save();
    rr(ctx, ox, oy, rw, rh, 6);
    ctx.clip();
    if (heatTex) ctx.drawImage(heatTex, ox, oy, rw, rh);
    // subtle grid
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    const step = Math.max(1, Math.round(Math.min(L, W) / 4)) || 1;
    for (let x = 0; x <= L; x += step) {
      const px = toX(x); ctx.beginPath(); ctx.moveTo(px, oy); ctx.lineTo(px, oy + rh); ctx.stroke();
    }
    for (let y = 0; y <= W; y += step) {
      const py = toY(y); ctx.beginPath(); ctx.moveTo(ox, py); ctx.lineTo(ox + rw, py); ctx.stroke();
    }
    ctx.restore();

    // Room border
    ctx.strokeStyle = "rgba(226,232,240,0.7)";
    ctx.lineWidth = 2;
    rr(ctx, ox, oy, rw, rh, 6);
    ctx.stroke();

    // Door on top edge (y = 0 side) if defined, else bottom edge
    const door = room.door;
    if (door && door.x_m != null) {
      const dw = (door.width_m || 1.2) * scale;
      const dx = toX(Math.max(0, Math.min(L - (door.width_m || 1.2), door.x_m)));
      ctx.strokeStyle = "#0d1219";
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(dx, oy + rh); ctx.lineTo(dx + dw, oy + rh); ctx.stroke();
      ctx.strokeStyle = "rgba(45,212,191,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(dx, oy + rh); ctx.lineTo(dx + dw, oy + rh); ctx.stroke();
    }



    // Sensors
    (room.sensors || []).forEach(s => {
      const px = toX(Math.max(0, Math.min(L, s.x_m ?? L / 2)));
      const py = toY(Math.max(0, Math.min(W, s.y_m ?? W / 2)));
      const r = readings[s.id];
      const stale = !r || r.time == null || (Date.now() - r.time) > ((cfg.stale_after_s || 15) * 1000);
      const col = stale ? "#8fa3b5" : tempColor(r.temp, cs.min, cs.max);
      const pulse = 1 + 0.12 * Math.sin(t * 2.2 + (s.x_m + s.y_m));
      const rad = 7 * pulse;

      // glow
      const g = ctx.createRadialGradient(px, py, 1, px, py, rad * 3);
      g.addColorStop(0, col); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, rad * 3, 0, Math.PI * 2); ctx.fill();

      // dot
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(px, py, rad * 0.7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(10,17,26,0.9)"; ctx.lineWidth = 2; ctx.stroke();

      if (selectedId === s.id) {
        ctx.strokeStyle = "#5eead4"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(px, py, rad + 6, 0, Math.PI * 2); ctx.stroke();
      }

      const val = (stale || r.temp == null) ? "--.-°" : r.temp.toFixed(1) + "°C";
      const label = s.label || s.id;
      ctx.font = "600 12px ui-monospace, Menlo, Consolas, monospace";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      const nameW = ctx.measureText(label).width;
      const valW = ctx.measureText(val).width;
      const padX = 7, gap = 6, bh = 22;
      const bw = padX * 2 + nameW + gap + valW;
      let bx = px + rad + 10, by = py - bh / 2;
      if (bx + bw > cw - 8) bx = px - rad - 10 - bw;
      if (by < 6) by = 6; if (by + bh > chh - 6) by = chh - 6 - bh;
      rr(ctx, bx, by, bw, bh, 6);
      ctx.fillStyle = "rgba(10,17,26,0.88)"; ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "rgba(231,237,245,0.95)";
      ctx.fillText(label, bx + padX, by + bh / 2 + 0.5);
      ctx.fillStyle = col;
      ctx.fillText(val, bx + padX + nameW + gap, by + bh / 2 + 0.5);
      ctx.textBaseline = "alphabetic";

      markers.push({ id: s.id, x: px, y: py, r: rad + 10 });
    });

    if (!(room.sensors || []).length) {
      ctx.fillStyle = "rgba(148,163,184,0.8)";
      ctx.font = "14px system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("No sensors assigned — use Manage to add sensors", cw / 2, chh / 2);
    }
  }

  function pick(x, y) {
    let best = null, bestD = Infinity;
    for (const m of markers) {
      const dx = x - m.x, dy = y - m.y;
      const dist = dx * dx + dy * dy;
      if (dist < m.r * m.r && dist < bestD) { best = m.id; bestD = dist; }
    }
    return best;
  }

  return { render, pick };
}
