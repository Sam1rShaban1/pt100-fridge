import sqlite3
import os
import json
import time
from packaging import version as semver

DB_PATH = os.environ.get("OTA_DB", "/data/ota.db")


def _conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def _migrate_calibration(c):
    """Migrate calibration from single-row-per-sensor to time-ranged history."""
    cols = [r[1] for r in c.execute("PRAGMA table_info(calibration)").fetchall()]
    if not cols:
        c.execute(
            """
            CREATE TABLE calibration (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sensor_id TEXT NOT NULL,
                offset REAL NOT NULL,
                effective_from INTEGER NOT NULL
            )
            """
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_cal_sensor_time ON calibration(sensor_id, effective_from)")
        return
    if "effective_from" in cols:
        c.execute("CREATE INDEX IF NOT EXISTS idx_cal_sensor_time ON calibration(sensor_id, effective_from)")
        return
    # Old schema: (sensor_id PK, offset, updated) -> migrate
    rows = c.execute("SELECT sensor_id, offset, updated FROM calibration").fetchall()
    c.execute("ALTER TABLE calibration RENAME TO calibration_old")
    c.execute(
        """
        CREATE TABLE calibration (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sensor_id TEXT NOT NULL,
            offset REAL NOT NULL,
            effective_from INTEGER NOT NULL
        )
        """
    )
    c.execute("CREATE INDEX IF NOT EXISTS idx_cal_sensor_time ON calibration(sensor_id, effective_from)")
    for r in rows:
        # Preserve existing behavior: treat prior calibrations as effective from epoch 0
        # so historical data remains calibrated as before.
        c.execute(
            "INSERT INTO calibration(sensor_id, offset, effective_from) VALUES(?,?,0)",
            (r["sensor_id"], float(r["offset"])),
        )
    c.execute("DROP TABLE calibration_old")


def init_db():
    c = _conn()
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS firmware (
            version  TEXT PRIMARY KEY,
            grp      TEXT NOT NULL,
            sha256   TEXT NOT NULL,
            size     INTEGER NOT NULL,
            filename TEXT NOT NULL,
            created  TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS devices (
            device_id  TEXT PRIMARY KEY,
            grp        TEXT,
            version    TEXT,
            last_seen  TEXT,
            last_state TEXT
        );
        CREATE TABLE IF NOT EXISTS app_config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS known_sensors (
            sensor_id TEXT PRIMARY KEY,
            last_seen TEXT DEFAULT CURRENT_TIMESTAMP
        );
        """
    )
    # calibration may exist in old or new form; handle separately
    _migrate_calibration(c)
    c.commit()
    c.close()


def add_firmware(version, grp, sha256, size, filename):
    c = _conn()
    c.execute(
        "INSERT OR REPLACE INTO firmware(version, grp, sha256, size, filename) VALUES(?,?,?,?,?)",
        (version, grp, sha256, size, filename),
    )
    c.commit()
    c.close()


def get_firmware(version):
    c = _conn()
    r = c.execute("SELECT * FROM firmware WHERE version=?", (version,)).fetchone()
    c.close()
    return dict(r) if r else None


def latest_for_group(grp, current):
    c = _conn()
    rows = c.execute(
        "SELECT * FROM firmware WHERE grp=? OR grp='all'", (grp,)
    ).fetchall()
    c.close()
    best = None
    cur = semver.parse(current) if current else semver.parse("0.0.0")
    for r in rows:
        try:
            if semver.parse(r["version"]) > cur and (
                best is None or semver.parse(r["version"]) > semver.parse(best["version"])
            ):
                best = dict(r)
        except Exception:
            pass
    return best


def upsert_device(device_id, grp, ver, state):
    c = _conn()
    c.execute(
        """INSERT INTO devices(device_id, grp, version, last_seen, last_state)
           VALUES(?,?,?,CURRENT_TIMESTAMP,?)
           ON CONFLICT(device_id) DO UPDATE SET
             grp=COALESCE(excluded.grp, grp),
             version=COALESCE(excluded.version, version),
             last_seen=CURRENT_TIMESTAMP,
             last_state=excluded.last_state""",
        (device_id, grp, ver, state),
    )
    c.commit()
    c.close()


def get_all_devices():
    c = _conn()
    rows = c.execute("SELECT * FROM devices").fetchall()
    c.close()
    return [dict(r) for r in rows]


# ---- calibration offsets (time-ranged) ----

def get_current_offsets():
    """Return {sensor_id: current_offset} based on latest effective calibration."""
    c = _conn()
    rows = c.execute(
        """
        SELECT c.sensor_id, c.offset
        FROM calibration c
        JOIN (SELECT sensor_id, MAX(effective_from) AS m FROM calibration GROUP BY sensor_id) x
          ON c.sensor_id = x.sensor_id AND c.effective_from = x.m
        """
    ).fetchall()
    c.close()
    return {r["sensor_id"]: float(r["offset"]) for r in rows}


def get_calibration_timelines(sensor_ids):
    """Return {sensor_id: [(effective_from_ms, offset), ...]} sorted ascending."""
    if not sensor_ids:
        return {}
    c = _conn()
    q = "SELECT sensor_id, effective_from, offset FROM calibration WHERE sensor_id IN ({}) ORDER BY sensor_id, effective_from ASC".format(
        ",".join("?" for _ in sensor_ids)
    )
    rows = c.execute(q, list(sensor_ids)).fetchall()
    c.close()
    out = {}
    for r in rows:
        out.setdefault(r["sensor_id"], []).append((int(r["effective_from"]), float(r["offset"])))
    return out


def get_offsets():
    """Compatibility alias: current offsets."""
    return get_current_offsets()


def set_offset(sensor_id, offset, effective_from_ms=None):
    """Record a calibration change effective from a point in time.

    Offsets apply from effective_from_ms onward; earlier readings keep their
    previous calibration. effective_from_ms defaults to now.
    """
    if effective_from_ms is None:
        effective_from_ms = int(time.time() * 1000)
    c = _conn()
    c.execute(
        "INSERT INTO calibration(sensor_id, offset, effective_from) VALUES(?,?,?)",
        (sensor_id, float(offset), int(effective_from_ms)),
    )
    c.commit()
    c.close()


# ---- dynamic fridges/rooms config ----

def get_config(key):
    c = _conn()
    r = c.execute("SELECT value FROM app_config WHERE key=?", (key,)).fetchone()
    c.close()
    if not r:
        return None
    try:
        return json.loads(r["value"])
    except Exception:
        return None


def set_config(key, value):
    c = _conn()
    c.execute(
        "INSERT OR REPLACE INTO app_config(key, value) VALUES(?,?)",
        (key, json.dumps(value)),
    )
    c.commit()
    c.close()


# ---- known sensors ----

def mark_sensor_seen(sensor_id):
    c = _conn()
    c.execute(
        """INSERT INTO known_sensors(sensor_id, last_seen)
           VALUES(?, CURRENT_TIMESTAMP)
           ON CONFLICT(sensor_id) DO UPDATE SET last_seen=CURRENT_TIMESTAMP""",
        (sensor_id,),
    )
    c.commit()
    c.close()


def get_known_sensors():
    c = _conn()
    rows = c.execute(
        "SELECT sensor_id, last_seen FROM known_sensors ORDER BY last_seen DESC"
    ).fetchall()
    c.close()
    return [dict(r) for r in rows]
