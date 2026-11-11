import os
import json
import time
import asyncio
import hashlib
import hmac
import secrets
import threading
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, Request, HTTPException, Response
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import uvicorn

from app.store import (
    init_db,
    add_firmware,
    get_firmware,
    latest_for_group,
    upsert_device,
    get_all_devices,
    get_offsets,
    get_current_offsets,
    get_calibration_timelines,
    set_offset,
    get_config,
    set_config,
    mark_sensor_seen,
    get_known_sensors,
)
from app.influx import query_latest, query_history
from app.mqtt_client import init as mqtt_init, publish

FIRMWARE_DIR = Path(os.environ.get("FIRMWARE_DIR", "/data/firmware"))
FIRMWARE_DIR.mkdir(parents=True, exist_ok=True)
PUBLIC_BASE = os.environ.get("PUBLIC_BASE_URL", "https://ota.example.com").rstrip("/")
ADMIN_TOKEN = os.environ.get("OTA_ADMIN_TOKEN", "")
DEVICE_GROUPS = json.loads(os.environ.get("DEVICE_GROUPS", "{}"))

# group -> rollout state
rollout_state = {}
rollout_lock = threading.Lock()

app = FastAPI(title="PT100 Fridge OTA Server")
init_db()

# Calibration offsets: time-ranged (effective-from timestamps).
# Raw readings are preserved in InfluxDB; calibrated = raw + offset active at reading time.
_cal_lock = threading.Lock()
_calibration = get_current_offsets()  # current offset per sensor (for live/latest)
_cal_version = 0  # bumped on every offset change to invalidate history cache


def _get_cal():
    with _cal_lock:
        return dict(_calibration), _cal_version


def _set_cal(sensor_id, offset):
    global _cal_version
    # Effective from now: prior history keeps its previous calibration.
    set_offset(sensor_id, offset)
    cur = get_current_offsets()
    with _cal_lock:
        _calibration.clear()
        _calibration.update(cur)
        _cal_version += 1
        _history_cache.clear()


# ---------------- auth & mqtt ----------------
_SESSION_TTL = 60 * 60 * 12  # 12 hours
_SESSION_COOKIE = "ota_session"
_sessions = {}
_sessions_lock = threading.Lock()


def _session_ok(req: Request) -> bool:
    sid = req.cookies.get(_SESSION_COOKIE)
    if not sid:
        return False
    now = time.time()
    with _sessions_lock:
        exp = _sessions.get(sid)
        if not exp:
            return False
        if exp < now:
            _sessions.pop(sid, None)
            return False
        return True


def _authed(req: Request) -> bool:
    if not ADMIN_TOKEN:
        return True
    # Session cookie (dashboard login)
    if _session_ok(req):
        return True
    # Bearer token (programmatic/API clients)
    a = req.headers.get("Authorization", "")
    if a.startswith("Bearer "):
        token = a[7:]
        return hmac.compare_digest(token, ADMIN_TOKEN)
    # Query token fallback for programmatic access
    qt = req.query_params.get("token")
    if qt:
        return hmac.compare_digest(qt, ADMIN_TOKEN)
    return False


def _cookie_secure(req: Request) -> bool:
    proto = req.headers.get("x-forwarded-proto", req.url.scheme).split(",")[0].strip().lower()
    return proto == "https"


def _on_mqtt(topic: str, payload: bytes):
    parts = topic.split("/")
    if len(parts) != 3:
        return
    device_id, kind = parts[1], parts[2]
    try:
        data = json.loads(payload)
    except Exception:
        data = {}
    grp = data.get("group")
    ver = data.get("version")
    if kind == "hello":
        upsert_device(device_id, grp, ver, "online")
    elif kind == "status":
        upsert_device(device_id, grp, ver, data.get("state"))
        _handle_status(device_id, data.get("state"))


def _handle_status(device_id, state):
    with rollout_lock:
        for grp, st in list(rollout_state.items()):
            if device_id not in st["pending"]:
                continue
            if state == "success":
                st["pending"].discard(device_id)
                st["success"].add(device_id)
                _promote(grp, st)
            elif state == "failed":
                st["pending"].discard(device_id)
                st["failed"].add(device_id)
                if st["phase"] == "canary":
                    st["phase"] = "aborted"


