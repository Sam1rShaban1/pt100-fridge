"""Calibration correctness tests.

The requirement is strict: raw readings are stored untouched, calibration
offsets are applied per reading *from the moment they were set*, and earlier
history keeps whatever offset was active at that time. Getting this wrong
shows operators the wrong temperature, so it is tested directly against the
query functions with a stubbed InfluxDB.

Run from backend/ota-server:

    python -m unittest discover -s tests -v
"""

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_TMPDIR = tempfile.mkdtemp(prefix="ota-cal-")
os.environ.setdefault("OTA_DB", str(Path(_TMPDIR) / "bootstrap.db"))

from app import influx, store  # noqa: E402

T = 1_700_000_000_000  # a fixed epoch in milliseconds


class TimestampTests(unittest.TestCase):
    def test_converts_every_epoch_unit(self):
        self.assertEqual(influx._ms(1_700_000_000), T)          # seconds
        self.assertEqual(influx._ms(T), T)                       # milliseconds
        self.assertEqual(influx._ms(T * 1000), T)                # microseconds
        self.assertEqual(influx._ms(T * 1_000_000), T)           # nanoseconds
        self.assertEqual(influx._ms(float(T)), T)

    def test_converts_iso_strings(self):
        self.assertEqual(influx._ms("2023-11-14T22:13:20Z"), T)
        self.assertEqual(influx._ms("2023-11-14T22:13:20+00:00"), T)

    def test_invalid_timestamps_are_none(self):
        self.assertIsNone(influx._ms(None))
        self.assertIsNone(influx._ms("not-a-date"))
        self.assertIsNone(influx._ms(""))


class OffsetSelectionTests(unittest.TestCase):
    def test_offset_applies_from_effective_time_onward(self):
        norm = influx._normalize_cal({"s1": [(T, 1.5)]}, ["s1"])
        self.assertEqual(influx._offset_at(norm, "s1", T - 1), 0.0)
        self.assertEqual(influx._offset_at(norm, "s1", T), 1.5)
        self.assertEqual(influx._offset_at(norm, "s1", T + 10**6), 1.5)

    def test_latest_offset_wins_in_its_range(self):
        norm = influx._normalize_cal(
            {"s1": [(T, 1.0), (T + 1000, -0.5)]}, ["s1"]
        )
        self.assertEqual(influx._offset_at(norm, "s1", T - 1), 0.0)
        self.assertEqual(influx._offset_at(norm, "s1", T), 1.0)
        self.assertEqual(influx._offset_at(norm, "s1", T + 999), 1.0)
        self.assertEqual(influx._offset_at(norm, "s1", T + 1000), -0.5)

    def test_unsorted_timeline_is_sorted(self):
        norm = influx._normalize_cal(
            {"s1": [(T + 1000, 2.0), (T, 1.0)]}, ["s1"]
        )
        self.assertEqual(influx._offset_at(norm, "s1", T + 500), 1.0)
        self.assertEqual(influx._offset_at(norm, "s1", T + 1500), 2.0)

    def test_unknown_sensor_has_no_offset(self):
        norm = influx._normalize_cal({}, ["s1"])
        self.assertEqual(influx._offset_at(norm, "s1", T), 0.0)

    def test_flat_legacy_offset_applies_to_all_history(self):
        norm = influx._normalize_cal({"s1": 2.5}, ["s1"])
        self.assertEqual(influx._offset_at(norm, "s1", 0), 2.5)
        self.assertEqual(influx._offset_at(norm, "s1", T), 2.5)


