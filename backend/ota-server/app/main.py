import os
import json
import time
import asyncio
import hashlib
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


# ---------------- auth & mqtt ----------------
def _authed(req: Request) -> bool:
    if not ADMIN_TOKEN:
        return True
    a = req.headers.get("Authorization", "")
    if a.startswith("Bearer "):
        return a[7:] == ADMIN_TOKEN
    return req.query_params.get("token") == ADMIN_TOKEN


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


def load_rooms():
    """Read fridges.json on every call so edits apply without a restart."""
    try:
        return json.loads(FRIDGES_CONFIG.read_text())
    except Exception:
        return {"color_scale": {"min": -25, "max": 25}, "stale_after_s": 15, "rooms": []}


def _room_sensor_ids(cfg):
    ids = []
    for room in cfg.get("rooms", []):
        for s in room.get("sensors", []):
            if s.get("id"):
                ids.append(s["id"])
    return ids


@app.get("/api/fridges")
def fridges():
    return load_rooms()


@app.get("/api/readings/latest")
def readings_latest():
    cfg = load_rooms()
    return {"readings": query_latest(_room_sensor_ids(cfg))}


@app.get("/api/readings/history")
def readings_history(sensors: str = "", minutes: int = 60, points: int = 90):
    ids = [s.strip() for s in sensors.split(",") if s.strip()]
    if not ids:
        ids = _room_sensor_ids(load_rooms())
    return {"series": query_history(ids, minutes, points)}


# ---------------- live stream (SSE) ----------------
_sse_clients = set()
_sse_loop = None


def _q_put(q, item):
    if q.qsize() < 200:
        q.put_nowait(item)


def _on_pt100(topic: str, payload: bytes):
    sid = topic.split("/")[-1]
    try:
        data = json.loads(payload)
    except Exception:
        return
    evt = {
        "sensor_id": sid,
        "temp": data.get("temp"),
        "resistance": data.get("resistance"),
        "fault": data.get("fault"),
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
