import { cssTempColor, drawLegend, createModel3D } from "./viz.js";

const fmt1 = (v) => v == null || isNaN(v) ? "--.-" : Number(v).toFixed(1);

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const UP = window.uPlot;
const AXIS = "rgba(176,190,197,0.55)";
const GRID = "rgba(255,255,255,0.05)";
const FONT = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const LINE_COLORS = [
  "#38bdf8", "#f59e0b", "#34d399", "#a78bfa",
  "#fb7185", "#22d3ee", "#facc15", "#f472b6",
];

const MINUTES = [
  { v: 30, label: "30m" },
  { v: 60, label: "1h" },
  { v: 360, label: "6h" },
  { v: 1440, label: "24h" },
];

const state = {
  fridges: [],
  cfg: null,
  latest: {},
  model: null,
  rangeMin: 60,
  selectedRoom: null,
  selectedSensor: null,
  openRooms: new Set(),
  charts: new Map(),
  liveQueue: new Map(),
  livePending: false,
  lastNet: 0,
  lastPoll: 0,
  connected: false,
  sse: null,
  observers: new Map(),
};

const netLabel = (s) => ({ ok: "Live", connecting: "Connecting", down: "Reconnecting", stale: "Stale" }[s] || s);
const fmtAge = (ms) => {
  if (ms == null) return "no data";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const isStale = (id) => {
  const r = state.latest[id];
  const after = (state.cfg && state.cfg.stale_after_s) || 15;
  return !r || !r.time || (Date.now() - r.time) > after * 1000;
};

async function api(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function buildSidebar() {
  const wrap = $("#room-list");
  wrap.innerHTML = "";
  state.openRooms = new Set(state.fridges.map(f => f.id));
  state.fridges.forEach(room => {
    const open = state.openRooms.has(room.id);
    const active = state.selectedRoom === room.id;
    const li = document.createElement("div");
    li.className = "room-block";
    const btn = document.createElement("button");
    btn.className = "room-item" + (open ? " open" : "") + (active ? " active" : "");
    btn.innerHTML = `<span class="chev" aria-hidden="true"></span><span class="room-name">${escapeHtml(room.name)}</span>`;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.addEventListener("click", () => {
      if (state.selectedRoom === room.id) {
        state.openRooms.has(room.id) ? state.openRooms.delete(room.id) : state.openRooms.add(room.id);
      } else {
        state.selectedRoom = room.id;
        state.openRooms.add(room.id);
        renderView();
        return;
      }
      updateSidebar();
    });
    li.appendChild(btn);

    const tree = document.createElement("div");
    tree.className = "sensor-tree";
    tree.hidden = !open;
    const sensors = room.sensors || [];
    if (sensors.length === 0) {
      tree.innerHTML = `<div class="tree-empty">No sensors assigned</div>`;
    } else {
      sensors.forEach(s => {
        const r = state.latest[s.id];
        const stale = isStale(s.id);
        const sb = document.createElement("button");
        sb.className = "tree-sensor" + (state.selectedSensor === s.id ? " selected" : "") + (stale ? " stale" : "");
        const dotColor = stale ? "var(--mut)" : cssTempColor(r?.temp, state.cfg.color_scale.min, state.cfg.color_scale.max);
        sb.innerHTML = `<span class="ts-dot" style="background:${dotColor}"></span><span class="ts-name">${escapeHtml(s.label)}</span><span class="ts-temp num">${stale ? "--.-" : fmt1(r?.temp)}°</span>`;
        sb.addEventListener("click", (e) => { e.stopPropagation(); selectSensor(room.id, s.id); });
        tree.appendChild(sb);
      });
    }
    li.appendChild(tree);
    wrap.appendChild(li);
  });
}

function updateSidebar() {
  $$("#room-list .room-block").forEach((li, i) => {
    const room = state.fridges[i];
    const btn = $(".room-item", li);
    const tree = $(".sensor-tree", li);
    const open = state.openRooms.has(room.id);
    btn.classList.toggle("open", open);
    btn.classList.toggle("active", state.selectedRoom === room.id);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    tree.hidden = !open;
    if (!open) return;
    (room.sensors || []).forEach((s, j) => {
      const sb = $$(".tree-sensor", li)[j];
      if (!sb) return;
      const r = state.latest[s.id];
      const stale = isStale(s.id);
      sb.className = "tree-sensor" + (state.selectedSensor === s.id ? " selected" : "") + (stale ? " stale" : "");
      const dotColor = stale ? "var(--mut)" : cssTempColor(r?.temp, state.cfg.color_scale.min, state.cfg.color_scale.max);
      $(".ts-dot", sb).style.background = dotColor;
      $(".ts-temp", sb).textContent = `${stale ? "--.-" : fmt1(r?.temp)}°`;
    });
  });
}

function currentRoom() { return state.fridges.find(f => f.id === state.selectedRoom); }

function roomDims(room) {
  const d = room.dims_m;
  if (!d) return "";
  return `${fmt1(d.length)} × ${fmt1(d.width)} × ${fmt1(d.height)} m`;
}

function selectSensor(roomId, sensorId) {
  state.selectedRoom = roomId;
  state.openRooms.add(roomId);
  state.selectedSensor = sensorId;
  updateSidebar();
  updateRoomLive();
  updateHistorySelection();
}

function renderView() {
  const room = currentRoom();
  const view = $("#view");
  if (!room) { view.innerHTML = `<div class="room-head"><h2>Select a cold room</h2></div>`; return; }

  view.innerHTML = `
    <div class="room-head">
      <div>
        <h2>${escapeHtml(room.name)}</h2>
        <p>${escapeHtml(roomDims(room))}</p>
      </div>
    </div>
    <div class="alarm-banner" id="banner"></div>
    <div class="stage">
      <div class="plan-wrap"><canvas class="plan-canvas" id="field"></canvas></div>
      <div class="legend-wrap"><span class="num" id="leg-min"></span><canvas id="legend"></canvas><span class="num" id="leg-max"></span></div>
      <p class="plane-note" id="plane-note"></p>
    </div>`;

  const fc = $("#field");
  state.model = createModel3D(fc);
  fc.addEventListener("click", (e) => {
    const rect = fc.getBoundingClientRect();
    const id = state.model && state.model.pick(e.clientX - rect.left, e.clientY - rect.top);
    if (id) selectSensor(room.id, id);
  });

  paintField(room);
  buildHistory(room);
}

function paintField(room) {
  drawLegend($("#legend"), state.cfg.color_scale);
  $("#leg-min").textContent = fmt1(state.cfg.color_scale.min) + "°";
  $("#leg-max").textContent = fmt1(state.cfg.color_scale.max) + "°";
  const th = room.thresholds || state.cfg.thresholds;
  $("#plane-note").innerHTML = `3D cold-room model &middot; target ${fmt1(th.target_min)}–${fmt1(th.target_max)}°C &middot; warn ${fmt1(th.warn_max)}° &middot; alarm ${fmt1(th.alarm_max)}°`;
}

function updateRoomLive() {
  const room = currentRoom(); if (!room) return;
  paintField(room);
  const th = room.thresholds || state.cfg.thresholds;
  const banner = $("#banner");
  const sensors = room.sensors || [];
  let faultLabel = null, worst = null, worstTemp = null, offline = 0;
  sensors.forEach(s => {
    const r = state.latest[s.id];
    if (!r) { offline++; return; }
    if (r.fault) { faultLabel = faultLabel || s.label; return; }
    if (r.temp != null) {
      if (r.temp > th.alarm_max && (!worstTemp || r.temp > worstTemp)) { worst = "alarm"; worstTemp = r.temp; }
      else if (r.temp > th.warn_max && worst !== "alarm") { worst = "warn"; }
    }
  });
  if (faultLabel) {
    banner.className = "alarm-banner alarm";
    banner.textContent = `Sensor fault detected: ${faultLabel}`;
  } else if (worst === "alarm") {
    banner.className = "alarm-banner alarm";
    banner.textContent = `ALARM: ${fmt1(worstTemp)}°C exceeds ${fmt1(th.alarm_max)}°C`;
  } else if (worst === "warn") {
    banner.className = "alarm-banner warn";
    banner.textContent = `Warning: temperature above ${fmt1(th.warn_max)}°C`;
  } else if (offline > 0 && offline === sensors.length) {
    banner.className = "alarm-banner";
    banner.textContent = "Waiting for sensor data…";
  } else {
    banner.className = "alarm-banner";
    banner.textContent = "All sensors within target range";
  }
  updateSidebar();
  updateHistorySelection();
}

function chartCardColor(idx) { return LINE_COLORS[idx % LINE_COLORS.length]; }

function destroyCharts() {
  state.observers.forEach(o => o.disconnect());
  state.observers.clear();
  state.charts.forEach(ch => ch.u && ch.u.destroy());
  state.charts.clear();
}

async function buildHistory(room) {
  const grid = $("#hist-grid"); if (!grid) return;
  destroyCharts();
  const sensors = room.sensors || [];
  grid.innerHTML = "";
  if (sensors.length === 0) { grid.innerHTML = `<p class="empty-note">No sensors assigned to this room.</p>`; return; }

  let series = {};
  try {
    const ids = sensors.map(s => s.id).join(",");
    series = await api(`/api/readings/history?ids=${encodeURIComponent(ids)}&minutes=${state.rangeMin}&points=600`);
  } catch (e) { /* keep empty */ }

  const seconds = state.rangeMin * 60;
  sensors.forEach((s, idx) => {
    const card = document.createElement("div");
    card.className = "chart-card" + (state.selectedSensor === s.id ? " selected" : "");
    card.dataset.sensor = s.id;
    card.innerHTML = `
      <div class="chart-card-head">
        <span class="hc-name">${escapeHtml(s.label)}</span>
        <span class="hc-temp num" id="hc-temp-${s.id}">--.-°</span>
      </div>
      <div class="chart-host" id="chart-${s.id}"><div class="chart-empty">Awaiting data</div></div>`;
    card.addEventListener("click", () => selectSensor(room.id, s.id));
    grid.appendChild(card);

    const rows = (series.series && series.series[s.id]) || [];
    const xs = rows.map(r => Math.round(r[0] / 1000));
    const ys = rows.map(r => r[1]);
    const host = $("#chart-" + s.id, card);
    const ch = { id: s.id, color: chartCardColor(idx), xs, ys, el: host, u: null };
    state.charts.set(s.id, ch);
    if (xs.length) { host.innerHTML = ""; ch.u = makeChart(host, ch); }
    observeChart(ch);
  });
  updateHistorySelection();
}

function thresholdPlugin(th) {
  return {
    hooks: {
      draw(u) {
        const ctx = u.ctx;
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        for (const [v, col] of [[th.target_min, "rgba(52,211,153,0.5)"], [th.target_max, "rgba(56,189,248,0.45)"]]) {
          if (v == null) continue;
          const y = u.valToPos(v, "y", true);
          if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) continue;
          ctx.strokeStyle = col;
          ctx.beginPath();
          ctx.moveTo(u.bbox.left, y);
          ctx.lineTo(u.bbox.left + u.bbox.width, y);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  };
}

function makeChart(host, ch) {
  const room = currentRoom();
  const th = (room.thresholds || state.cfg.thresholds);
  const fill = ch.color + "1f";
  const opts = {
    width: Math.max(host.clientWidth || 480, 220),
    height: 312,
    padding: [12, 14, 26, 42],
    cursor: {
      points: { size: 5, width: 2, stroke: ch.color, fill: "#0d1117" },
      drag: { x: true, y: false },
    },
    legend: { show: false },
    scales: { x: { time: true } },
    axes: [
      {
        stroke: AXIS, grid: { stroke: GRID }, ticks: { show: false }, font: FONT,
        values: (u, splits) => splits.map(s => {
          const d = new Date(s * 1000);
          return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }),
      },
      {
        stroke: AXIS, grid: { stroke: GRID }, ticks: { show: false }, font: FONT,
        size: 36,
        values: (u, splits) => splits.map(v => v.toFixed(1)),
      },
    ],
    series: [
      {},
      { stroke: ch.color, width: 1.8, fill: fill, spanGaps: false, points: { show: false } },
    ],
    plugins: [thresholdPlugin(th)],
  };
  const tip = document.createElement("div");
  tip.className = "u-tooltip";
  tip.style.display = "none";
  host.appendChild(tip);
  const fmtTipTime = (x) => new Date(x * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  opts.hooks = {
    setCursor: [(u) => {
      const idx = u.cursor.idx;
      if (idx == null) { tip.style.display = "none"; return; }
      const x = u.data[0][idx], y = u.data[1][idx];
      if (y == null) { tip.style.display = "none"; return; }
      tip.innerHTML = `<b>${fmt1(y)}°C</b><span>${fmtTipTime(x)}</span>`;
      tip.style.display = "block";
      const hr = host.getBoundingClientRect();
      const or = u.over.getBoundingClientRect();
      tip.style.left = (or.left - hr.left + u.cursor.left) + "px";
      tip.style.top = (or.top - hr.top + u.cursor.top) + "px";
    }],
  };
  const u = new UP(opts, [ch.xs, ch.ys], host);
  sizeChart(ch);
  return u;
}

function sizeChart(ch) {
  if (!ch.u) return;
  const w = Math.max(ch.el.clientWidth || 480, 220);
  ch.u.setSize({ width: w, height: 312 });
}

function observeChart(ch) {
  if (!("ResizeObserver" in window)) return;
  const ro = new ResizeObserver(() => sizeChart(ch));
  ro.observe(ch.el);
  state.observers.set(ch.id, ro);
}

function queueLive(id, t, temp) {
  if (!state.charts.has(id)) return;
  if (!state.liveQueue.has(id)) state.liveQueue.set(id, []);
  state.liveQueue.get(id).push([Math.round(t / 1000), temp]);
  if (!state.livePending) { state.livePending = true; requestAnimationFrame(flushLive); }
}

function flushLive() {
  state.livePending = false;
  const cutoff = Math.floor(Date.now() / 1000) - state.rangeMin * 60;
  state.liveQueue.forEach((pts, id) => {
    const ch = state.charts.get(id);
    if (!ch) return;
    for (const [x, y] of pts) { ch.xs.push(x); ch.ys.push(y); }
    while (ch.xs.length && ch.xs[0] < cutoff) { ch.xs.shift(); ch.ys.shift(); }
    if (ch.u) {
      const u = ch.u;
      const dMin = ch.xs[0], dMax = ch.xs[ch.xs.length - 1];
      const sMin = u.scales.x.min, sMax = u.scales.x.max;
      const zoomed = sMin != null && sMax != null &&
        (sMin > dMin + 1e-6 || sMax < dMax - 1e-6);
      u.setData([ch.xs, ch.ys], !zoomed);
    }
  });
  state.liveQueue.clear();
  updateHistorySelection();
}

function updateHistorySelection() {
  state.charts.forEach((ch, id) => {
    const card = document.querySelector(`.chart-card[data-sensor="${id}"]`);
    if (!card) return;
    card.classList.toggle("selected", state.selectedSensor === id);
    const r = state.latest[id];
    const tEl = $("#hc-temp-" + id, card);
    if (tEl) {
      const stale = isStale(id);
      tEl.textContent = stale ? "--.-°" : fmt1(r.temp) + "°";
      tEl.style.color = stale ? "var(--mut)" : cssTempColor(r.temp, state.cfg.color_scale.min, state.cfg.color_scale.max);
    }
  });
}

function setConn(s) {
  state.connected = s === "ok";
  $("#conn-dot").className = "conn-dot " + s;
  $("#conn-label").textContent = netLabel(s);
}

function onLive(evt) {
  const s = evt;
  if (!s || !s.sensor_id) return;
  state.latest[s.sensor_id] = { temp: s.temp, resistance: s.resistance, fault: s.fault, time: Date.now() };
  queueLive(s.sensor_id, Date.now(), s.temp);
  updateRoomLive();
}

function connectSSE() {
  try { state.sse && state.sse.close(); } catch (e) {}
  const es = new EventSource("/api/stream");
  state.sse = es;
  es.onopen = () => setConn("ok");
  es.onerror = () => setConn("down");
  es.onmessage = (ev) => { try { onLive(JSON.parse(ev.data)); } catch (e) {} };
}

async function pollServer() {
  const now = Date.now();
  if (now - state.lastPoll < 4000) return;
  state.lastPoll = now;
  try {
    const data = await api("/api/readings/latest");
    const map = data.readings || {};
    Object.entries(map).forEach(([id, v]) => {
      const t = typeof v.time === "number" ? v.time : (v.time ? Date.parse(v.time) : Date.now());
      if (!state.latest[id] || t > state.latest[id].time) {
        state.latest[id] = { temp: v.temp, resistance: v.resistance, fault: v.fault, time: t };
      }
    });
    if (now - state.lastNet > 4000) setConn("ok");
    state.lastNet = now;
    updateRoomLive();
  } catch (e) {
    if (now - state.lastNet > 8000) setConn("down");
  }
}

async function boot() {
  try {
    const data = await api("/api/fridges");
    state.fridges = (data.rooms || []).map(r => ({
      ...r,
      thresholds: {
        target_min: r.thresholds.target_min,
        target_max: r.thresholds.target_max,
        warn_max: r.thresholds.warn,
        alarm_max: r.thresholds.alarm,
      },
    }));
    state.cfg = { color_scale: data.color_scale, stale_after_s: data.stale_after_s || 15, thresholds: null };
  } catch (e) {
    state.fridges = [];
    state.cfg = { color_scale: { min: -10, max: 15 }, stale_after_s: 15, thresholds: null };
  }
  buildSidebar();
  if (!state.selectedRoom && state.fridges[0]) state.selectedRoom = state.fridges[0].id;
  renderView();
  const rs = $("#range-seg");
  if (rs) rs.addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn"); if (!b) return;
    state.rangeMin = Number(b.dataset.min);
    $$("#range-seg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
    buildHistory(currentRoom());
  });
  connectSSE();
  setInterval(pollServer, 4000);
  setInterval(() => { if (state.connected) updateRoomLive(); }, 2500);
  function loop(ts) {
    const room = currentRoom();
    if (room && state.model) state.model.render(room, state.latest, state.cfg, state.selectedSensor, ts / 1000);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

boot();
