import { cssTempColor, drawLegend, createModel3D, tempColor } from "./viz.js";

const fmt1 = (v) => v == null || isNaN(v) ? "--.-" : Number(v).toFixed(1);

function tweenNumber(el, value, suffix = "°", dur = 420) {  if (!el) return;
  if (value == null || isNaN(value)) { el.textContent = "--.-" + suffix; el.dataset.v = ""; return; }
  const prev = parseFloat(el.dataset.v);
  const from = isNaN(prev) ? value : prev;
  if (Math.abs(from - value) < 0.12) { el.dataset.v = value; el.textContent = fmt1(value) + suffix; return; }
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.dataset.v = value; el.textContent = fmt1(value) + suffix; return;
  }
  const start = performance.now();
  el.dataset.v = value;
  function step(now) {
    const k = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt1(from + (value - from) * e) + suffix;
    if (k < 1) requestAnimationFrame(step);
    else el.textContent = fmt1(value) + suffix;
  }
  requestAnimationFrame(step);
}

function tempRGBA(t, a) {
  const c = tempColor(t, state.cfg.color_scale.min, state.cfg.color_scale.max);
  const m = c.match(/\d+/g);
  return `rgba(${m[0]},${m[1]},${m[2]},${a})`;
}

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const UP = window.uPlot;
const AXIS = "rgba(154, 169, 188, 0.7)";
const GRID = "rgba(148, 163, 184, 0.08)";
const TICK = "rgba(148, 163, 184, 0.18)";
const FONT = '11px "JetBrains Mono", ui-monospace, monospace';