class QueryTests(unittest.TestCase):
    def setUp(self):
        self.rows = []
        self._real_query = influx._query
        influx._query = self.fake_query

    def tearDown(self):
        influx._query = self._real_query

    def fake_query(self, sql):
        return list(self.rows)

    def test_history_applies_offsets_only_after_calibration(self):
        self.rows = [
            {"time": T - 2000, "temp": 10.0},
            {"time": T - 1000, "temp": 10.0},
            {"time": T, "temp": 10.0},
            {"time": T + 1000, "temp": 10.0},
        ]
        series = influx.query_history(
            ["s1"], minutes=60, points=100,
            calibration={"s1": [(T, 1.5)]},
        )
        self.assertEqual(
            series["s1"],
            [[T - 2000, 10.0], [T - 1000, 10.0], [T, 11.5], [T + 1000, 11.5]],
        )

    def test_history_with_successive_calibrations(self):
        self.rows = [
            {"time": T, "temp": 10.0},
            {"time": T + 1000, "temp": 10.0},
            {"time": T + 2000, "temp": 10.0},
        ]
        series = influx.query_history(
            ["s1"], calibration={"s1": [(T + 1000, 1.0), (T + 2000, -0.5)]}
        )
        self.assertEqual(
            series["s1"],
            [[T, 10.0], [T + 1000, 11.0], [T + 2000, 9.5]],
        )

    def test_history_accepts_iso_timestamps(self):
        self.rows = [{"time": "2023-11-14T22:13:20Z", "temp": 4.0}]
        series = influx.query_history(["s1"], calibration={"s1": [(T, 1.0)]})
        self.assertEqual(series["s1"], [[T, 5.0]])

    def test_history_skips_rows_without_temp(self):
        self.rows = [
            {"time": T, "temp": None},
            {"time": T + 1, "temp": 3.0},
            {"time": "bad", "temp": 9.0},
        ]
        series = influx.query_history(["s1"])
        self.assertEqual(series["s1"], [[T + 1, 3.0]])

    def test_history_query_failure_yields_empty_series(self):
        def boom(sql):
            raise OSError("influx down")

        influx._query = boom
        self.assertEqual(influx.query_history(["s1"]), {"s1": []})

    def test_history_rounds_to_two_decimals(self):
        self.rows = [{"time": T, "temp": 10.111}]
        series = influx.query_history(["s1"], calibration={"s1": [(T, 0.222)]})
        self.assertEqual(series["s1"], [[T, 10.33]])

    def test_latest_keeps_raw_and_applies_offset(self):
        self.rows = [
            {"sensor_id": "s1", "temp": 10.0, "resistance": 103.9, "fault": 0,
             "time": T + 1000},
            {"sensor_id": "s1", "temp": 9.0, "resistance": 103.5, "fault": 0,
             "time": T},
        ]
        out = influx.query_latest(["s1"], calibration={"s1": [(T, 1.5)]})
        self.assertEqual(out["s1"]["raw_temp"], 10.0)
        self.assertEqual(out["s1"]["temp"], 11.5)
        self.assertEqual(out["s1"]["resistance"], 103.9)
        self.assertEqual(out["s1"]["time"], T + 1000)

    def test_latest_ignores_offset_set_after_reading(self):
        self.rows = [
            {"sensor_id": "s1", "temp": 10.0, "resistance": 103.9, "fault": 0,
             "time": T},
        ]
        out = influx.query_latest(["s1"], calibration={"s1": [(T + 1000, 5.0)]})
        self.assertEqual(out["s1"]["temp"], 10.0)
        self.assertEqual(out["s1"]["raw_temp"], 10.0)

    def test_latest_one_row_per_sensor(self):
        self.rows = [
            {"sensor_id": "s1", "temp": 1.0, "resistance": 100.0, "fault": 0,
             "time": T + 2},
            {"sensor_id": "s1", "temp": 2.0, "resistance": 101.0, "fault": 0,
             "time": T + 1},
            {"sensor_id": "s2", "temp": 3.0, "resistance": 102.0, "fault": 1,
             "time": T},
        ]
        out = influx.query_latest(["s1", "s2"])
        self.assertEqual(out["s1"]["raw_temp"], 1.0)
        self.assertEqual(out["s2"]["raw_temp"], 3.0)


class CalibrationStoreTests(unittest.TestCase):
    def setUp(self):
        self.db = Path(tempfile.mkdtemp(prefix="ota-cal-db-")) / "ota.db"
        store.DB_PATH = str(self.db)
        store.init_db()

    def test_timelines_are_sorted_and_current_is_latest(self):
        store.set_offset("s1", 1.0, T + 1000)
        store.set_offset("s1", -0.5, T)
        store.set_offset("s2", 2.0, T)
        self.assertEqual(
            store.get_calibration_timelines(["s1"]),
            {"s1": [(T, -0.5), (T + 1000, 1.0)]},
        )
        self.assertEqual(store.get_current_offsets(), {"s1": 1.0, "s2": 2.0})

    def test_default_effective_time_is_now(self):
        before = int(__import__("time").time() * 1000) - 5
        store.set_offset("s1", 1.0)
        after = int(__import__("time").time() * 1000) + 5
        (t, off), = store.get_calibration_timelines(["s1"])["s1"]
        self.assertTrue(before <= t <= after)
        self.assertEqual(off, 1.0)

    def test_legacy_calibration_schema_is_preserved_for_all_history(self):
        db = Path(tempfile.mkdtemp(prefix="ota-cal-legacy-")) / "ota.db"
        c = sqlite3.connect(db)
        c.executescript(
            """
            CREATE TABLE calibration (
                sensor_id TEXT PRIMARY KEY,
                offset REAL NOT NULL,
                updated TEXT
            );
            INSERT INTO calibration(sensor_id, offset, updated)
                VALUES('s1', 1.25, '2024-01-01 00:00:00');
            """
        )
        c.commit()
        c.close()

        store.DB_PATH = str(db)
        store.init_db()
        store.init_db()  # idempotent

        self.assertEqual(store.get_calibration_timelines(["s1"]), {"s1": [(0, 1.25)]})
        self.assertEqual(store.get_current_offsets(), {"s1": 1.25})
        # epoch-0 effective time means old history keeps the old calibration.
        norm = influx._normalize_cal(store.get_calibration_timelines(["s1"]), ["s1"])
        self.assertEqual(influx._offset_at(norm, "s1", T), 1.25)


if __name__ == "__main__":
    unittest.main()
