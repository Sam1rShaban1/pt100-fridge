/* Veze Sharri cold-chain dashboard: state, routing, API, live stream. */
import { drawField, drawChart, drawLegend, lineColor, planeOf, sensorUV, cssTempColor } from "./viz.js";

const $ = s => document.querySelector(s);
const fmt1 = t => (t == null || isNaN(t)) ? "--.-" : Number(t).toFixed(1);

const state = {
  cfg: { rooms: [], color_scale: { min: -25, max: 25 }, stale_after_s: 15 },
  latest: {},          // sid -> {temp, resistance, fault, time(ms)}
  conn: "connecting",  // connecting | live | polling | down
  route: { name: "overview" },
  rangeMin: 60,
  plane: "floor",
  selectedSensor: null,
  seriesCache: {},     // sid -> [[ms,temp],...]
};

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

/* ---------------- staleness + status ---------------- */

function isStale(sid) {
  const r = state.latest[sid];
  if (!r || !r.time) return true;
  return Date.now() - r.time > (state.cfg.stale_after_s || 15) * 1000;
}

function statusOf(room) {
  const ss = room.sensors || [];
  if (!ss.length) return "empty";
  const th = room.thresholds || {};
  let worst = "ok";
  let anyData = false;
  let anyFresh = false;
  for (const s of ss) {
    const r = state.latest[s.id];
    if (!r) continue;
    anyData = true;
    if (!isStale(s.id)) anyFresh = true;
    if (r.fault) return "alarm";
    if (th.alarm != null && r.temp != null && r.temp >= th.alarm) return "alarm";
    if (th.warn != null && r.temp != null && r.temp >= th.warn) worst = "warn";
  }
  if (!anyData) return "empty";
  if (!anyFresh) return "offline";
  return worst;
}

function roomTemps(room) {
  const out = [];
  for (const s of room.sensors || []) {
    const r = state.latest[s.id];
    if (r && r.temp != null && !isNaN(r.temp)) out.push({ id: s.id, temp: r.temp });
  }
  return out;
}

/* ---------------- connection handling ---------------- */

let es = null, pollTimer = null, lastEvt = 0;

function setConn(mode) {
  state.conn = mode;
  const el = $("#conn");
  el.className = `conn ${mode === "connecting" ? "" : mode}`;
  $("#conn-label").textContent =
    mode === "live" ? "Live"
      : mode === "polling" ? "Polling"
        : mode === "down" ? "Offline"
          : "Connecting";
}

function openStream() {
  try { es = new EventSource("/api/stream"); } catch { return startPolling(); }
  es.onopen = () => setConn("live");
  es.onerror = () => { if (state.conn !== "live") setConn("polling"); };
  es.onmessage = e => {
    lastEvt = Date.now();
    try {
      const d = JSON.parse(e.data);
      if (d.sensor_id) {
        state.latest[d.sensor_id] = d;
        scheduleRefresh();
      }
    } catch { /* ignore malformed */ }
  };
  pollTimer = setInterval(async () => {
    if (Date.now() - lastEvt < 12000 && state.conn === "live") return;
    try {
      const d = await api("/api/readings/latest");
      state.latest = { ...state.latest, ...d.readings };
      setConn(state.conn === "live" ? "polling" : state.conn);
      scheduleRefresh();
    } catch { setConn("down"); }
  }, 5000);
}

/* ---------------- throttled repaint ---------------- */

let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    refresh();
  });
}

function refresh() {
  if (state.route.name === "overview") updateCards();
  else if (state.route.name === "room") updateRoomLive();
}

/* ---------------- routing ---------------- */