def _promote(grp, st):
    if st["phase"] != "canary" or st["pending"]:
        return
    if st["failed"]:
        st["phase"] = "aborted"
        return
    st["phase"] = "full"
    fw = get_firmware(st["version"])
    if not fw:
        st["phase"] = "aborted"
        return
    payload = json.dumps(
        {
            "version": fw["version"],
            "url": f"{PUBLIC_BASE}/firmware/{fw['filename']}",
            "sha256": fw["sha256"],
            "size": fw["size"],
        }
    )
    for d in st["rest"]:
        publish(f"ota/{d}/update", payload)


def _watchdog(grp):
    with rollout_lock:
        st = rollout_state.get(grp)
        if st and st["phase"] == "canary" and st["pending"]:
            st["phase"] = "aborted"  # canary timed out; do not promote


def start_rollout(version, group, canary):
    fw = get_firmware(version)
    if not fw:
        raise HTTPException(404, "version not found")
    devices = DEVICE_GROUPS.get(group, [])
    if not devices:
        raise HTTPException(400, f"unknown group '{group}' or no devices configured")
    canary = max(1, min(int(canary), len(devices)))
    canary_ids = devices[:canary]
    rest_ids = devices[canary:]
    payload = json.dumps(
        {
            "version": fw["version"],
            "url": f"{PUBLIC_BASE}/firmware/{fw['filename']}",
            "sha256": fw["sha256"],
            "size": fw["size"],
        }
    )
    with rollout_lock:
        rollout_state[group] = {
            "version": version,
            "phase": "canary",
            "pending": set(canary_ids),
            "success": set(),
            "failed": set(),
            "rest": rest_ids,
        }
    for d in canary_ids:
        publish(f"ota/{d}/update", payload)
    threading.Timer(300, _watchdog, args=(group,)).start()
    return {
        "group": group,
        "phase": "canary",
        "targets": canary_ids,
        "remaining": len(rest_ids),
    }


# ---------------- sensor data API ----------------
FRIDGES_CONFIG = Path(
    os.environ.get(
        "FRIDGES_CONFIG",
        str(Path(__file__).parent.parent / "fridges.json"),
    )
)

_default_cfg = {"color_scale": {"min": -50, "max": 20}, "stale_after_s": 15, "rooms": []}


def _load_file_config():
    try:
        return json.loads(FRIDGES_CONFIG.read_text())
    except Exception:
        return dict(_default_cfg)


def load_rooms():
    """Return fridge/room config. DB-backed (dynamic, editable from frontend);
    seeded from fridges.json on first run for backward compatibility."""
    cfg = get_config("fridges")
    if cfg and isinstance(cfg, dict) and "rooms" in cfg:
        return cfg
    cfg = _load_file_config()
    try:
        set_config("fridges", cfg)
    except Exception:
        pass
    return cfg


def _room_sensor_ids(cfg):
    ids = []
    for room in cfg.get("rooms", []):
        for s in room.get("sensors", []):
            if s.get("id"):
                ids.append(s["id"])
    return ids


def _validate_fridges_config(cfg):
    if not isinstance(cfg, dict):
        raise HTTPException(400, "config must be an object")
    rooms = cfg.get("rooms")
    if not isinstance(rooms, list):
        raise HTTPException(400, "rooms must be a list")
    seen_room = set()
    seen_sensor = set()
    for i, room in enumerate(rooms):
        if not isinstance(room, dict):
            raise HTTPException(400, f"room[{i}] must be an object")
        rid = str(room.get("id", "")).strip()
        if not rid:
            raise HTTPException(400, f"room[{i}] missing id")
        if rid in seen_room:
            raise HTTPException(400, f"duplicate room id '{rid}'")
        seen_room.add(rid)
        sensors = room.get("sensors", [])
        if sensors is None:
            room["sensors"] = sensors = []
        if not isinstance(sensors, list):
            raise HTTPException(400, f"room '{rid}' sensors must be a list")
        for j, s in enumerate(sensors):
            if not isinstance(s, dict):
                raise HTTPException(400, f"room '{rid}' sensor[{j}] must be an object")
            sid = str(s.get("id", "")).strip()
            if not sid:
                raise HTTPException(400, f"room '{rid}' sensor[{j}] missing id")
            if sid in seen_sensor:
                raise HTTPException(400, f"sensor '{sid}' assigned to more than one room")
            seen_sensor.add(sid)
    if "color_scale" not in cfg or not isinstance(cfg.get("color_scale"), dict):
        cfg["color_scale"] = dict(_default_cfg["color_scale"])
    if "stale_after_s" not in cfg:
        cfg["stale_after_s"] = _default_cfg["stale_after_s"]
    return cfg


