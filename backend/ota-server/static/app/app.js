/* Veze Sharri cold-chain dashboard.
   Shell: top bar / main room view + right room sidebar / bottom bar with one
   trend chart per sensor. */
import { drawField, drawChart, drawLegend, lineColor, planeOf, sensorUV, cssTempColor } from "./viz.js";

const $ = s => document.querySelector(s);
const fmt1 = t => (t == null || isNaN(t)) ? "--.-" : Number(t).toFixed(1);

const state = {
  cfg: { rooms: [], color_scale: { min: -25, max: 25 }, stale_after_s: 15 },
  latest: {},          // sid -> {temp, resistance, fault, time(ms)}
  conn: "connecting",  // connecting | live | polling | down
  routeId: null,
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
  try { es = new EventSource("/api/stream"); } catch { return; }
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
      if (state.conn !== "down") setConn("polling");
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
  updateSidebar();
  updateRoomLive();
}

/* ---------------- sidebar ---------------- */

function renderSidebar() {
  const nav = $("#room-list");
  nav.innerHTML = "";
  for (const room of state.cfg.rooms) {
    const btn = document.createElement("button");
    btn.className = "room-item";
    btn.dataset.room = room.id;
    btn.setAttribute("aria-label", `${room.name}, open`);
    btn.addEventListener("click", () => { location.hash = `#/room/${room.id}`; });
    nav.appendChild(btn);
  }
  updateSidebar();
}

function updateSidebar() {
  for (const room of state.cfg.rooms) {
    const btn = document.querySelector(`.room-item[data-room="${room.id}"]`);
    if (!btn) continue;
    btn.classList.toggle("active", room.id === state.routeId);
    const temps = roomTemps(room).filter(p => !isStale(p.id));
    const avg = temps.length ? temps.reduce((a, p) => a + p.temp, 0) / temps.length : null;
    const st = statusOf(room);
    btn.innerHTML = `
      <span class="ri-status ${st}" aria-hidden="true"></span>
      <span class="ri-name">${escapeHtml(room.name)}</span>
      <span class="ri-temp num">${fmt1(avg)}°</span>`;
  }
}

function roomTemps(room) {
  const out = [];
  for (const s of room.sensors || []) {
    const r = state.latest[s.id];
    if (r && r.temp != null && !isNaN(r.temp)) out.push({ id: s.id, temp: r.temp });
  }
  return out;
}

/* ---------------- routing ---------------- */

function currentRoom() {
  return state.cfg.rooms.find(r => r.id === state.routeId);
}