function renderRoute() {
  const h = location.hash || "#/";
  const m = h.match(/^#\/room\/(.+)$/);
  if (m && state.cfg.rooms.some(r => r.id === m[1])) {
    state.route = { name: "room", id: m[1] };
    renderRoom();
  } else {
    state.route = { name: "overview" };
    renderOverview();
  }
}

/* ---------------- overview ---------------- */

function renderOverview() {
  const view = $("#view");
  if (!state.cfg.rooms.length) {
    view.innerHTML = `<p class="empty-note">No rooms configured in fridges.json</p>`;
    return;
  }
  view.innerHTML = `<section class="grid" id="rooms"></section>`;
  const wrap = $("#rooms");
  for (const room of state.cfg.rooms) {
    const card = document.createElement("article");
    card.className = "card";
    card.tabIndex = 0;
    card.setAttribute("role", "link");
    card.setAttribute("aria-label", `${room.name}, open detail`);
    card.addEventListener("click", () => { location.hash = `#/room/${room.id}`; });
    card.addEventListener("keydown", e => {
      if (e.key === "Enter") location.hash = `#/room/${room.id}`;
    });
    card.dataset.room = room.id;
    wrap.appendChild(card);
  }
  updateCards();
  loadSparks();
}

function updateCards() {
  for (const room of state.cfg.rooms) {
    const card = document.querySelector(`[data-room="${room.id}"]`);
    if (!card) continue;
    const st = statusOf(room);
    const temps = roomTemps(room).filter(p => !isStale(p.id));
    const avg = temps.length ? temps.reduce((a, p) => a + p.temp, 0) / temps.length : null;
    const min = temps.length ? Math.min(...temps.map(p => p.temp)) : null;
    const max = temps.length ? Math.max(...temps.map(p => p.temp)) : null;
    const cs = state.cfg.color_scale;
    const label = st === "ok" ? "OK" : st.charAt(0).toUpperCase() + st.slice(1);
    card.innerHTML = `
      <div class="card-head">
        <h2>${escapeHtml(room.name)}</h2>
        <span class="status-pill ${st}">${label}</span>
      </div>
      <div class="card-temp num" style="${avg != null ? `color:${cssTempColor(avg, cs.min, cs.max)}` : ""}">
        ${fmt1(avg)}<span class="unit">°C</span>
      </div>
      <div class="card-sub num">
        <span>min ${fmt1(min)} / max ${fmt1(max)}</span>
        <span>${room.sensors?.length || 0} sensor${(room.sensors?.length || 0) === 1 ? "" : "s"}</span>
      </div>
      <canvas class="spark" height="48"></canvas>`;
  }
}

async function loadSparks() {
  try {
    const allIds = state.cfg.rooms.flatMap(r => (r.sensors || []).map(s => s.id));
    const d = await api(`/api/readings/history?sensors=${allIds.join(",")}&minutes=60&points=60`);
    state.seriesCache = d.series;
    paintSparks();
  } catch { /* sparkline optional */ }
}

function paintSparks() {
  for (const room of state.cfg.rooms) {
    const card = document.querySelector(`[data-room="${room.id}"] .spark`);
    if (!card) continue;
    // Average across the room's sensors per bucket.
    const ids = (room.sensors || []).map(s => s.id);
    const byBucket = new Map();
    ids.forEach(sid => {
      (state.seriesCache[sid] || []).forEach(([ms, t]) => {
        if (!byBucket.has(ms)) byBucket.set(ms, []);
        byBucket.get(ms).push(t);
      });
    });
    const pts = [...byBucket.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ms, arr]) => [ms, arr.reduce((a, b) => a + b, 0) / arr.length]);
    drawSpark(card, pts);
  }
}

function drawSpark(canvas, pts) {
  const w = canvas.clientWidth || 280, h = 48;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (pts.length < 2) {
    ctx.fillStyle = "rgba(143,163,181,.5)";
    ctx.font = "11px ui-monospace, Menlo, monospace";
    ctx.fillText("no history yet", 4, h / 2 + 3);
    return;
  }
  let lo = Infinity, hi = -Infinity;
  pts.forEach(([, t]) => { lo = Math.min(lo, t); hi = Math.max(hi, t); });
  const pad = Math.max((hi - lo) * 0.2, 0.3); lo -= pad; hi += pad;
  const X = i => (i / (pts.length - 1)) * (w - 4) + 2;
  const Y = t => h - 6 - ((t - lo) / (hi - lo)) * (h - 12);
  ctx.strokeStyle = "rgba(125,211,252,.75)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  pts.forEach(([, t], i) => i ? ctx.lineTo(X(i), Y(t)) : ctx.moveTo(X(i), Y(t)));
  ctx.stroke();
  ctx.lineTo(w - 2, h); ctx.lineTo(2, h); ctx.closePath();
  ctx.fillStyle = "rgba(125,211,252,.07)";
  ctx.fill();
}

