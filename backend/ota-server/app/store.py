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


def _table_info(c, name):
    return c.execute(f"PRAGMA table_info({name})").fetchall()


def _pk_columns(c, name):
    rows = [r for r in _table_info(c, name) if r[5]]
    return [r[1] for r in sorted(rows, key=lambda r: r[5])]


def _migrate_firmware(c):
    """Add hardware-target awareness to the firmware/device tables.

    Firmware rows are keyed by (version, hw) so an ESP32 build and a Pico W
    build can share a version number without ever being served to the wrong
    board. Rows created before this migration are treated as ESP32 images,
    which is what every build published so far was.
    """
    cols = [r[1] for r in _table_info(c, "firmware")]
    if cols and ("hw" not in cols or _pk_columns(c, "firmware") != ["version", "hw"]):
        c.executescript(
            """
            ALTER TABLE firmware RENAME TO firmware_legacy;
            CREATE TABLE firmware (
                version  TEXT NOT NULL,
                hw       TEXT NOT NULL DEFAULT 'esp32',
                grp      TEXT NOT NULL,
                sha256   TEXT NOT NULL,
                size     INTEGER NOT NULL,
                filename TEXT NOT NULL,
                created  TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (version, hw)
            );
            INSERT INTO firmware(version, hw, grp, sha256, size, filename, created)
                SELECT version, 'esp32', grp, sha256, size, filename, created
                FROM firmware_legacy;
            DROP TABLE firmware_legacy;
            """
        )
    dcols = [r[1] for r in _table_info(c, "devices")]
    if dcols and "hw" not in dcols:
        c.execute("ALTER TABLE devices ADD COLUMN hw TEXT")


def init_db():
    c = _conn()
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS firmware (
            version  TEXT NOT NULL,
            hw       TEXT NOT NULL DEFAULT 'esp32',
            grp      TEXT NOT NULL,
            sha256   TEXT NOT NULL,
            size     INTEGER NOT NULL,
            filename TEXT NOT NULL,
            created  TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (version, hw)
        );
        CREATE TABLE IF NOT EXISTS devices (
            device_id  TEXT PRIMARY KEY,
            grp        TEXT,
            version    TEXT,
            hw         TEXT,
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
    _migrate_firmware(c)
    c.commit()
    c.close()


def add_firmware(version, grp, sha256, size, filename, hw="pico-w"):
    c = _conn()
    c.execute(
        """INSERT INTO firmware(version, hw, grp, sha256, size, filename, created)
           VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
           ON CONFLICT(version, hw) DO UPDATE SET
             grp=excluded.grp,
             sha256=excluded.sha256,
             size=excluded.size,
             filename=excluded.filename,
             created=CURRENT_TIMESTAMP""",
        (version, hw, grp, sha256, size, filename),
    )
    c.commit()
    c.close()


def get_firmware(version, hw=None):
    c = _conn()
    if hw:
        r = c.execute(
            "SELECT * FROM firmware WHERE version=? AND hw=?", (version, hw)
        ).fetchone()
    else:
        # Legacy callers do not know about hw targets: prefer Pico W (the
        # current hardware) instead of picking an arbitrary board's build.
        r = c.execute(
            "SELECT * FROM firmware WHERE version=? ORDER BY (hw='pico-w') DESC, created DESC",
            (version,),
        ).fetchone()
    c.close()
    return dict(r) if r else None


def list_firmware():
    c = _conn()
    rows = c.execute(
        "SELECT version, hw, grp, sha256, size, filename, created "
        "FROM firmware ORDER BY created DESC, version DESC"
    ).fetchall()
    c.close()
    return [dict(r) for r in rows]


def latest_for_group(grp, current, hw="pico-w"):
    """Newest firmware for this group that actually runs on `hw`.

    Cross-board delivery is the one mistake that can brick a unit, so the
    filter is strict: only images tagged with the same hardware are eligible.
    """
    c = _conn()
    rows = c.execute(
        "SELECT * FROM firmware WHERE (grp=? OR grp='all') AND hw=?",
        (grp, hw),
    ).fetchall()
    c.close()
    best = None
    try:
        cur = semver.parse(current) if current else semver.parse("0.0.0")
    except Exception:
        # A malformed version from a device must not 500 the manifest; treat
        # it as the oldest version so the device is still offered the newest
        # image for its board.
        cur = semver.parse("0.0.0")
    for r in rows:
        try:
            if semver.parse(r["version"]) > cur and (
                best is None or semver.parse(r["version"]) > semver.parse(best["version"])
            ):
                best = dict(r)
        except Exception:
            pass
    return best


def upsert_device(device_id, grp, ver, state, hw=None):
    c = _conn()
    c.execute(
        """INSERT INTO devices(device_id, grp, version, hw, last_seen, last_state)
           VALUES(?,?,?,?,CURRENT_TIMESTAMP,?)
           ON CONFLICT(device_id) DO UPDATE SET
             grp=COALESCE(excluded.grp, grp),
             version=COALESCE(excluded.version, version),
             hw=COALESCE(excluded.hw, hw),
             last_seen=CURRENT_TIMESTAMP,
             last_state=excluded.last_state""",
        (device_id, grp, ver, hw, state),
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