@app.get("/api/fridges")
def fridges():
    return load_rooms()


@app.put("/api/fridges")
async def fridges_save(req: Request):
    if not _authed(req):
        raise HTTPException(401, "unauthorized")
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(400, "invalid JSON")
    cfg = _validate_fridges_config(body)
    set_config("fridges", cfg)
    # Ensure assigned sensors are tracked as known
    for sid in _room_sensor_ids(cfg):
        try:
            mark_sensor_seen(sid)
        except Exception:
            pass
    with _history_lock:
        _history_cache.clear()
    return cfg


@app.get("/api/sensors/known")
def sensors_known():
    """Known sensor IDs (seen via MQTT telemetry) merged with assigned sensors."""
    cfg = load_rooms()
    seen = {r["sensor_id"] for r in get_known_sensors()}
    for sid in _room_sensor_ids(cfg):
        seen.add(sid)
    # Also include any sensors with calibration offsets
    for sid in get_offsets().keys():
        seen.add(sid)
    return {"sensors": sorted(seen)}


@app.get("/api/readings/latest")
def readings_latest():
    cfg = load_rooms()
    sids = _room_sensor_ids(cfg)
    timelines = get_calibration_timelines(sids)
    return {"readings": query_latest(sids, calibration=timelines)}


# In-memory (memcached-style) cache for history queries so range toggles and
# reloads don't hammer InfluxDB on every request.
_history_cache = {}
_history_lock = threading.Lock()
_HISTORY_TTL = 4.0

def _history_cache_get(key):
    with _history_lock:
        item = _history_cache.get(key)
        if item and (time.time() - item[1]) < _HISTORY_TTL:
            return item[0]
        return None

def _history_cache_put(key, val):
    with _history_lock:
        _history_cache[key] = (val, time.time())

@app.get("/api/readings/history")
def readings_history(sensors: str = "", ids: str = "", minutes: int = 60, points: int = 90):
    raw = sensors or ids
    ids = [s.strip() for s in raw.split(",") if s.strip()]
    if not ids:
        ids = _room_sensor_ids(load_rooms())
    _, cal_ver = _get_cal()
    key = (tuple(sorted(ids)), minutes, points, cal_ver)
    cached = _history_cache_get(key)
    if cached is not None:
        return {"series": cached, "cached": True}
    timelines = get_calibration_timelines(ids)
    series = query_history(ids, minutes, points, calibration=timelines)
    _history_cache_put(key, series)
    return {"series": series}


@app.get("/api/client-config")
def client_config():
    """Non-secret config for the dashboard frontend."""
    return {"auth_required": bool(ADMIN_TOKEN)}


@app.post("/api/auth/login")
async def auth_login(req: Request, response: Response):
    if not ADMIN_TOKEN:
        return {"ok": True, "auth_required": False}
    try:
        body = await req.json()
    except Exception:
        body = {}
    token = str(body.get("token", ""))
    if not token or not hmac.compare_digest(token, ADMIN_TOKEN):
        raise HTTPException(401, "invalid token")
    sid = secrets.token_urlsafe(32)
    with _sessions_lock:
        _sessions[sid] = time.time() + _SESSION_TTL
    response.set_cookie(
        _SESSION_COOKIE,
        sid,
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(req),
        path="/",
        max_age=_SESSION_TTL,
    )
    return {"ok": True}


@app.post("/api/auth/logout")
async def auth_logout(req: Request, response: Response):
    sid = req.cookies.get(_SESSION_COOKIE)
    if sid:
        with _sessions_lock:
            _sessions.pop(sid, None)
    response.delete_cookie(_SESSION_COOKIE, path="/", samesite="lax", secure=_cookie_secure(req))
    return {"ok": True}


@app.get("/api/auth/status")
def auth_status(req: Request):
    return {"authenticated": _authed(req), "auth_required": bool(ADMIN_TOKEN)}


@app.get("/api/calibration")
def calibration_get():
    cal, _ = _get_cal()
    return {"offsets": cal}