/* ---------------- room view ---------------- */

let chartTimer = null;

function renderRoom() {
  const room = state.cfg.rooms.find(r => r.id === state.route.id);
  const view = $("#view");
  state.selectedSensor = null;
  clearInterval(chartTimer);
  const d = room.dims_m;
  view.innerHTML = `
    <div class="room-head">
      <a class="back" href="#/">← All rooms</a>
      <div class="room-title">
        <h2>${escapeHtml(room.name)}</h2>
        <p class="num">${d.length} m × ${d.width} m × ${d.height} m · zone ${escapeHtml(room.zone || "")}</p>
      </div>
      <div class="seg" role="tablist" aria-label="View plane">
        <button data-plane="floor" class="active">Floor plan</button>
        <button data-plane="wall">Side wall</button>
      </div>
      <div class="seg ranges" aria-label="History range">
        <button data-min="30">30 min</button>
        <button data-min="60" class="active">1 hour</button>
        <button data-min="1440">24 hours</button>
      </div>
    </div>
    <div class="alarm-banner" id="banner"></div>
    <div class="viz-row">
      <div class="panel plan-wrap-wrap">
        <div class="plan-wrap"><canvas class="plan-canvas" id="field"></canvas><div class="dots" id="dots"></div></div>
        <div class="legend-wrap"><span class="num" id="leg-min"></span><canvas id="legend"></canvas><span class="num" id="leg-max"></span></div>
        <p class="plane-note" id="plane-note"></p>
      </div>
      <aside class="panel rail">
        <h3>Sensors</h3>
        <div id="rail-list"></div>
      </aside>
    </div>
    <div class="panel chart-panel">
      <div class="chart-head"><h3 id="chart-title">Temperature trend</h3></div>
      <canvas id="chart"></canvas>
    </div>`;

  drawLegend($("#legend"), state.cfg);
  $("#leg-min").textContent = `${state.cfg.color_scale.min}°C`;
  $("#leg-max").textContent = `${state.cfg.color_scale.max}°C`;

  view.querySelectorAll(".seg [data-plane]").forEach(b =>
    b.addEventListener("click", () => {
      state.plane = b.dataset.plane;
      view.querySelectorAll("[data-plane]").forEach(x => x.classList.toggle("active", x === b));
      updateRoomLive(true);
    }));
  view.querySelectorAll(".ranges [data-min]").forEach(b =>
    b.addEventListener("click", () => {
      state.rangeMin = +b.dataset.min;
      view.querySelectorAll(".ranges [data-min]").forEach(x => x.classList.toggle("active", x === b));
      loadRoomChart(room);
    }));

  loadRoomChart(room);
  chartTimer = setInterval(() => loadRoomChart(room), 15000);
  updateRoomLive(true);
  window.addEventListener("resize", roomResize);
}

function roomResize() {
  if (state.route.name !== "room") return;
  const room = state.cfg.rooms.find(r => r.id === state.route.id);
  if (!room) return;
  updateRoomLive(true);
}

function activeReadings(room) {
  // Only fresh readings drive the heat field.
  const out = {};
  for (const s of room.sensors || []) {
    const r = state.latest[s.id];
    if (r && !isStale(s.id)) out[s.id] = r;
  }
  return out;
}