const LINE_COLORS = [
  "#2dd4bf", "#38bdf8", "#fbbf24", "#a78bfa",
  "#fb7185", "#34d399", "#f472b6", "#22d3ee",
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
  spark: new Map(),
  cache: new Map(),
  liveQueue: new Map(),
  livePending: false,
  lastNet: 0,
  lastPoll: 0,
  connected: false,
  sse: null,
  observers: new Map(),
  calibration: {},
  rawConfig: null,
  manageMode: false,
  knownSensors: [],
  fleetFilter: "all",
  fleetQuery: "",
  roomQuery: "",
  calOpen: false,
  mgOpen: new Set(),
  authRequired: false,
  authenticated: false,
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

let _loginPromise = null;

function ensureLoginUI() {
  let el = document.getElementById("auth-modal");
  if (el) return el;
  el = document.createElement("div");
  el.id = "auth-modal";
  el.className = "auth-modal";
  el.innerHTML = `
    <div class="auth-card" role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <h3 id="auth-title">Admin access required</h3>
      <p class="auth-sub">Enter the admin token to continue. A secure session will be created (token is not stored in the browser).</p>
      <form id="auth-form">
        <label class="mg-field"><span>Admin token</span>
          <input id="auth-token" class="mg-in" type="password" autocomplete="current-password" placeholder="OTA admin token" />
        </label>
        <div id="auth-msg" class="cal-msg"></div>
        <div class="auth-actions">
          <button type="button" class="seg-btn" id="auth-cancel">Cancel</button>
          <button type="submit" class="seg-btn active" id="auth-submit">Sign in</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(el);

  el.addEventListener("click", (e) => { if (e.target === el) closeLogin(false); });
  $("#auth-cancel", el).addEventListener("click", () => closeLogin(false));
  $("#auth-form", el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = $("#auth-token", el).value;
    const msg = $("#auth-msg", el);
    msg.textContent = "Signing in…";
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!r.ok) {
        msg.textContent = "Invalid token. Please try again.";
        return;
      }
      state.authenticated = true;
      closeLogin(true);
    } catch (err) {
      msg.textContent = "Login failed. Check connection and try again.";
    }
  });
  return el;
}

function closeLogin(ok) {
  const el = document.getElementById("auth-modal");
  if (el) el.classList.remove("show");
  if (_loginResolver) { _loginResolver(ok); _loginResolver = null; }
  _loginPromise = null;
}
let _loginResolver = null;

function ensureLogin() {
  if (_loginPromise) return _loginPromise;
  _loginPromise = new Promise((resolve) => {
    _loginResolver = resolve;
    const el = ensureLoginUI();
    $("#auth-token", el).value = "";
    $("#auth-msg", el).textContent = "";
    el.classList.add("show");
    setTimeout(() => $("#auth-token", el)?.focus(), 30);
  });
  return _loginPromise;
}

async function api(url, init, _retry) {
  const opts = Object.assign({}, init);
  // Cookies carry session auth for same-origin requests
  if (!opts.credentials) opts.credentials = "same-origin";
  const r = await fetch(url, opts);
  if (r.status === 401 && !_retry) {
    const ok = await ensureLogin();
    if (ok) return api(url, init, true);
  }
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) return r.json();
  return r.text();
}

function buildSidebar() {
  const wrap = $("#room-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  state.openRooms = new Set(state.fridges.map(f => f.id));
  const q = (state.roomQuery || "").trim().toLowerCase();
  const rooms = state.fridges.filter(r => !q || (r.name||"").toLowerCase().includes(q) || (r.id||"").toLowerCase().includes(q));
  if (!rooms.length) {
    wrap.innerHTML = `<div class="tree-empty">No matching rooms</div>`;
    return;
  }
  rooms.forEach(room => {
    const open = state.openRooms.has(room.id);
    const active = state.selectedRoom === room.id;
    const li = document.createElement("div");
    li.className = "room-block";
    li.dataset.room = room.id;
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
        sb.innerHTML = `<span class="ts-dot" style="background:${dotColor}"></span><span class="ts-name">${escapeHtml(s.label)}</span><span class="ts-temp num">${stale ? "--.-" : fmt1(r?.temp)}°</span><canvas class="ts-spark" data-spark></canvas>`;
        sb.addEventListener("click", (e) => { e.stopPropagation(); selectSensor(room.id, s.id); });
        tree.appendChild(sb);
      });
    }
    li.appendChild(tree);
    wrap.appendChild(li);
  });
}

function updateSidebar() {
  $$("#room-list .room-block").forEach((li) => {
    const room = state.fridges.find(f => f.id === li.dataset.room);
    if (!room) return;
    const btn = $(".room-item", li);
    const tree = $(".sensor-tree", li);
    if (!btn || !tree) return;
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
      const dot = $(".ts-dot", sb); if (dot) dot.style.background = dotColor;
      const tt = $(".ts-temp", sb); if (tt) tt.textContent = `${stale ? "--.-" : fmt1(r?.temp)}°`;
      const sp = $(".ts-spark", sb);
      if (sp && !stale && state.spark.has(s.id)) {
        const s2 = state.spark.get(s.id);
        drawSpark(sp, s2.xs, s2.ys, cssTempColor(r?.temp, state.cfg.color_scale.min, state.cfg.color_scale.max));
      }
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
  state.calOpen = true;
  updateSidebar();
  renderCalibration();
  updateRoomLive();
  updateHistorySelection();
}

function drawSpark(canvas, xs, ys, color) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!xs || xs.length < 2) {
    ctx.strokeStyle = "rgba(148,163,184,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    return;
  }
  let min = Infinity, max = -Infinity;
  for (const v of ys) { if (v < min) min = v; if (v > max) max = v; }
  if (max - min < 1e-6) { max += 1; min -= 1; }
  const padX = 2, padY = 3;
  const n = xs.length - 1;
  const X = (i) => padX + (xs[i] - xs[0]) / (xs[n] - xs[0] || 1) * (w - padX * 2);
  const Y = (v) => h - padY - (v - min) / (max - min) * (h - padY * 2);
  ctx.beginPath();
  for (let i = 0; i <= n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(i), Y(ys[i]));
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.stroke();
  ctx.lineTo(X(n), h); ctx.lineTo(X(0), h); ctx.closePath();
  ctx.fillStyle = color.startsWith("#") ? color + "22" : "rgba(125,211,252,0.13)";
  ctx.fill();
}

function roomStatus(room) {
  const sensors = room.sensors || [];
  if (!sensors.length) return { level: "empty", temp: null, sensorId: null, sub: "No sensors" };
  const th = room.thresholds || state.cfg.thresholds;
  let online = 0, fault = false, maxTemp = -Infinity, repId = null;
  sensors.forEach((s) => {
    const r = state.latest[s.id];
    if (!r || !r.time || (Date.now() - r.time) > ((state.cfg && state.cfg.stale_after_s) || 15) * 1000) return;
    online++;
    if (r.fault) fault = true;
    if (r.temp != null && r.temp > maxTemp) { maxTemp = r.temp; repId = s.id; }
  });
  if (online === 0) return { level: "offline", temp: null, sensorId: null, sub: "No data" };
  let level = "ok";
  if (fault) level = "alarm";
  else if (maxTemp > th.alarm_max) level = "alarm";
  else if (maxTemp > th.warn_max) level = "warn";
  const sub = fault ? "Sensor fault" : `Warmest ${fmt1(maxTemp)}° · ${sensors.length} sensors`;
  return { level, temp: maxTemp, sensorId: repId, sub };
}

const SPARK_COLOR = { ok: "#7dd3fc", warn: "#fbbf24", alarm: "#f87171", offline: "#64748b", empty: "#64748b" };

function buildFleet() {
  const el = $("#fleet"); if (!el) return;
  el.innerHTML = "";
  if (!state.fridges.length) {
    el.innerHTML = `<div class="fleet-empty">No cold rooms configured yet. Use <b>Manage</b> to add fridges and assign sensors.</div>`;
    return;
  }
  state.fridges.forEach((room) => {
    const card = document.createElement("button");
    card.className = "fleet-card is-loading";
    card.dataset.room = room.id;
    card.innerHTML = `
      <div class="fc-top">
        <span class="fc-dot" data-dot></span>
        <span class="fc-name">${escapeHtml(room.name)}</span>
        <span class="fc-age num" data-age></span>
      </div>
      <div class="fc-temp num" data-temp>--.-°</div>
      <div class="fc-sub" data-sub></div>
      <canvas class="fc-spark" data-spark></canvas>`;
    card.addEventListener("click", () => {
      state.selectedRoom = room.id;
      state.openRooms.add(room.id);
      buildSidebar();
      renderView();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    el.appendChild(card);
  });
  updateFleet();
}

function applyFleetFilters() {
  const el = $("#fleet"); if (!el) return;
  const q = (state.fleetQuery || "").trim().toLowerCase();
  const f = state.fleetFilter || "all";
  let shown = 0;
  $$(".fleet-card", el).forEach(card => {
    const room = state.fridges.find(r => r.id === card.dataset.room);
    if (!room) { card.style.display = "none"; return; }
    const st = roomStatus(room);
    const matchQ = !q || (room.name||"").toLowerCase().includes(q) || (room.id||"").toLowerCase().includes(q);
    const matchF = f === "all" || st.level === f;
    const vis = matchQ && matchF;
    card.style.display = vis ? "" : "none";
    if (vis) shown++;
  });
  let empty = $(".fleet-empty-msg", el);
  if (!empty && state.fridges.length) {
    empty = document.createElement("div");
    empty.className = "fleet-empty fleet-empty-msg";
    el.appendChild(empty);
  }
  if (empty) {
    empty.style.display = shown === 0 ? "" : "none";
    empty.textContent = "No rooms match the current filters.";
  }
}

function updateFleet() {
  const el = $("#fleet"); if (!el) return;
  $$(".fleet-card", el).forEach((card) => {
    const room = state.fridges.find((f) => f.id === card.dataset.room);
    if (!room) return;
    const st = roomStatus(room);
    card.dataset.level = st.level;
    $("[data-dot]", card).className = "fc-dot " + st.level;
    const tempEl = $("[data-temp]", card);
    tweenNumber(tempEl, st.temp, "°");
    tempEl.style.color = st.temp == null ? "var(--mut)" : cssTempColor(st.temp, state.cfg.color_scale.min, state.cfg.color_scale.max);
    $("[data-sub]", card).textContent = st.sub;
    const rep = st.sensorId && state.latest[st.sensorId];
    $("[data-age]", card).textContent = rep ? fmtAge(Date.now() - rep.time) : "no data";
    const sp = $("[data-spark]", card);
    if (st.sensorId && state.spark.has(st.sensorId)) {
      const s = state.spark.get(st.sensorId);
      drawSpark(sp, s.xs, s.ys, SPARK_COLOR[st.level] || SPARK_COLOR.ok);
    }
    if (st.temp != null) card.classList.remove("is-loading");
  });
  applyFleetFilters();
}

function buildKPIs() {
  const el = $("#kpis"); if (!el) return;
  el.innerHTML = `
    <div class="kpi"><span class="kpi-label">Avg temp</span><span class="kpi-val num" data-k="avg">--.-°</span></div>
    <div class="kpi"><span class="kpi-label">Sensors</span><span class="kpi-val num" data-k="sensors">--</span></div>
    <div class="kpi"><span class="kpi-label">Alarms</span><span class="kpi-val num" data-k="alarms">0</span></div>
    <div class="kpi"><span class="kpi-label">Last sync</span><span class="kpi-val num" data-k="sync">--</span></div>`;
}

function updateKPIs() {
  const avgEl = $('[data-k="avg"]'), snEl = $('[data-k="sensors"]'),
        alEl = $('[data-k="alarms"]'), syEl = $('[data-k="sync"]');
  if (!avgEl) return;
  let sum = 0, n = 0, alarms = 0, offline = 0, last = 0;
  state.fridges.forEach((room) => {
    const th = room.thresholds || state.cfg.thresholds;
    (room.sensors || []).forEach((s) => {
      const r = state.latest[s.id];
      if (!r || !r.time || (Date.now() - r.time) > ((state.cfg && state.cfg.stale_after_s) || 15) * 1000) { offline++; return; }
      if (r.fault || (r.temp != null && r.temp > th.alarm_max)) alarms++;
      if (r.temp != null) { sum += r.temp; n++; }
      if (r.time > last) last = r.time;
    });
  });
  const avg = n ? sum / n : null;
  tweenNumber(avgEl, avg, "°");
  snEl.textContent = String(n + offline);
  alEl.textContent = String(alarms);
  alEl.className = "kpi-val num " + (alarms ? "alarm" : "ok");
  syEl.textContent = last ? fmtAge(Date.now() - last) : "--";
}

async function loadSparks() {
  const ids = [];
  state.fridges.forEach((r) => (r.sensors || []).forEach((s) => ids.push(s.id)));
  if (!ids.length) return;
  try {
    const series = await api(`/api/readings/history?ids=${encodeURIComponent(ids.join(","))}&minutes=30&points=120`);
    Object.entries((series.series) || {}).forEach(([id, rows]) => {
      state.spark.set(id, { xs: rows.map((r) => Math.round(r[0] / 1000)), ys: rows.map((r) => r[1]) });
    });
  } catch (e) { /* offline */ }
  updateFleet();
  updateSidebar();
}

function pushLiveSpark(id, x, y) {
  let s = state.spark.get(id);
  if (!s) { s = { xs: [], ys: [] }; state.spark.set(id, s); }
  s.xs.push(x); s.ys.push(y);
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 60;
  while (s.xs.length && s.xs[0] < cutoff) { s.xs.shift(); s.ys.shift(); }
}

// Per-range result cache: keyed by `${sensorId}|${rangeMin}`. Each range is
// fetched once at full granularity, then reused on toggle (no reload, no DB hit).
async function loadRange(rangeMin, room) {
  const sensors = room.sensors || [];
  const missing = sensors.filter(s => !state.cache.has(`${s.id}|${rangeMin}`));
  if (!missing.length) return;
  try {
    const ids = missing.map(s => s.id).join(",");
    const series = await api(`/api/readings/history?ids=${encodeURIComponent(ids)}&minutes=${rangeMin}&points=120000`);
    Object.entries((series.series) || {}).forEach(([id, rows]) => {
      state.cache.set(`${id}|${rangeMin}`, { xs: rows.map((r) => Math.round(r[0] / 1000)), ys: rows.map((r) => r[1]) });
    });
  } catch (e) { /* keep what we have */ }
}

function pushLiveRange(id, x, y) {
  const key = `${id}|${state.rangeMin}`;
  const c = state.cache.get(key);
  if (!c) return;
  c.xs.push(x); c.ys.push(y);
  const cutoff = Math.floor(Date.now() / 1000) - state.rangeMin * 60;
  while (c.xs.length && c.xs[0] < cutoff) { c.xs.shift(); c.ys.shift(); }
}

function renderView() {
  if (state.manageMode) { renderManage(); return; }
  const fp = $("#fleet-panel"), hs = $("#history");
  if (fp) fp.style.display = "";
  if (hs) hs.style.display = "";
  const room = currentRoom();
  const view = $("#view");
  if (!room) { view.innerHTML = `<div class="panel"><div class="room-head"><div><h2>Select a cold room</h2><p class="cal-note">Choose a room from the sidebar or fleet, or use Manage to add fridges and assign sensors.</p></div></div></div>`; return; }

  view.innerHTML = `
    <div class="panel room-detail">
      <div class="room-head">
        <div>
          <h2>${escapeHtml(room.name)}</h2>
          <p>${escapeHtml(roomDims(room))}</p>
        </div>
        <div class="room-head-actions">
          ${state.selectedSensor ? `<button class="seg-btn" id="open-cal-btn">Calibrate sensor</button>` : ``}
        </div>
      </div>
      <div class="alarm-banner" id="banner"></div>
      <div class="stage">
        <div class="plan-wrap"><canvas class="plan-canvas" id="field"></canvas></div>
        <div class="legend-wrap" aria-label="Temperature range"><span class="num" id="leg-min"></span><canvas id="legend"></canvas><span class="num" id="leg-max"></span></div>
      </div>
      <div class="cal-panel" id="cal-panel"></div>
    </div>`;

  const fc = $("#field");
  state.model = createModel3D(fc);
  fc.addEventListener("click", (e) => {
    const rect = fc.getBoundingClientRect();
    const id = state.model && state.model.pick(e.clientX - rect.left, e.clientY - rect.top);
    if (id) selectSensor(room.id, id);
  });
  const oc = $("#open-cal-btn");
  if (oc) oc.addEventListener("click", () => { state.calOpen = true; renderCalibration(); oc.style.display = "none"; });

  paintField(room);
  renderCalibration();
  buildHistory(room);
}

function renderCalibration() {
  const el = $("#cal-panel"); if (!el) return;
  const room = currentRoom();
  const sid = state.selectedSensor;
  let openBtn = $("#open-cal-btn");
  if (!openBtn && sid && !state.manageMode) {
    const actions = $(".room-head-actions");
    if (actions) {
      openBtn = document.createElement("button");
      openBtn.className = "seg-btn";
      openBtn.id = "open-cal-btn";
      openBtn.textContent = "Calibrate sensor";
      openBtn.addEventListener("click", () => { state.calOpen = true; renderCalibration(); });
      actions.appendChild(openBtn);
    }
  }
  if (openBtn) openBtn.style.display = (!state.calOpen && sid) ? "" : "none";
  if (!state.calOpen || !room || !sid) {
    el.innerHTML = "";
    return;
  }
  const sensor = (room.sensors || []).find(s => s.id === sid);
  const label = sensor ? sensor.label : sid;
  const off = Number(state.calibration[sid] || 0);
  const r = state.latest[sid];
  const raw = r && r.raw_temp != null ? r.raw_temp : (r && r.temp != null ? r.temp - off : null);
  const cal = r && r.temp != null ? r.temp : (raw != null ? raw + off : null);

  el.innerHTML = `
    <div class="cal-card">
      <div class="cal-head">
        <span class="cal-title">Calibration — ${escapeHtml(label)} <span class="cal-id">(${escapeHtml(sid)})</span></span>
        <button class="seg-btn" id="cal-close">Close</button>
      </div>
      <div class="cal-body">
        <div class="cal-readings">
          <div><span class="cal-k">Raw</span> <span class="num" id="cal-raw">${raw == null ? "--.-" : fmt1(raw)}°C</span></div>
          <div><span class="cal-k">Offset</span> <span class="num" id="cal-off">${(off >= 0 ? "+" : "") + off.toFixed(2)}°C</span></div>
          <div><span class="cal-k">Calibrated</span> <span class="num" id="cal-val">${cal == null ? "--.-" : fmt1(cal)}°C</span></div>
        </div>
        <div class="cal-controls">
          <button class="seg-btn" id="cal-minus">−0.1°</button>
          <input id="cal-input" type="number" step="0.1" min="-25" max="25" value="${off.toFixed(2)}" />
          <button class="seg-btn" id="cal-plus">+0.1°</button>
          <button class="seg-btn active" id="cal-save">Apply</button>
          <button class="seg-btn" id="cal-reset">Reset</button>
        </div>
        <p class="cal-note">Offset applies from the moment you save it onward (earlier history is unchanged).</p>
        <p class="cal-msg" id="cal-msg"></p>
      </div>
    </div>`;
  $("#cal-close", el).addEventListener("click", () => {
    state.calOpen = false;
    renderCalibration();
    const oc = $("#open-cal-btn"); if (oc) oc.style.display = "";
  });
  const input = $("#cal-input", el);
  $("#cal-minus", el).addEventListener("click", () => { input.value = (parseFloat(input.value || 0) - 0.1).toFixed(2); });
  $("#cal-plus", el).addEventListener("click", () => { input.value = (parseFloat(input.value || 0) + 0.1).toFixed(2); });
  $("#cal-reset", el).addEventListener("click", () => { input.value = "0.00"; saveCalibration(sid, 0); });
  $("#cal-save", el).addEventListener("click", () => saveCalibration(sid, parseFloat(input.value || 0)));
}

async function saveCalibration(sensorId, offset) {
  const msg = $("#cal-msg");
  if (isNaN(offset)) { if (msg) msg.textContent = "Invalid offset"; return; }
  offset = Math.round(offset * 100) / 100;
  if (offset < -25 || offset > 25) { if (msg) msg.textContent = "Offset must be between -25 and +25"; return; }
  if (msg) msg.textContent = "Saving…";
  try {
    await api("/api/calibration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sensor_id: sensorId, offset }),
    });
    state.calibration[sensorId] = offset;
    // History cache is keyed client-side per range; server recalibrates, so drop and refetch.
    state.cache.clear();
    await updateHistoryRange();
    renderCalibration();
    updateRoomLive();
    if (msg) msg.textContent = `Saved offset ${(offset >= 0 ? "+" : "") + offset.toFixed(2)}°C`;
  } catch (e) {
    if (msg) msg.textContent = "Failed to save offset";
  }
}

function paintField(room) {
  drawLegend($("#legend"), state.cfg.color_scale);
  $("#leg-min").textContent = fmt1(state.cfg.color_scale.min) + "°";
  $("#leg-max").textContent = fmt1(state.cfg.color_scale.max) + "°";
}

function updateRoomLive() {
  if (state.manageMode) return;
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
  updateCalibrationLive();
  updateFleet();
  updateKPIs();
}

function updateCalibrationLive() {
  const sid = state.selectedSensor;
  const panel = $("#cal-panel");
  if (!sid || !panel || !state.calOpen) return;
  const r = state.latest[sid];
  const off = Number(state.calibration[sid] || 0);
  const raw = r && r.raw_temp != null ? r.raw_temp : (r && r.temp != null ? r.temp - off : null);
  const cal = r && r.temp != null ? r.temp : (raw != null ? raw + off : null);
  const rawEl = $("#cal-raw"), valEl = $("#cal-val"), offEl = $("#cal-off");
  if (rawEl) rawEl.textContent = raw == null ? "--.-°C" : fmt1(raw) + "°C";
  if (valEl) valEl.textContent = cal == null ? "--.-°C" : fmt1(cal) + "°C";
  if (offEl) offEl.textContent = (off >= 0 ? "+" : "") + off.toFixed(2) + "°C";
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

  // Fetch this range's data once at full granularity; cached for reuse.
  await loadRange(state.rangeMin, room);

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

    const w = state.cache.get(`${s.id}|${state.rangeMin}`) || { xs: [], ys: [] };
    const host = $("#chart-" + s.id, card);
    const ch = { id: s.id, color: chartCardColor(idx), xs: w.xs, ys: w.ys, el: host, u: null };
    state.charts.set(s.id, ch);
    if (w.xs.length) { host.innerHTML = ""; ch.u = makeChart(host, ch); }
    observeChart(ch);
  });
  updateHistorySelection();
}

async function updateHistoryRange() {
  const room = currentRoom(); if (!room) return;
  await loadRange(state.rangeMin, room);
  state.charts.forEach((ch, id) => {
    const w = state.cache.get(`${id}|${state.rangeMin}`);
    if (!w) return;
    ch.xs = w.xs; ch.ys = w.ys;
    if (ch.u) ch.u.setData([ch.xs, ch.ys], true);
  });
  updateHistorySelection();
}

function heatPlugin(ch) {
  return {
    hooks: {
      draw(u) {
        const ctx = u.ctx;
        const { top, left, width, height } = u.bbox;
        const bot = top + height;
        const xs = ch.xs, ys = ch.ys;
        if (!xs || xs.length < 2) return;
        const cs = state.cfg.color_scale;
        const stride = Math.max(1, Math.floor(xs.length / 2500));

        // Build decimated path points
        const pts = [];
        for (let i = 0; i < xs.length; i += stride) {
          const px = u.valToPos(xs[i], "x", true);
          const py = u.valToPos(ys[i], "y", true);
          if (!isFinite(py) || !isFinite(px)) continue;
          pts.push([px, Math.max(top, Math.min(bot, py)), ys[i]]);
        }
        const last = xs.length - 1;
        if (last % stride !== 0) {
          const px = u.valToPos(xs[last], "x", true);
          const py = u.valToPos(ys[last], "y", true);
          if (isFinite(py) && isFinite(px)) pts.push([px, Math.max(top, Math.min(bot, py)), ys[last]]);
        }
        if (pts.length < 2) return;

        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, width, height);
        ctx.clip();

        // Soft temperature-tinted fill (vertical gradient per y-position, low alpha)
        const fillGrad = ctx.createLinearGradient(0, top, 0, bot);
        const stops = [];
        for (const [, py, tv] of pts) {
          let off = (py - top) / height;
          off = Math.max(0, Math.min(1, off));
          stops.push([off, tempRGBA(tv, 0.22)]);
        }
        stops.push([0, tempRGBA(cs.max, cs.min, cs.max, 0.18)]);
        stops.push([1, tempRGBA(cs.min, cs.min, cs.max, 0.02)]);
        stops.sort((a, b) => a[0] - b[0]);
        let lastOff = -1;
        for (const [off, col] of stops) {
          if (Math.abs(off - lastOff) < 1e-4) continue;
          fillGrad.addColorStop(off, col);
          lastOff = off;
        }

        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.lineTo(pts[pts.length - 1][0], bot);
        ctx.lineTo(pts[0][0], bot);
        ctx.closePath();
        ctx.fillStyle = fillGrad;
        ctx.fill();

        // Crisp line on top
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        // stroke with temp-aware gradient along x for subtle color meaning
        const lineGrad = ctx.createLinearGradient(pts[0][0], 0, pts[pts.length - 1][0], 0);
        for (let i = 0; i < pts.length; i++) {
          const p = i / (pts.length - 1);
          lineGrad.addColorStop(p, tempColor(pts[i][2], cs.min, cs.max));
        }
        ctx.strokeStyle = lineGrad;
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();

        ctx.restore();
      }
    }
  };
}

function bandPlugin(th) {
  return {
    hooks: {
      draw(u) {
        const ctx = u.ctx;
        const { top, left, width, height } = u.bbox;
        const bot = top + height;
        const yOf = (v) => Math.max(top, Math.min(bot, u.valToPos(v, "y", true)));
        ctx.save();
        // danger zone above alarm
        if (th.alarm_max != null) {
          const ya = yOf(th.alarm_max);
          const g = ctx.createLinearGradient(0, top, 0, ya);
          g.addColorStop(0, "rgba(248,113,113,0.10)");
          g.addColorStop(1, "rgba(248,113,113,0.03)");
          ctx.fillStyle = g;
          ctx.fillRect(left, top, width, Math.max(0, ya - top));
        }
        // warn band
        if (th.warn_max != null && th.alarm_max != null) {
          const ya = yOf(th.alarm_max), yw = yOf(th.warn_max);
          ctx.fillStyle = "rgba(251,191,36,0.05)";
          ctx.fillRect(left, ya, width, Math.max(0, yw - ya));
        }
        // target comfort band
        if (th.target_min != null && th.target_max != null) {
          const ytx = yOf(th.target_max), ytm = yOf(th.target_min);
          if (ytx < ytm) {
            ctx.fillStyle = "rgba(52,211,153,0.07)";
            ctx.fillRect(left, ytx, width, ytm - ytx);
          }
        }
        ctx.restore();
      }
    }
  };
}

function thresholdPlugin(th) {
  return {
    hooks: {
      draw(u) {
        const ctx = u.ctx;
        const { left, width, top, height } = u.bbox;
        const bot = top + height;
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1;
        const lines = [
          [th.target_min, "rgba(52,211,153,0.45)"],
          [th.target_max, "rgba(45,212,191,0.40)"],
          [th.warn_max, "rgba(251,191,36,0.35)"],
          [th.alarm_max, "rgba(248,113,113,0.35)"],
        ];
        for (const [v, col] of lines) {
          if (v == null) continue;
          const y = u.valToPos(v, "y", true);
          if (y < top || y > bot) continue;
          ctx.strokeStyle = col;
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(left + width, y);
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
  const cs = state.cfg.color_scale;
  const t0 = ch.ys[ch.ys.length - 1];
  const lineCol = (t0 != null) ? tempColor(t0, cs.min, cs.max) : "var(--accent)";
  const opts = {
    width: Math.max(host.clientWidth || 480, 220),
    height: 300,
    padding: [16, 16, 8, 8],
    cursor: {
      points: { size: 7, width: 2, stroke: "#e9eef5", fill: "#161d28" },
      drag: { x: true, y: false },
    },
    legend: { show: false },
    scales: {
      x: { time: true },
      y: { auto: true, range: (u, min, max) => {
        if (!isFinite(min) || !isFinite(max)) return [cs.min, cs.max];
        const pad = Math.max(0.5, (max - min) * 0.15);
        return [Math.floor((min - pad) * 2) / 2, Math.ceil((max + pad) * 2) / 2];
      }},
    },
    axes: [
      {
        stroke: AXIS,
        grid: { stroke: GRID, width: 1 },
        ticks: { stroke: TICK, width: 1, size: 4 },
        font: FONT,
        gap: 8,
        values: (u, splits) => splits.map(s => {
          const d = new Date(s * 1000);
          return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }),
      },
      {
        stroke: AXIS,
        grid: { stroke: GRID, width: 1 },
        ticks: { stroke: TICK, width: 1, size: 4 },
        font: FONT,
        size: 46,
        gap: 6,
        values: (u, splits) => splits.map(v => v.toFixed(1) + "°"),
      },
    ],
    series: [
      {},
      { stroke: "rgba(0,0,0,0)", width: 2, fill: false, spanGaps: false, points: { show: false } },
    ],
    plugins: [bandPlugin(th), heatPlugin(ch), thresholdPlugin(th)],
  };
  const tip = document.createElement("div");
  tip.className = "u-tooltip";
  tip.style.borderLeftColor = lineCol;
  tip.style.display = "none";
  host.appendChild(tip);
  const fmtTipTime = (x) => new Date(x * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  opts.hooks = {
    setCursor: [(u) => {
      const idx = u.cursor.idx;
      if (idx == null) { tip.style.display = "none"; return; }
      const x = u.data[0][idx], y = u.data[1][idx];
      if (y == null) { tip.style.display = "none"; return; }
      tip.innerHTML = `<b>${fmt1(y)}°C</b><span>${fmtTipTime(x)}</span>`;
      tip.style.display = "block";
      tip.style.borderLeftColor = tempColor(y, cs.min, cs.max);
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
  ch.u.setSize({ width: w, height: 300 });
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
      tweenNumber(tEl, stale ? null : r.temp, "°");
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
  state.latest[s.sensor_id] = {
    temp: s.temp,
    raw_temp: s.raw_temp,
    resistance: s.resistance,
    fault: s.fault,
    time: Date.now(),
  };
  if (s.offset != null) state.calibration[s.sensor_id] = Number(s.offset);
  queueLive(s.sensor_id, Date.now(), s.temp);
  pushLiveSpark(s.sensor_id, Math.round(Date.now() / 1000), s.temp);
  pushLiveRange(s.sensor_id, Math.round(Date.now() / 1000), s.temp);
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
        state.latest[id] = { temp: v.temp, raw_temp: v.raw_temp, resistance: v.resistance, fault: v.fault, time: t };
      }
    });
    if (now - state.lastNet > 4000) setConn("ok");
    state.lastNet = now;
    updateRoomLive();
  } catch (e) {
    if (now - state.lastNet > 8000) setConn("down");
  }
}

function applyConfig(data) {
  state.rawConfig = JSON.parse(JSON.stringify(data || {}));
  state.fridges = ((data && data.rooms) || []).map(r => ({
    ...r,
    thresholds: {
      target_min: r.thresholds && r.thresholds.target_min,
      target_max: r.thresholds && r.thresholds.target_max,
      warn_max: r.thresholds && r.thresholds.warn,
      alarm_max: r.thresholds && r.thresholds.alarm,
    },
  }));
  state.cfg = {
    color_scale: (data && data.color_scale) || { min: -50, max: 20 },
    stale_after_s: (data && data.stale_after_s) || 15,
    thresholds: null,
  };
}


// ---------------- room/sensor management ----------------
if (!state.mgOpen) state.mgOpen = new Set(); // room ids open in manage

function defaultRoom(i) {
  const n = i || ((state.rawConfig && state.rawConfig.rooms && state.rawConfig.rooms.length) || 0) + 1;
  return {
    id: `chiller-${n}`,
    name: `Chiller ${n}`,
    zone: "zone_a",
    type: "chiller",
    dims_m: { length: 8.0, width: 4.5, height: 2.25 },
    thresholds: { target_min: 0.0, target_max: 4.0, warn: 6.0, alarm: 8.0 },
    door: { x_m: 0.6, width_m: 1.4 },
    sensors: []
  };
}

function nextSensorPos(room) {
  const n = (room.sensors || []).length;
  const l = (room.dims_m && room.dims_m.length) || 8;
  const w = (room.dims_m && room.dims_m.width) || 4.5;
  const h = (room.dims_m && room.dims_m.height) || 2.25;
  return { x_m: Math.min(l - 0.5, 1.5 + n * 2), y_m: +(w / 2).toFixed(2), z_m: +(h - 0.25).toFixed(2) };
}

async function toggleManage() {
  state.manageMode = !state.manageMode;
  const btn = $("#manage-btn");
  if (btn) btn.textContent = state.manageMode ? "Back" : "Manage";
  const fp = $("#fleet-panel"), hs = $("#history");
  if (fp) fp.style.display = state.manageMode ? "none" : "";
  if (hs) hs.style.display = state.manageMode ? "none" : "";
  if (!state.manageMode) {
    renderView();
    updateRoomLive();
    return;
  }
  try {
    const k = await api("/api/sensors/known");
    state.knownSensors = k.sensors || [];
  } catch (e) { state.knownSensors = []; }
  // open all rooms on first open for discoverability if few; otherwise keep state
  if (!state.mgOpen) state.mgOpen = new Set();
  if (state.mgOpen.size === 0 && state.rawConfig && (state.rawConfig.rooms||[]).length <= 3) {
    (state.rawConfig.rooms||[]).forEach(r => r.id && state.mgOpen.add(r.id));
  }
  renderManage();
}

function captureManageOpen() {
  $$(".mg-room[data-rid]").forEach(el => {
    const rid = el.dataset.rid;
    const body = $(".mg-room-body", el);
    if (!body) return;
    if (body.classList.contains("open")) state.mgOpen.add(rid);
    else state.mgOpen.delete(rid);
  });
}

function renderManage() {
  destroyCharts();
  const view = $("#view");
  const cfg = state.rawConfig || { color_scale: {min:-50,max:20}, stale_after_s: 15, rooms: [] };
  const rooms = cfg.rooms || [];
  const assigned = new Set();
  rooms.forEach(r => (r.sensors || []).forEach(s => s.id && assigned.add(s.id)));
  const known = Array.from(new Set([...(state.knownSensors||[]), ...assigned])).sort();

  const roomsHtml = rooms.map((room, ri) => {
    const sensors = room.sensors || [];
    const th = room.thresholds || { target_min:0,target_max:4,warn:6,alarm:8 };
    const rid = room.id || `room-${ri}`;
    const isOpen = state.mgOpen.has(rid);

    const sensRows = sensors.map((s, si) => `
      <div class="mg-sensor-card" data-ri="${ri}" data-si="${si}">
        <div class="mg-sensor-main">
          <div class="mg-sensor-idline">
            <span class="mg-sid" title="${escapeHtml(s.id)}">${escapeHtml(s.id)}</span>
          </div>
          <label class="mg-field mg-field-grow"><span>Label</span><input class="mg-in" data-f="label" value="${escapeHtml(s.label || s.id)}" placeholder="Label"></label>
          <button class="seg-btn mg-rm-sensor" data-ri="${ri}" data-si="${si}" title="Remove sensor">Remove</button>
        </div>
        <details class="mg-sensor-pos">
          <summary>Position (m)</summary>
          <div class="mg-pos-grid">
            <label class="mg-field"><span>X</span><input class="mg-in mg-num" data-f="x_m" type="number" step="0.1" value="${s.x_m ?? 2}"></label>
            <label class="mg-field"><span>Y</span><input class="mg-in mg-num" data-f="y_m" type="number" step="0.1" value="${s.y_m ?? 2}"></label>
            <label class="mg-field"><span>Z</span><input class="mg-in mg-num" data-f="z_m" type="number" step="0.1" value="${s.z_m ?? 2}"></label>
          </div>
        </details>
      </div>`).join("");

    const avail = known.filter(id => !assigned.has(id));
    const addOpts = avail.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");
    const addSensor = avail.length
      ? `<div class="mg-add-sensor">
           <select id="add-sel-${ri}" class="mg-select"><option value="">Select a sensor to assign…</option>${addOpts}</select>
           <button class="seg-btn mg-add-sensor-btn" data-ri="${ri}">Assign</button>
         </div>`
      : `<div class="mg-add-sensor mg-add-sensor-manual">
           <span class="mg-hint">No unassigned sensors discovered yet. Sensors appear here when they publish data, or add by ID.</span>
           <div class="mg-add-row">
             <input id="add-manual-${ri}" placeholder="Sensor ID" class="mg-in mg-select">
             <button class="seg-btn mg-add-manual-btn" data-ri="${ri}">Add by ID</button>
           </div>
         </div>`;

    return `
      <div class="mg-room ${isOpen ? "is-open" : ""}" data-ri="${ri}" data-rid="${escapeHtml(rid)}">
        <div class="mg-room-head mg-room-toggle" data-ri="${ri}">
          <div class="mg-room-title">
            <button class="mg-caret" type="button" aria-label="Toggle">${isOpen ? "▾" : "▸"}</button>
            <div>
              <div class="mg-room-name">${escapeHtml(room.name || room.id || "Unnamed fridge")}</div>
              <div class="mg-room-meta"><span class="mg-badge">${escapeHtml(room.zone||"")}</span><span class="mg-badge">${escapeHtml(room.type||"chiller")}</span><span class="mg-badge mg-badge-count">${sensors.length} sensor${sensors.length===1?"":"s"}</span></div>
            </div>
          </div>
          <button class="seg-btn danger mg-del-room" data-ri="${ri}" title="Delete fridge">Delete</button>
        </div>
        <div class="mg-room-body ${isOpen ? "open" : ""}">
          <div class="mg-section">
            <div class="mg-section-title">Details</div>
            <div class="mg-grid mg-grid-4">
              <label class="mg-field"><span>Name</span><input class="mg-in mg-room-f" data-ri="${ri}" data-f="name" value="${escapeHtml(room.name||"")}"></label>
              <label class="mg-field"><span>ID</span><input class="mg-in mg-room-f" data-ri="${ri}" data-f="id" value="${escapeHtml(room.id||"")}"></label>
              <label class="mg-field"><span>Zone</span><input class="mg-in mg-room-f" data-ri="${ri}" data-f="zone" value="${escapeHtml(room.zone||"zone_a")}"></label>
              <label class="mg-field"><span>Type</span><input class="mg-in mg-room-f" data-ri="${ri}" data-f="type" value="${escapeHtml(room.type||"chiller")}"></label>
            </div>
          </div>

          <details class="mg-details">
            <summary>Dimensions & thresholds</summary>
            <div class="mg-details-body">
              <div class="mg-subsection-title">Dimensions (m)</div>
              <div class="mg-grid mg-grid-3">
                <label class="mg-field"><span>Length</span><input class="mg-in mg-num mg-dim" data-ri="${ri}" data-f="length" type="number" step="0.1" value="${room.dims_m?.length ?? 8}"></label>
                <label class="mg-field"><span>Width</span><input class="mg-in mg-num mg-dim" data-ri="${ri}" data-f="width" type="number" step="0.1" value="${room.dims_m?.width ?? 4.5}"></label>
                <label class="mg-field"><span>Height</span><input class="mg-in mg-num mg-dim" data-ri="${ri}" data-f="height" type="number" step="0.1" value="${room.dims_m?.height ?? 2.25}"></label>
              </div>
              <div class="mg-subsection-title">Thresholds (°C)</div>
              <div class="mg-grid mg-grid-4">
                <label class="mg-field"><span>Target min</span><input class="mg-in mg-num mg-th" data-ri="${ri}" data-f="target_min" type="number" step="0.1" value="${th.target_min ?? 0}"></label>
                <label class="mg-field"><span>Target max</span><input class="mg-in mg-num mg-th" data-ri="${ri}" data-f="target_max" type="number" step="0.1" value="${th.target_max ?? 4}"></label>
                <label class="mg-field"><span>Warn</span><input class="mg-in mg-num mg-th" data-ri="${ri}" data-f="warn" type="number" step="0.1" value="${th.warn ?? 6}"></label>
                <label class="mg-field"><span>Alarm</span><input class="mg-in mg-num mg-th" data-ri="${ri}" data-f="alarm" type="number" step="0.1" value="${th.alarm ?? 8}"></label>
              </div>
            </div>
          </details>

          <div class="mg-section mg-sensors-section">
            <div class="mg-section-title-row">
              <div class="mg-section-title">Sensors</div>
              <span class="mg-muted">${sensors.length} assigned</span>
            </div>
            <div class="mg-sensor-list">
              ${sensRows || `<div class="mg-empty">No sensors assigned yet.</div>`}
            </div>
            ${addSensor}
          </div>
        </div>
      </div>`;
  }).join("");

  view.innerHTML = `
    <div class="mg-wrap">
      <div class="mg-top">
        <div>
          <h2>Manage fridges & sensors</h2>
          <p class="mg-hint">Add fridges and assign sensors. Expand a fridge to edit details. Advanced settings and sensor positions are tucked away to keep things clear.</p>
        </div>
        <div class="mg-actions">
          <button class="seg-btn" id="mg-add-room">+ Add fridge</button>
          <button class="seg-btn" id="mg-refresh-known">Refresh sensors</button>
          <button class="seg-btn active" id="mg-save">Save changes</button>
          <button class="seg-btn" id="mg-cancel">Back</button>
        </div>
      </div>
      <div id="mg-msg" class="cal-msg"></div>
      <div class="mg-rooms">${roomsHtml || `<div class="cal-empty">No fridges yet. Click “+ Add fridge” to get started.</div>`}</div>
      <details class="mg-known-details">
        <summary>Known sensors (${known.length})</summary>
        <div class="mg-known-list">${known.length ? known.map(id => `<span class="mg-badge">${escapeHtml(id)}</span>`).join(" ") : `<span class="mg-hint">None yet — waiting for telemetry.</span>`}</div>
      </details>
    </div>`;

  wireManageEvents();
}

function readManageIntoConfig() {
  const cfg = state.rawConfig || { color_scale:{min:-50,max:20}, stale_after_s:15, rooms:[] };
  $$(".mg-room-f").forEach(inp => {
    const ri = +inp.dataset.ri, f = inp.dataset.f;
    if (cfg.rooms[ri]) cfg.rooms[ri][f] = inp.value.trim();
  });
  $$(".mg-dim").forEach(inp => {
    const ri = +inp.dataset.ri, f = inp.dataset.f;
    if (!cfg.rooms[ri]) return;
    cfg.rooms[ri].dims_m = cfg.rooms[ri].dims_m || {};
    cfg.rooms[ri].dims_m[f] = parseFloat(inp.value);
  });
  $$(".mg-th").forEach(inp => {
    const ri = +inp.dataset.ri, f = inp.dataset.f;
    if (!cfg.rooms[ri]) return;
    cfg.rooms[ri].thresholds = cfg.rooms[ri].thresholds || {};
    cfg.rooms[ri].thresholds[f] = parseFloat(inp.value);
  });
  $$(".mg-sensor-card").forEach(row => {
    const ri = +row.dataset.ri, si = +row.dataset.si;
    const room = cfg.rooms[ri]; if (!room || !room.sensors || !room.sensors[si]) return;
    const s = room.sensors[si];
    $$("input.mg-in", row).forEach(inp => {
      const f = inp.dataset.f;
      if (["x_m","y_m","z_m"].includes(f)) s[f] = parseFloat(inp.value);
      else if (f) s[f] = inp.value.trim();
    });
  });
  return cfg;
}

function wireManageEvents() {
  $("#mg-add-room")?.addEventListener("click", () => {
    const cfg = readManageIntoConfig();
    captureManageOpen();
    cfg.rooms = cfg.rooms || [];
    const r = defaultRoom(cfg.rooms.length + 1);
    const ids = new Set(cfg.rooms.map(x => x.id));
    let k = cfg.rooms.length + 1;
    while (ids.has(r.id)) { k++; r.id = `chiller-${k}`; r.name = `Chiller ${k}`; }
    cfg.rooms.push(r);
    state.mgOpen.add(r.id);
    state.rawConfig = cfg;
    renderManage();
  });
  $("#mg-refresh-known")?.addEventListener("click", async () => {
    const cfg = readManageIntoConfig(); captureManageOpen(); state.rawConfig = cfg;
    try { const k = await api("/api/sensors/known"); state.knownSensors = k.sensors || []; } catch(e){}
    renderManage();
  });
  $("#mg-cancel")?.addEventListener("click", () => toggleManage());
  $("#mg-save")?.addEventListener("click", saveManageConfig);

  $$(".mg-room-toggle").forEach(head => head.addEventListener("click", (e) => {
    if (e.target.closest(".mg-del-room")) return;
    const roomEl = head.closest(".mg-room");
    const rid = roomEl?.dataset.rid;
    const body = $(".mg-room-body", roomEl);
    if (!body) return;
    readManageIntoConfig();
    captureManageOpen();
    const nowOpen = !body.classList.contains("open");
    if (rid) { if (nowOpen) state.mgOpen.add(rid); else state.mgOpen.delete(rid); }
    body.classList.toggle("open", nowOpen);
    roomEl.classList.toggle("is-open", nowOpen);
    const caret = $(".mg-caret", head); if (caret) caret.textContent = nowOpen ? "▾" : "▸";
  }));

  $$(".mg-del-room").forEach(b => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const cfg = readManageIntoConfig();
    captureManageOpen();
    const removed = cfg.rooms[+b.dataset.ri];
    if (removed && removed.id) state.mgOpen.delete(removed.id);
    cfg.rooms.splice(+b.dataset.ri, 1);
    state.rawConfig = cfg;
    renderManage();
  }));
  $$(".mg-rm-sensor").forEach(b => b.addEventListener("click", () => {
    const cfg = readManageIntoConfig(); captureManageOpen();
    const room = cfg.rooms[+b.dataset.ri];
    if (room && room.sensors) room.sensors.splice(+b.dataset.si, 1);
    state.rawConfig = cfg;
    renderManage();
  }));
  $$(".mg-add-sensor-btn").forEach(b => b.addEventListener("click", () => {
    const ri = +b.dataset.ri;
    const sel = $(`#add-sel-${ri}`);
    const sid = sel && sel.value;
    if (!sid) return;
    const cfg = readManageIntoConfig(); captureManageOpen();
    if ((cfg.rooms || []).some(r => (r.sensors || []).some(s => s.id === sid))) return;
    const room = cfg.rooms[ri]; if (!room) return;
    room.sensors = room.sensors || [];
    const pos = nextSensorPos(room);
    room.sensors.push({ id: sid, label: sid, ...pos });
    state.rawConfig = cfg;
    renderManage();
  }));
  $$(".mg-add-manual-btn").forEach(b => b.addEventListener("click", () => {
    const ri = +b.dataset.ri;
    const inp = $(`#add-manual-${ri}`);
    const sid = inp && inp.value.trim();
    if (!sid) return;
    const cfg = readManageIntoConfig(); captureManageOpen();
    if ((cfg.rooms || []).some(r => (r.sensors || []).some(s => s.id === sid))) return;
    const room = cfg.rooms[ri]; if (!room) return;
    room.sensors = room.sensors || [];
    const pos = nextSensorPos(room);
    room.sensors.push({ id: sid, label: sid, ...pos });
    state.rawConfig = cfg;
    renderManage();
  }));
}

