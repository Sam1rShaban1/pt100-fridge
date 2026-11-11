"""Minimal InfluxDB 3 Core client over its HTTP query API (stdlib only).

InfluxDB 3 runs with --without-auth in this stack, so the token header is
optional; it is sent when INFLUX_TOKEN is set for forward compatibility.
"""
import os
import json
import urllib.request
from datetime import datetime
from bisect import bisect_right

URL = os.environ.get("INFLUX_URL", "http://influxdb3:8181").rstrip("/")
DB = os.environ.get("INFLUX_DB", "pt100")
TOKEN = os.environ.get("INFLUX_TOKEN", "")


def _quote(s):
    return "'" + str(s).replace("'", "''") + "'"


def _ms(t):
    """Normalize a timestamp cell to epoch milliseconds."""
    if t is None:
        return None
    if isinstance(t, (int, float)):
        if t > 1e14:  # nanoseconds
            return int(t / 1e6)
        if t > 1e11:  # microseconds
            return int(t / 1e3)
        return int(t * 1000) if t < 1e11 else int(t)  # seconds / already ms
    try:
        dt = datetime.fromisoformat(str(t).replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


def _query(sql):
    body = json.dumps({"db": DB, "q": sql, "format": "json"}).encode()
    req = urllib.request.Request(
        URL + "/api/v3/query_sql",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    if TOKEN:
        req.add_header("Authorization", "Bearer " + TOKEN)
    with urllib.request.urlopen(req, timeout=10) as r:
        payload = json.loads(r.read().decode())
    # InfluxDB 3 Core returns a bare array of row objects for format=json.
    if isinstance(payload, list):
        return payload
    rows = []
    for table in payload.get("tables", []):
        recs = table.get("records")
        if recs is not None:
            rows.extend(recs)
            continue
        cols = [c.get("name") if isinstance(c, dict) else c
                for c in table.get("columns", [])]
        rows.extend(dict(zip(cols, row)) for row in table.get("data", []))
    return rows


def _apply(raw, offset):
    if raw is None:
        return None
    try:
        return round(float(raw) + float(offset), 2)
    except Exception:
        return raw


def _normalize_cal(cal, sensor_ids):
    """Return {sid: (times[], offsets[])} for fast per-point lookup.
    Accepts either timelines {sid:[(t,off),...]} or flat {sid:off}."""
    out = {}
    if not cal:
        cal = {}
    for sid in sensor_ids:
        v = cal.get(sid)
        if v is None:
            out[sid] = ([], [])
        elif isinstance(v, list):
            out[sid] = ([int(t) for t, _ in v], [float(o) for _, o in v])
        else:
            # flat current offset -> effective from -inf
            out[sid] = ([ -10**18 ], [float(v)])
    return out


def _offset_at(norm, sid, ts_ms):
    times, offs = norm.get(sid, ([], []))
    if not times:
        return 0.0
    i = bisect_right(times, int(ts_ms)) - 1
    return offs[i] if i >= 0 else 0.0


def query_latest(sensor_ids, window_minutes=10, offsets=None, calibration=None):
    """Latest reading per sensor id -> {sid: {temp, raw_temp, resistance, fault, time}}.

    `temp` is calibrated (raw + offset effective at reading time). `raw_temp`
    is the value stored in InfluxDB. `calibration` may be timelines or flat map.
    """
    if not sensor_ids:
        return {}
    cal = calibration if calibration is not None else offsets
    norm = _normalize_cal(cal, sensor_ids)
    ids = "(" + ",".join(_quote(s) for s in sensor_ids) + ")"
    sql = (
        f"SELECT sensor_id, temp, resistance, fault, time FROM pt100 "
        f"WHERE sensor_id IN {ids} "
        f"AND time >= now() - INTERVAL '{int(window_minutes)} minutes' "
        f"ORDER BY time DESC"
    )
    out = {}
    try:
        rows = _query(sql)
    except Exception:
        return out
    for row in rows:
        sid = row.get("sensor_id")
        if sid and sid not in out:
            raw = row.get("temp")
            ts = _ms(row.get("time"))
            off = _offset_at(norm, sid, ts if ts is not None else 0)
            out[sid] = {
                "temp": _apply(raw, off),
                "raw_temp": raw,
                "resistance": row.get("resistance"),
                "fault": row.get("fault"),
                "time": ts,
            }
    return out


def query_history(sensor_ids, minutes=60, points=60000, offsets=None, calibration=None):
    """Calibrated temperature series -> {sid: [[ms, temp], ...]}.

    Raw readings stored in InfluxDB; calibration offsets applied per-point
    based on effective time, so past data keeps its historical calibration.
    """
    RAW_LIMIT = max(1000, min(int(points), 120000))
    cal = calibration if calibration is not None else offsets
    norm = _normalize_cal(cal, sensor_ids)
    series = {}
    mins = max(1, int(minutes))
    for sid in sensor_ids:
        times, offs = norm.get(sid, ([], []))
        sql = (
            f"SELECT time, temp FROM pt100 "
            f"WHERE sensor_id = {_quote(sid)} "
            f"AND time >= now() - INTERVAL '{mins} minutes' "
            f"ORDER BY time ASC LIMIT {RAW_LIMIT}"
        )
        arr = []
        try:
            rows = _query(sql)
        except Exception:
            series[sid] = []
            continue
        for row in rows:
            t = row.get("temp")
            ts = _ms(row.get("time"))
            if t is None or ts is None:
                continue
            i = bisect_right(times, int(ts)) - 1
            off = offs[i] if i >= 0 else 0.0
            arr.append([ts, round(float(t) + float(off), 2)])
        series[sid] = arr
    return series
