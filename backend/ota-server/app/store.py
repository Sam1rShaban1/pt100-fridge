import sqlite3
import os
from packaging import version as semver

DB_PATH = os.environ.get("OTA_DB", "/data/ota.db")


def _conn():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


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
        """
    )
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
