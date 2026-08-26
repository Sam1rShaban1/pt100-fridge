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


def query_history(sensor_ids, minutes=60, points=90):
    """Downsampled temperature series -> {sid: [[ms, temp], ...]}.

    Uses date_bin when available and falls back to a raw capped query so the
    endpoint still works on builds without date_bin.
    """
    series = {}
    mins = max(1, int(minutes))
    pts = max(10, min(int(points), 400))
    bin_secs = max(int(mins * 60 / pts), 1)
    for sid in sensor_ids:
        sql = (
            f"SELECT date_bin(INTERVAL '{bin_secs} seconds', time) AS bucket, "
            f"avg(temp) AS temp FROM pt100 "
            f"WHERE sensor_id = {_quote(sid)} "
            f"AND time >= now() - INTERVAL '{mins} minutes' "
            f"GROUP BY bucket ORDER BY bucket"
        )
        arr = []
        try:
            rows = _query(sql)
        except Exception:
            # Fallback: raw points capped, bucketed here.
            sql = (
                f"SELECT time, temp FROM pt100 "
                f"WHERE sensor_id = {_quote(sid)} "
                f"AND time >= now() - INTERVAL '{mins} minutes' "
                f"ORDER BY time ASC LIMIT 5000"
            )
            try:
                rows = _query(sql)
            except Exception:
                series[sid] = []
                continue
            step = max(1, len(rows) // pts)
            rows = rows[::step]
        for row in rows:
            t = row.get("temp")
            ts = _ms(row.get("bucket") or row.get("time"))
            if t is None or ts is None:
                continue
            arr.append([ts, round(float(t), 2)])
        series[sid] = arr
    return series