function renderRoute() {
  clearInterval(chartTimer);
  chartTimer = null;
  const h = location.hash || "#/";
  const m = h.match(/^#\/room\/(.+)$/);
  state.routeId = (m && state.cfg.rooms.some(r => r.id === m[1]))
    ? m[1]
    : (state.cfg.rooms[0]?.id ?? null);
  renderMain();
  updateSidebar();
}

/* ---------------- main area ---------------- */

let chartTimer = null;

function renderMain() {
  const view = $("#view");
  const room = currentRoom();
  state.selectedSensor = null;
  if (!room) {
    view.innerHTML = `<p class="empty-note">No rooms configured in fridges.json</p>`;
    $("#bottombar").innerHTML = "";
    return;
  }
  const d = room.dims_m;
  view.innerHTML = `
    <div class="room-head">
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
      <div class="panel">
        <div class="plan-wrap"><canvas class="plan-canvas" id="field"></canvas><div class="dots" id="dots"></div></div>
        <div class="legend-wrap"><span class="num" id="leg-min"></span><canvas id="legend"></canvas><span class="num" id="leg-max"></span></div>
        <p class="plane-note" id="plane-note"></p>
      </div>
      <aside class="panel rail">
        <h3>Sensors</h3>
        <div id="rail-list"></div>
      </aside>
    </div>`;

  drawLegend($("#legend"), state.cfg);
  $("#leg-min").textContent = `${state.cfg.color_scale.min}°C`;
  $("#leg-max").textContent = `${state.cfg.color_scale.max}°C`;

  view.querySelectorAll("[data-plane]").forEach(b =>
    b.addEventListener("click", () => {
      state.plane = b.dataset.plane;
      view.querySelectorAll("[data-plane]").forEach(x => x.classList.toggle("active", x === b));
      updateRoomLive(true);
    }));
  view.querySelectorAll(".ranges [data-min]").forEach(b =>
    b.addEventListener("click", () => {
      state.rangeMin = +b.dataset.min;
      view.querySelectorAll(".ranges [data-min]").forEach(x => x.classList.toggle("active", x === b));
      loadCharts();
    }));

  renderBottomBar(room);
  loadCharts();
  chartTimer = setInterval(loadCharts, 15000);
  updateRoomLive(true);
}

/* ---------------- bottom bar: one chart per sensor ---------------- */

function renderBottomBar(room) {
  const bb = $("#bottombar");
  const ss = room.sensors || [];
  if (!ss.length) {
    bb.innerHTML = `<p class="bb-empty">No sensors assigned to ${escapeHtml(room.name)}.</p>`;
    return;
  }
  bb.innerHTML = ss.map(s => `
    <section class="chart-cell" data-cell="${s.id}">
      <header class="cc-head">
        <span class="cc-name">${escapeHtml(s.label)}</span>
        <span class="cc-temp num">--.-°C</span>
      </header>
      <canvas></canvas>
    </section>`).join("");
}

async function loadCharts() {
  const room = currentRoom();
  if (!room) return;
  const ids = (room.sensors || []).map(s => s.id);
  if (!ids.length) return;
  try {
    const d = await api(`/api/readings/history?sensors=${ids.join(",")}&minutes=${state.rangeMin}&points=120`);
    state.seriesCache = { ...state.seriesCache, ...d.series };
    paintBottomBar(room);
  } catch { /* charts optional */ }
}

function paintBottomBar(room) {
  const th = room.thresholds || {};
  for (const s of room.sensors || []) {
    const cell = document.querySelector(`[data-cell="${s.id}"]`);
    if (!cell) continue;
    const canvas = cell.querySelector("canvas");
    drawChart(canvas, { [s.id]: state.seriesCache[s.id] || [] }, room, state.rangeMin, canvas.clientHeight || 130);
    const r = state.latest[s.id];
    const stale = isStale(s.id);
    const el = cell.querySelector(".cc-temp");
    el.textContent = `${stale ? "--.-" : fmt1(r?.temp)}°C`;
    el.style.color = !stale && r?.temp != null
      ? cssTempColor(r.temp, state.cfg.color_scale.min, state.cfg.color_scale.max)
      : "var(--mut)";
  }
}

/* ---------------- live room updates ---------------- */

function activeReadings(room) {
  const out = {};
  for (const s of room.sensors || []) {
    const r = state.latest[s.id];
    if (r && !isStale(s.id)) out[s.id] = r;
  }
  return out;
}

function updateRoomLive(full = false) {
  const room = currentRoom();
  if (!room) return;

  const banner = $("#banner");
  if (banner) {
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
  }

  const canvas = $("#field");
  if (!canvas) return;
  drawField(canvas, room, state.plane, activeReadings(room), state.cfg);

  $("#plane-note").textContent = state.plane === "wall"
    ? "Side wall interpolates along length and height."
    : "Floor plan, 1 m grid.";

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

  const list = $("#rail-list");
  if ((room.sensors || []).length === 0) {
    list.innerHTML = `<p class="empty-note">No sensors assigned.</p>`;
    return;
  }
  list.innerHTML = "";
  (room.sensors || []).forEach(s => {
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

  paintBottomBar(room);
}

window.addEventListener("resize", () => {
  const room = currentRoom();
  if (!room) return;
  clearTimeout(window.__rz);
  window.__rz = setTimeout(() => {
    updateRoomLive(true);
    paintBottomBar(room);
  }, 150);
});

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
  window.addEventListener("hashchange", renderRoute);
  renderRoute();
  renderSidebar();
  openStream();
})();