async function saveManageConfig() {
  const msg = $("#mg-msg");
  const cfg = readManageIntoConfig();
  // basic client validation
  const ids = new Set();
  for (const r of (cfg.rooms||[])) {
    if (!r.id || !String(r.id).trim()) { if(msg) msg.textContent = "Every fridge needs an ID"; return; }
    for (const s of (r.sensors||[])) {
      if (!s.id) { if(msg) msg.textContent = "Every sensor needs an ID"; return; }
      if (ids.has(s.id)) { if(msg) msg.textContent = `Sensor ${s.id} assigned more than once`; return; }
      ids.add(s.id);
    }
  }
  if (msg) msg.textContent = "Saving…";
  try {
    const saved = await api("/api/fridges", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    applyConfig(saved);
    state.cache.clear();
    state.manageMode = false;
    const btn = $("#manage-btn"); if (btn) btn.textContent = "Manage";
    if (!state.selectedRoom && state.fridges[0]) state.selectedRoom = state.fridges[0].id;
    if (state.selectedRoom && !state.fridges.find(f=>f.id===state.selectedRoom)) state.selectedRoom = state.fridges[0]?.id || null;
    buildSidebar();
    buildKPIs();
    renderView();
    buildFleet();
    loadSparks();
  } catch (e) {
    if (msg) msg.textContent = "Save failed: " + (e && e.message ? e.message : e);
  }
}

async function boot() {
  try {
    const st = await api("/api/auth/status");
    state.authRequired = !!st.auth_required;
    state.authenticated = !!st.authenticated;
  } catch (e) { /* ignore */ }
  try {
    const data = await api("/api/fridges");
    applyConfig(data);
  } catch (e) {
    applyConfig({ color_scale: { min: -50, max: 20 }, stale_after_s: 15, rooms: [] });
  }
  try {
    const cal = await api("/api/calibration");
    state.calibration = cal.offsets || {};
  } catch (e) { state.calibration = {}; }
  buildSidebar();
  buildKPIs();
  if (!state.selectedRoom && state.fridges[0]) state.selectedRoom = state.fridges[0].id;
  renderView();
  buildFleet();
  loadSparks();
  updateKPIs();
  const mb = $("#manage-btn");
  if (mb) mb.addEventListener("click", () => toggleManage());
  const rs = $("#range-seg");
  if (rs) rs.addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn"); if (!b) return;
    state.rangeMin = Number(b.dataset.min);
    $$("#range-seg .seg-btn").forEach(x => x.classList.toggle("active", x === b));
    updateHistoryRange();
  });
  const rsearch = $("#room-search");
  if (rsearch) rsearch.addEventListener("input", () => { state.roomQuery = rsearch.value; buildSidebar(); });
  const fsearch = $("#fleet-search");
  if (fsearch) fsearch.addEventListener("input", () => { state.fleetQuery = fsearch.value; applyFleetFilters(); });
  const fchips = $("#fleet-filters");
  if (fchips) fchips.addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    state.fleetFilter = b.dataset.filter || "all";
    $$(".chip", fchips).forEach(x => x.classList.toggle("active", x === b));
    applyFleetFilters();
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