@app.post("/api/calibration")
async def calibration_set(req: Request, payload: dict):
    if not _authed(req):
        raise HTTPException(401, "unauthorized")
    sensor_id = str(payload.get("sensor_id", "")).strip()
    if not sensor_id:
        raise HTTPException(400, "sensor_id required")
    try:
        offset = float(payload.get("offset", 0.0))
    except Exception:
        raise HTTPException(400, "offset must be a number")
    if offset < -25.0 or offset > 25.0:
        raise HTTPException(400, "offset must be between -25 and +25")
    # Normalize tiny floats to 0
    if abs(offset) < 1e-9:
        offset = 0.0
    _set_cal(sensor_id, offset)
    return {"sensor_id": sensor_id, "offset": offset}


# ---------------- live stream (SSE) ----------------
_sse_clients = set()
_sse_loop = None


def _q_put(q, item):
    if q.qsize() < 200:
        q.put_nowait(item)


_seen_sensors = set()
_seen_lock = threading.Lock()


def _on_pt100(topic: str, payload: bytes):
    sid = topic.split("/")[-1]
    if sid:
        with _seen_lock:
            first = sid not in _seen_sensors
            if first:
                _seen_sensors.add(sid)
        if first:
            try:
                mark_sensor_seen(sid)
            except Exception:
                pass
    try:
        data = json.loads(payload)
    except Exception:
        return
    raw = data.get("temp")
    cal, _ = _get_cal()
    off = float(cal.get(sid, 0.0))
    try:
        temp = round(float(raw) + off, 2) if raw is not None else None
    except Exception:
        temp = raw
    evt = {
        "sensor_id": sid,
        "temp": temp,
        "raw_temp": raw,
        "resistance": data.get("resistance"),
        "fault": data.get("fault"),
        "offset": off,
        "time": int(time.time() * 1000),
    }
    if _sse_loop is None:
        return
    for q in tuple(_sse_clients):
        try:
            _sse_loop.call_soon_threadsafe(_q_put, q, evt)
        except RuntimeError:
            pass


mqtt_init(_on_mqtt, _on_pt100)


@app.get("/api/stream")
async def stream(req: Request):
    global _sse_loop
    _sse_loop = asyncio.get_running_loop()
    q = asyncio.Queue(maxsize=200)
    _sse_clients.add(q)

    async def gen():
        try:
            yield "retry: 3000\n\n"
            while True:
                if await req.is_disconnected():
                    break
                try:
                    evt = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(evt)}\n\n"
        finally:
            _sse_clients.discard(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------- endpoints ----------------
@app.get("/", response_class=HTMLResponse)
def index():
    return (Path(__file__).parent.parent / "static" / "index.html").read_text()


@app.post("/api/firmware")
async def upload_firmware(
    req: Request,
    file: UploadFile = File(...),
    group: str = Form("all"),
    version: str = Form(""),
):
    if not _authed(req):
        raise HTTPException(401, "unauthorized")
    fname = version or (file.filename or "firmware.bin")
    if not fname.endswith(".bin"):
        fname += ".bin"
    ver = version or fname[:-4]
    data = await file.read()
    sha = hashlib.sha256(data).hexdigest()
    (FIRMWARE_DIR / fname).write_bytes(data)
    add_firmware(ver, group, sha, len(data), fname)
    return {"version": ver, "group": group, "sha256": sha, "size": len(data), "filename": fname}


@app.get("/api/firmware/manifest")
def manifest(device_id: str, group: str, current: str = ""):
    best = latest_for_group(group, current)
    if not best:
        return Response(status_code=204)
    return {
        "version": best["version"],
        "url": f"{PUBLIC_BASE}/firmware/{best['filename']}",
        "sha256": best["sha256"],
        "size": best["size"],
    }


@app.post("/api/rollout")
async def rollout(req: Request, payload: dict):
    if not _authed(req):
        raise HTTPException(401, "unauthorized")
    return start_rollout(payload["version"], payload["group"], payload.get("canary", 1))


@app.get("/api/rollout")
def rollout_status():
    with rollout_lock:
        return {
            g: {
                "phase": s["phase"],
                "version": s["version"],
                "pending": list(s["pending"]),
                "success": list(s["success"]),
                "failed": list(s["failed"]),
                "remaining": len(s["rest"]),
            }
            for g, s in rollout_state.items()
        }


@app.get("/api/devices")
def devices():
    return get_all_devices()


app.mount(
    "/firmware",
    StaticFiles(directory=str(FIRMWARE_DIR), check_dir=False),
    name="firmware",
)

_DASHBOARD_DIR = Path(__file__).parent.parent / "static" / "app"
app.mount(
    "/app",
    StaticFiles(directory=str(_DASHBOARD_DIR), html=True),
    name="dashboard",
)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
