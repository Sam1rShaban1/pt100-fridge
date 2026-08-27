/* Rendering: temperature color scale, isometric 3D cold-room model with a
   volumetric IDW heat field across all visible faces and a flowing-air
   particle animation. Pure canvas, no dependencies. */

export function tempColor(t, min, max) {
  // Cold-to-warm scale spanning -50..20C, smooth interpolation between anchors.
  const stops = [
    [-50, [33, 38, 120]],   // deep indigo (extreme cold)
    [-20, [40, 90, 210]],   // blue
    [0,   [38, 175, 205]],  // cyan
    [8,   [54, 210, 150]],  // green
    [14,  [240, 190, 60]],  // amber
    [20,  [225, 70, 45]],   // red (warm)
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
  const cs = cfg.color_scale || { min: -10, max: 15 };
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

const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);

export function createModel3D(canvas) {
  const ctx = canvas.getContext("2d");
  let fieldSig = null;
  let lastRoomId = null;
  let faceTex = null;
  let particles = null;
  let lastT = 0;
  let markers = [];
  let proj = (p) => p;

  function makeField(room, readings) {
    const pts = [];
    for (const s of room.sensors || []) {
      const r = readings[s.id];
      if (!r || r.temp == null || isNaN(r.temp)) continue;
      pts.push({ x: s.x_m, y: s.y_m, z: s.z_m ?? 0, t: r.temp });
    }
    if (pts.length === 0) return null;
    if (pts.length === 1) { const c = pts[0]; return () => c.t; }
    const eps = 0.02;
    return (x, y, z) => {
      let num = 0, den = 0;
      for (const p of pts) {
        const dx = p.x - x, dy = p.y - y, dz = p.z - z;
        const wgt = 1 / (dx * dx + dy * dy + dz * dz + eps);
        num += wgt * p.t; den += wgt;
      }
      return den ? num / den : 0;
    };
  }

  function paintFace(cv, field, map, uMax, vMax, cs) {
    const N = cv.width;
    const octx = cv.getContext("2d");
    const img = octx.createImageData(N, N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const u = (i + 0.5) / N * uMax;
        const v = (j + 0.5) / N * vMax;
        const p = map(u, v);
        const t = field ? field(p.x, p.y, p.z) : (cs.min + cs.max) / 2;
        const m = tempColor(t, cs.min, cs.max).match(/\d+/g);
        const o = (j * N + i) * 4;
        img.data[o] = +m[0]; img.data[o + 1] = +m[1]; img.data[o + 2] = +m[2]; img.data[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
  }

  function buildFaces(room, field, cs) {
    const d = room.dims_m;
    const N = 128;
    const mk = () => { const c = document.createElement("canvas"); c.width = N; c.height = N; return c; };
    const floor = mk(), wallL = mk(), wallR = mk(), wallFront = mk(), top = mk();
    paintFace(floor, field, (u, v) => ({ x: u, y: v, z: 0 }), d.length, d.width, cs);
    paintFace(wallL, field, (u, v) => ({ x: u, y: 0, z: v }), d.length, d.height, cs);
    paintFace(wallR, field, (u, v) => ({ x: d.length, y: u, z: v }), d.width, d.height, cs);
    paintFace(wallFront, field, (u, v) => ({ x: u, y: d.width, z: v }), d.length, d.height, cs);
    paintFace(top, field, (u, v) => ({ x: u, y: v, z: d.height }), d.length, d.width, cs);
    return { floor, wallL, wallR, wallFront, top };
  }

  function initParticles(d) {
    const arr = [];
    const cx = d.length / 2, cy = d.width / 2;
    for (let i = 0; i < 120; i++) {
      arr.push({
        theta: Math.random() * Math.PI * 2,
        rad: 0.2 + Math.random() * 0.78,
        speed: 0.3 + Math.random() * 0.6,
        zph: Math.random() * Math.PI * 2,
        zsp: 0.3 + Math.random() * 0.6,
        cx, cy,
        x: 0, y: 0, z: 0,
        trail: [],
      });
    }
    return arr;
  }

  function render(room, readings, cfg, selectedId, t) {
    const dpr = window.devicePixelRatio || 1;
    const wrap = canvas.parentElement;
    const cw = wrap.clientWidth || 600;
    const chh = wrap.clientHeight || Math.round(cw * 0.5);
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(chh * dpr)) {
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(chh * dpr);
      canvas.style.width = cw + "px"; canvas.style.height = chh + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, cw, chh);
    if (!room) return;
    const d = room.dims_m;
    const cs = cfg.color_scale || { min: -10, max: 15 };

    const sig = room.id + "|" + (room.sensors || []).map(s => {
      const r = readings[s.id];
      return s.id + ":" + (r && r.temp != null ? Math.round(r.temp * 10) : "x");
    }).join(",");
    if (sig !== fieldSig || !faceTex) {
      fieldSig = sig;
      const field = makeField(room, readings);
      faceTex = buildFaces(room, field, cs);
    }
    if (!particles || lastRoomId !== room.id) {
      particles = initParticles(d);
      lastRoomId = room.id;
    }

    const P = (x, y, z) => ({ x: (x - y) * COS * scale + ox, y: ((x + y) * SIN - z) * scale + oy });
    // Bounds for auto-fit.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const corners = [
      [0, 0, 0], [d.length, 0, 0], [d.length, d.width, 0], [0, d.width, 0],
      [0, 0, d.height], [d.length, 0, d.height], [d.length, d.width, d.height], [0, d.width, d.height],
    ];
    for (const [x, y, z] of corners) {
      const sx = (x - y) * COS, sy = (x + y) * SIN - z;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
    const pad = 14;
    const scale = Math.min((cw - 2 * pad) / (maxX - minX), (chh - 2 * pad) / (maxY - minY));
    const ox = cw / 2 - (minX + maxX) / 2 * scale;
    const oy = chh / 2 - (minY + maxY) / 2 * scale;

    const drawFace = (tex, A, B, D, alpha) => {
      const N = tex.width;
      const a = (B.x - A.x) / N, b = (B.y - A.y) / N, c = (D.x - A.x) / N, e = (D.y - A.y) / N;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.transform(a, b, c, e, A.x, A.y);
      ctx.drawImage(tex, 0, 0);
      ctx.restore();
      ctx.globalAlpha = 1;
    };

    const fA = P(0, 0, 0), fB = P(d.length, 0, 0), fD = P(0, d.width, 0);
    const lA = P(0, 0, 0), lB = P(d.length, 0, 0), lD = P(0, 0, d.height);
    const rA = P(d.length, 0, 0), rB = P(d.length, d.width, 0), rD = P(d.length, 0, d.height);
    const frA = P(0, d.width, 0), frB = P(d.length, d.width, 0), frD = P(0, d.width, d.height);
    const tA = P(0, 0, d.height), tB = P(d.length, 0, d.height), tD = P(0, d.width, d.height);
    // Soft contact shadow for depth.
    const sc = P(d.length / 2, d.width / 2, 0);
    const shR = Math.max(cw, chh) * 0.42;
    const sg = ctx.createRadialGradient(sc.x, sc.y, 4, sc.x, sc.y, shR);
    sg.addColorStop(0, "rgba(0,0,0,0.38)");
    sg.addColorStop(0.7, "rgba(0,0,0,0.10)");
    sg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, cw, chh);

    // Opaque faces -> the box reads as a solid colored volume.
    drawFace(faceTex.floor, fA, fB, fD, 1.0);
    drawFace(faceTex.wallL, lA, lB, lD, 0.95);
    drawFace(faceTex.wallR, rA, rB, rD, 0.97);
    drawFace(faceTex.wallFront, frA, frB, frD, 0.97);
    drawFace(faceTex.top, tA, tB, tD, 0.92);

    // Wireframe edges with a soft glow.
    const pe = corners.map(([x, y, z]) => P(x, y, z));
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    ctx.save();
    ctx.shadowColor = "rgba(125,211,252,0.35)";
    ctx.shadowBlur = 6;
    ctx.strokeStyle = "rgba(226,232,240,0.85)";
    ctx.lineWidth = 1.3;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    for (const [i, j] of edges) { ctx.moveTo(pe[i].x, pe[i].y); ctx.lineTo(pe[j].x, pe[j].y); }
    ctx.stroke();
    ctx.restore();

    // Door gap on the front-bottom edge (corner 3 -> 2, y = width).
    const door = room.door;
    if (door && door.x_m != null) {
      const a = P(door.x_m, d.width, 0), b = P(door.x_m + (door.width_m || 1.2), d.width, 0);
      ctx.strokeStyle = "rgba(11,16,21,0.9)";
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // Flowing air: wind streaks with direction arrows (weather-map style).
    const dt = Math.min(0.05, lastT ? t - lastT : 0.016);
    lastT = t;
    if (!particles) particles = initParticles(d);
    const field = makeField(room, readings);
    ctx.globalCompositeOperation = "lighter";
    for (const p of particles) {
      p.theta += p.speed * dt;
      p.zph += p.zsp * dt;
      const nx = p.cx + p.rad * d.length * 0.5 * Math.cos(p.theta);
      const ny = p.cy + p.rad * d.width * 0.5 * Math.sin(p.theta);
      const nz = d.height * (0.5 + 0.42 * Math.sin(p.zph));
      p.trail.push({ x: nx, y: ny, z: nz });
      if (p.trail.length > 9) p.trail.shift();
      p.x = nx; p.y = ny; p.z = nz;
      const lt = field ? field(nx, ny, nz) : (cs.min + cs.max) / 2;
      const m = tempColor(lt, cs.min, cs.max).match(/\d+/g);
      const depth = 0.42 + 0.58 * (1 - Math.abs(nz - d.height / 2) / (d.height / 2 || 1));
      const pts = p.trail.map(q => P(q.x, q.y, q.z));
      for (let k = 1; k < pts.length; k++) {
        const a = (k / pts.length) * 0.4 * depth;
        ctx.strokeStyle = `rgba(${m[0]},${m[1]},${m[2]},${a})`;
        ctx.lineWidth = 1.3 * (k / pts.length) + 0.3;
        ctx.beginPath(); ctx.moveTo(pts[k - 1].x, pts[k - 1].y); ctx.lineTo(pts[k].x, pts[k].y); ctx.stroke();
      }
      if (pts.length >= 2) {
        const head = pts[pts.length - 1], prev = pts[pts.length - 2];
        const ang = Math.atan2(head.y - prev.y, head.x - prev.x);
        const ah = 4.5;
        ctx.fillStyle = `rgba(${m[0]},${m[1]},${m[2]},0.9)`;
        ctx.beginPath();
        ctx.moveTo(head.x, head.y);
        ctx.lineTo(head.x - ah * Math.cos(ang - 0.42), head.y - ah * Math.sin(ang - 0.42));
        ctx.lineTo(head.x - ah * Math.cos(ang + 0.42), head.y - ah * Math.sin(ang + 0.42));
        ctx.closePath(); ctx.fill();
      }
    }
    ctx.globalCompositeOperation = "source-over";

    // Sensor markers with refined label chips.
    markers = [];
    (room.sensors || []).forEach(s => {
      const pr = P(s.x_m, s.y_m, s.z_m ?? 0);
      const r = readings[s.id];
      const stale = !r || r.time == null || (Date.now() - r.time) > ((cfg.stale_after_s || 15) * 1000);
      const col = stale ? "#8fa3b5" : tempColor(r.temp, cs.min, cs.max);
      const pulse = 1 + 0.16 * Math.sin(t * 2.4 + (s.x_m + s.y_m));
      const rad = 6.5 * pulse;
      const g = ctx.createRadialGradient(pr.x, pr.y, 1, pr.x, pr.y, rad * 2.6);
      g.addColorStop(0, col);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(pr.x, pr.y, rad * 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(pr.x, pr.y, rad * 0.6, 0, Math.PI * 2); ctx.fill();
      if (selectedId === s.id) {
        ctx.strokeStyle = "#7dd3fc"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(pr.x, pr.y, rad + 5, 0, Math.PI * 2); ctx.stroke();
      }
      const val = stale ? "--.-" : r.temp.toFixed(1) + "°";
      ctx.font = "600 11px ui-monospace, Menlo, Consolas, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const nameW = ctx.measureText(s.label).width;
      const valW = ctx.measureText(val).width;
      const padX = 7, gap = 6, bh = 20;
      const bw = padX * 2 + nameW + gap + valW;
      const bx = pr.x + rad + 8, by = pr.y - bh / 2;
      rr(ctx, bx, by, bw, bh, 6);
      ctx.fillStyle = "rgba(9,13,19,0.82)";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = col;
      ctx.stroke();
      ctx.fillStyle = "rgba(226,232,240,0.92)";
      ctx.fillText(s.label, bx + padX, by + bh / 2 + 0.5);
      ctx.fillStyle = col;
      ctx.fillText(val, bx + padX + nameW + gap, by + bh / 2 + 0.5);
      ctx.textBaseline = "alphabetic";
      markers.push({ id: s.id, x: pr.x, y: pr.y, r: rad + 8 });
    });
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