function updateRoomLive(full = false) {
  const room = state.cfg.rooms.find(r => r.id === state.route.id);
  if (!room) return;

  const banner = $("#banner");
  const st = statusOf(room);
  if (st === "alarm") {
    const bad = (room.sensors || []).filter(s => {
      const r = state.latest[s.id];
      return r && (r.fault || (room.thresholds?.alarm != null && r.temp >= room.thresholds.alarm));
    }).map(s => `${s.label} ${state.latest[s.id].fault ? "fault" : fmt1(state.latest[s.id].temp) + " °C"}`);
    banner.textContent = "";
    banner.innerHTML = `<strong>Alarm:</strong> ${bad.map(escapeHtml).join(", ")} above limit`;
    banner.classList.add("show");
  } else if (st === "offline") {
    banner.textContent = "No fresh readings. Check the device power and WiFi.";
    banner.classList.add("show");
  } else {
    banner.classList.remove("show");
  }

  const readings = activeReadings(room);
  const canvas = $("#field");
  if (!canvas) return;
  drawField(canvas, room, state.plane, readings, state.cfg);

  $("#plane-note").textContent = state.plane === "wall"
    ? "Side wall interpolates along length and height."
    : "Floor plan, 1 m grid.";

  // Sensor dots overlay.
  const { U, V } = planeOf(room, state.plane);
  const dots = $("#dots");
  dots.innerHTML = "";
  for (const s of room.sensors || []) {
    const r = state.latest[s.id];
    const { u, v } = sensorUV(s, state.plane);
    const el = document.createElement("div");
    el.className = "sdot" + (isStale(s.id) ? " stale" : "") +
      (state.selectedSensor === s.id ? " selected" : "");
    el.style.left = `${(u / U) * 100}%`;
    el.style.top = `${(v / V) * 100}%`;
    const col = r && r.temp != null
      ? cssTempColor(r.temp, state.cfg.color_scale.min, state.cfg.color_scale.max)
      : "var(--mut)";
    el.innerHTML = `
      <div class="sdot-dot" style="background:${col}"></div>
      <div class="sdot-label num">${escapeHtml(s.label)} ${fmt1(r?.temp)}°C</div>`;
    el.addEventListener("click", () => {
      state.selectedSensor = state.selectedSensor === s.id ? null : s.id;
      updateRoomLive();
    });
    dots.appendChild(el);
  }

  // Rail.
  const list = $("#rail-list");
  if ((room.sensors || []).length === 0) {
    list.innerHTML = `<p class="empty-note">No sensors assigned to this room.</p>`;
    return;
  }
  list.innerHTML = "";
  (room.sensors || []).forEach((s, i) => {
    const r = state.latest[s.id];
    const stale = isStale(s.id);
    const row = document.createElement("button");
    row.className = "sensor-row" + (state.selectedSensor === s.id ? " selected" : "");
    const age = r?.time ? Math.round((Date.now() - r.time) / 1000) : null;
    row.innerHTML = `
      <div class="sensor-row-top">
        <span class="sensor-name">${escapeHtml(s.label)}</span>
        <span class="sensor-temp num" style="color:${!stale && r?.temp != null ? cssTempColor(r.temp, state.cfg.color_scale.min, state.cfg.color_scale.max) : "var(--mut)"}">${stale ? "--.-" : fmt1(r?.temp)}°C</span>
      </div>
      <div class="sensor-meta">
        <span>${fmt1(r?.resistance)} Ω</span>
        <span>h ${s.z_m ?? "?"} m</span>
        <span>${age == null ? "no data" : stale ? `stale ${age}s` : `${age}s ago`}</span>
        <span class="${r?.fault ? "fault-flag" : ""}">${r?.fault ? "FAULT" : "ok"}</span>
      </div>`;
    row.addEventListener("click", () => {
      state.selectedSensor = state.selectedSensor === s.id ? null : s.id;
      updateRoomLive();
    });
    list.appendChild(row);
  });

  // Chart header shows which lines are plotted.
  const title = $("#chart-title");
  if (title) {
    title.textContent = (room.sensors || []).map((s, i) => s.label).join(", ")
      ? `Temperature trend (${(room.sensors || []).length})`
      : "Temperature trend";
  }
}

async function loadRoomChart(room) {
  const ids = (room.sensors || []).map(s => s.id);
  if (!ids.length) return;
  try {
    const d = await api(`/api/readings/history?sensors=${ids.join(",")}&minutes=${state.rangeMin}&points=120`);
    state.seriesCache = { ...state.seriesCache, ...d.series };
    const canvas = $("#chart");
    if (!canvas) return;
    drawChart(canvas, d.series, room, state.rangeMin);
  } catch { /* chart optional */ }
}

/* ---------------- boot ---------------- */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

setInterval(() => { if (state.conn === "live") scheduleRefresh(); }, 3000);

(async function init() {
  try {
    state.cfg = await api("/api/fridges");
  } catch (e) {
    $("#view").innerHTML = `<p class="err">Backend unreachable: ${escapeHtml(e.message)}</p>`;
    return;
  }
  window.addEventListener("hashchange", () => {
    window.removeEventListener("resize", roomResize);
    renderRoute();
  });
  renderRoute();
  openStream();
})();
