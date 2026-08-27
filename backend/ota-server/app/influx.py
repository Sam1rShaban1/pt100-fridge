"""Minimal InfluxDB 3 Core client over its HTTP query API (stdlib only).

InfluxDB 3 runs with --without-auth in this stack, so the token header is
optional; it is sent when INFLUX_TOKEN is set for forward compatibility.
"""
import os
import json
import urllib.request
from datetime import datetime

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


def query_latest(sensor_ids, window_minutes=10):
    """Latest reading per sensor id -> {sid: {temp, resistance, fault, time_ms}}.

    Sensors with nothing inside the window are simply absent.
    """
    if not sensor_ids:
        return {}
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
            out[sid] = {
                "temp": row.get("temp"),
                "resistance": row.get("resistance"),
                "fault": row.get("fault"),
                "time": _ms(row.get("time")),
            }
    return out


def query_history(sensor_ids, minutes=60, points=60000):
    """Temperature series at (near) raw DB granularity -> {sid: [[ms, temp], ...]}.

    Returns real stored samples up to RAW_LIMIT per sensor. For short windows
    this is exactly the DB resolution; for very long windows it is capped so
    payloads stay reasonable. The `points` argument is only a ceiling.
    """
    RAW_LIMIT = max(1000, min(int(points), 120000))
    series = {}
    mins = max(1, int(minutes))
    for sid in sensor_ids:
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
            arr.append([ts, round(float(t), 2)])
        series[sid] = arr
    return series
