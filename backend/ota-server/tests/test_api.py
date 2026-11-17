"""API-level tests for the OTA server.

These exercise the real FastAPI app through TestClient: upload validation,
board-aware manifests, the actual firmware download a device performs, rollout
targeting/promotion/abort, and auth. They are the contract between the Pico
firmware and the server, so a failure here means updates would fail (or worse,
serve the wrong board) in the field.

Run from backend/ota-server:

    python -m unittest discover -s tests -v
"""

import json
import os
import struct
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_TMPDIR = tempfile.mkdtemp(prefix="ota-api-")
os.environ["OTA_DB"] = str(Path(_TMPDIR) / "bootstrap.db")
os.environ["FIRMWARE_DIR"] = str(Path(_TMPDIR) / "firmware")
os.environ["OTA_ADMIN_TOKEN"] = "test-admin-token"
os.environ["PUBLIC_BASE_URL"] = "https://ota.example.com"  # placeholder on purpose
os.environ["DEVICE_GROUPS"] = json.dumps(
    {
        "zone_a": ["dev-1", "dev-2", "dev-legacy"],
        "zone_b": ["dev-3"],
    }
)

from fastapi.testclient import TestClient  # noqa: E402

from app import main as app_main  # noqa: E402
from app import store  # noqa: E402
from app.firmware_image import MAX_PICO_IMAGE_BYTES, sha256_hex  # noqa: E402

TOKEN = "test-admin-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def pico_image(size=64 * 1024, sp=0x20041000, pc=0x10000101):
    return struct.pack("<II", sp, pc) + bytes(size - 8)


def esp32_image(size=64 * 1024):
    return bytes([0xE9, 0x04, 0x02, 0x20]) + bytes(size - 4)


def uf2_image(size=64 * 1024):
    return struct.pack("<II", 0x0A324655, 0x9E5D5157) + bytes(size - 8)


class _FakeTimer:
    """The rollout watchdog must not keep the test process alive for 5 min."""

    def __init__(self, interval, fn, args=(), kwargs=None):
        self.interval = interval
        self.fn = fn
        self.args = args
        self.kwargs = kwargs or {}
        self.cancelled = False

    def start(self):
        pass

    def cancel(self):
        self.cancelled = True


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ota-api-db-"))
        store.DB_PATH = str(self.tmp / "ota.db")
        store.init_db()

        for p in app_main.FIRMWARE_DIR.glob("*.bin"):
            p.unlink()

        self.published = []
        self._real_publish = app_main.publish
        app_main.publish = lambda topic, payload: self.published.append((topic, payload))
        self._real_threading = app_main.threading
        app_main.threading = types.SimpleNamespace(Timer=_FakeTimer)

        app_main.rollout_state.clear()
        app_main._history_cache.clear()
        with app_main._cal_lock:
            app_main._calibration.clear()
            app_main._cal_version += 1

        self.client = TestClient(app_main.app)

    def tearDown(self):
        app_main.publish = self._real_publish
        app_main.threading = self._real_threading
        app_main.rollout_state.clear()

    # ---- helpers ----
    def upload(self, data, hw="pico-w", version="2.0.0", group="zone_a", auth=True,
               filename=None):
        name = filename or (f"{version}.bin" if version else "firmware.bin")
        return self.client.post(
            "/api/firmware",
            files={"file": (name, data, "application/octet-stream")},
            data={"group": group, "version": version, "hw": hw},
            headers=AUTH if auth else {},
        )

    def register_device(self, device_id, hw, group="zone_a", version="1.0.0"):
        store.upsert_device(device_id, group, version, "online", hw)

    def manifest(self, device_id="dev-1", group="zone_a", current="1.0.0", hw="pico-w",
                 headers=None):
        return self.client.get(
            "/api/firmware/manifest",
            params={
                "device_id": device_id,
                "group": group,
                "current": current,
                "hw": hw,
            },
            headers=headers or {},
        )


class UploadTests(ApiTestCase):
    def test_upload_requires_auth(self):
        r = self.upload(pico_image(), auth=False)
        self.assertEqual(r.status_code, 401)

    def test_upload_accepts_valid_pico_image(self):
        data = pico_image()
        r = self.upload(data)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["hw"], "pico-w")
        self.assertEqual(body["filename"], "2.0.0-pico-w.bin")
        self.assertEqual(body["size"], len(data))
        self.assertEqual(body["sha256"], sha256_hex(data))
        self.assertEqual(
            (app_main.FIRMWARE_DIR / "2.0.0-pico-w.bin").read_bytes(), data
        )

    def test_upload_rejects_cross_board_images(self):
        # Pico image tagged as ESP32: the detector names the real board.
        r = self.upload(pico_image(), hw="esp32")
        self.assertEqual(r.status_code, 400)
        self.assertIn("pico-w", r.json()["detail"])

        # ESP32 image tagged as Pico W: refuse to store it for the Pico.
        r = self.upload(esp32_image(), hw="pico-w")
        self.assertEqual(r.status_code, 400)
        self.assertIn("esp32", r.json()["detail"])

    def test_upload_rejects_uf2_and_garbage(self):
        for data in (uf2_image(), b"", b"x" * (64 * 1024), pico_image()[:100]):
            r = self.upload(data)
            self.assertEqual(r.status_code, 400, r.text)

    def test_upload_rejects_unknown_hardware(self):
        r = self.upload(pico_image(), hw="stm32")
        self.assertEqual(r.status_code, 400)
        self.assertIn("hw", r.json()["detail"])

    def test_upload_rejects_oversized_pico_image(self):
        r = self.upload(pico_image(MAX_PICO_IMAGE_BYTES + 1))
        self.assertEqual(r.status_code, 400)
        self.assertIn("LittleFS", r.json()["detail"])

    def test_upload_accepts_image_at_exact_limit(self):
        r = self.upload(pico_image(MAX_PICO_IMAGE_BYTES))
        self.assertEqual(r.status_code, 200, r.text)

    def test_upload_rejects_bad_version(self):
        for ver in ("latest", "1.2", "1.2.3.4", "../etc/passwd"):
            r = self.upload(pico_image(), version=ver)
            self.assertEqual(r.status_code, 400, f"{ver}: {r.text}")

    def test_upload_derives_version_from_filename(self):
        r = self.upload(pico_image(), version="", filename="pico-fw-1.4.2.bin")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["version"], "1.4.2")

    def test_same_version_on_two_boards_keeps_both_files(self):
        a = pico_image()
        b = esp32_image()
        self.assertEqual(self.upload(a, hw="pico-w").status_code, 200)
        self.assertEqual(self.upload(b, hw="esp32").status_code, 200)
        self.assertEqual((app_main.FIRMWARE_DIR / "2.0.0-pico-w.bin").read_bytes(), a)
        self.assertEqual((app_main.FIRMWARE_DIR / "2.0.0-esp32.bin").read_bytes(), b)

        listing = self.client.get("/api/firmware").json()["firmware"]
        same = [f for f in listing if f["version"] == "2.0.0"]
        self.assertEqual({f["hw"] for f in same}, {"pico-w", "esp32"})

    def test_login_cookie_authorises_upload(self):
        r = self.client.post("/api/auth/login", json={"token": TOKEN})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.upload(pico_image(), auth=False)
        self.assertEqual(r.status_code, 200, r.text)


class ManifestTests(ApiTestCase):
    def test_manifest_requires_known_hardware(self):
        self.upload(pico_image())
        for hw in ("", "stm32", "pico"):
            r = self.manifest(hw=hw)
            self.assertEqual(r.status_code, 204, f"{hw}: {r.text}")

    def test_manifest_is_public_and_204_when_nothing_newer(self):
        self.upload(pico_image(), version="2.0.0")
        self.assertEqual(self.manifest(current="1.0.0").status_code, 200)
        self.assertEqual(self.manifest(current="2.0.0").status_code, 204)
        self.assertEqual(self.manifest(current="9.9.9").status_code, 204)

    def test_manifest_never_offers_other_board_build(self):
        self.upload(pico_image(), version="2.0.0", hw="pico-w")
        self.upload(esp32_image(), version="3.0.0", hw="esp32")
        r = self.manifest(hw="pico-w")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["version"], "2.0.0")
        self.assertEqual(r.json()["hw"], "pico-w")

    def test_manifest_url_uses_request_host(self):
        self.upload(pico_image())
        r = self.manifest(headers={"Host": "192.168.0.126:8010"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            r.json()["url"], "http://192.168.0.126:8010/firmware/2.0.0-pico-w.bin"
        )
        self.assertNotIn("example.com", r.json()["url"])

    def test_manifest_respects_reverse_proxy_headers(self):
        self.upload(pico_image())
        r = self.manifest(
            headers={
                "Host": "internal:8000",
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "ota.coldchain.example, proxy",
            }
        )
        self.assertEqual(
            r.json()["url"],
            "https://ota.coldchain.example/firmware/2.0.0-pico-w.bin",
        )

    def test_manifest_picks_newest_semver_not_newest_upload(self):
        self.upload(pico_image(), version="1.10.0")
        self.upload(pico_image(), version="1.9.9")
        self.upload(pico_image(), version="1.2.0")
        r = self.manifest(current="1.0.0")
        self.assertEqual(r.json()["version"], "1.10.0")

    def test_group_all_is_offered_to_every_group(self):
        self.upload(pico_image(), group="all")
        r = self.manifest(group="zone_b")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["version"], "2.0.0")

    def test_device_can_download_exactly_what_manifest_promised(self):
        """The full device flow: manifest -> GET url -> bytes + hash match."""
        data = pico_image()
        self.upload(data)
        m = self.manifest(headers={"Host": "192.168.0.126:8010"}).json()
        path = urlparse(m["url"]).path
        r = self.client.get(path)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.content), m["size"])
        self.assertEqual(sha256_hex(r.content), m["sha256"])
        self.assertEqual(r.content, data)

    def test_manifest_after_server_restart_still_serves_firmware(self):
        self.upload(pico_image())
        store.init_db()  # simulates a restart re-running migrations
        r = self.manifest()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["version"], "2.0.0")


class RolloutTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.upload(pico_image(), version="2.0.0", hw="pico-w")
        self.register_device("dev-1", "pico-w")
        self.register_device("dev-2", "pico-w")
        self.register_device("dev-legacy", None)  # old firmware, never said hw
        self.register_device("dev-3", "pico-w", group="zone_b")

    def start(self, payload=None):
        body = {"version": "2.0.0", "group": "zone_a", "canary": 1, "hw": "pico-w"}
        body.update(payload or {})
        return self.client.post("/api/rollout", json=body, headers=AUTH)

    def test_rollout_requires_auth(self):
        r = self.client.post(
            "/api/rollout",
            json={"version": "2.0.0", "group": "zone_a", "canary": 1, "hw": "pico-w"},
        )
        self.assertEqual(r.status_code, 401)

    def test_rollout_unknown_version_404(self):
        self.assertEqual(self.start({"version": "9.9.9"}).status_code, 404)

    def test_rollout_only_targets_devices_with_matching_hw(self):
        r = self.start()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["targets"], ["dev-1"])
        self.assertEqual(body["remaining"], 1)
        self.assertEqual(body["skipped_hw_mismatch"], ["dev-legacy"])
        self.assertEqual(body["hw"], "pico-w")

    def test_rollout_refuses_group_with_no_matching_devices(self):
        r = self.start({"group": "zone_b", "hw": "esp32"})
        # zone_b has a pico device but no esp32 build/device
        self.assertEqual(r.status_code, 404)  # no esp32 2.0.0 image exists

        # Same board, but the device has never reported hw.
        r = self.start({"group": "zone_a", "hw": "pico-w", "version": "2.0.0"})
        self.assertEqual(r.status_code, 200)

    def test_rollout_promotes_after_canary_success(self):
        r = self.start()
        self.assertEqual(r.status_code, 200, r.text)
        # Only the canary receives the update until the rest are promoted.
        topics = [t for t, _ in self.published]
        self.assertEqual(topics, ["ota/dev-1/update"])

        # Canary reports success -> promotion to the rest of the group.
        app_main._handle_status("dev-1", "success")
        with app_main.rollout_lock:
            st = app_main.rollout_state["zone_a"]
            self.assertEqual(st["phase"], "full")

        topics = [t for t, _ in self.published]
        self.assertEqual(topics, ["ota/dev-1/update", "ota/dev-2/update"])
        payload = json.loads(self.published[1][1])
        self.assertEqual(payload["version"], "2.0.0")
        self.assertEqual(payload["hw"], "pico-w")
        # PUBLIC_BASE_URL is a placeholder here: device is told to pull the
        # manifest instead of receiving an unreachable URL.
        self.assertEqual(payload.get("action"), "check")
        self.assertNotIn("url", payload)

    def test_rollout_promotion_includes_real_url_when_configured(self):
        real = "https://ota.coldchain.example"
        old = app_main.PUBLIC_BASE
        app_main.PUBLIC_BASE = real
        try:
            self.assertEqual(self.start().status_code, 200)
            app_main._handle_status("dev-1", "success")
        finally:
            app_main.PUBLIC_BASE = old
        payload = json.loads(self.published[-1][1])
        self.assertEqual(
            payload["url"], f"{real}/firmware/2.0.0-pico-w.bin"
        )
        self.assertNotIn("action", payload)

    def test_rollout_aborts_when_canary_fails(self):
        self.assertEqual(self.start().status_code, 200)
        app_main._handle_status("dev-1", "failed")
        with app_main.rollout_lock:
            self.assertEqual(app_main.rollout_state["zone_a"]["phase"], "aborted")
        # Only the canary command was ever sent; nobody else was promoted.
        self.assertEqual([t for t, _ in self.published], ["ota/dev-1/update"])

    def test_rollout_aborts_when_canary_times_out(self):
        self.assertEqual(self.start().status_code, 200)
        app_main._watchdog("zone_a")
        with app_main.rollout_lock:
            self.assertEqual(app_main.rollout_state["zone_a"]["phase"], "aborted")
        self.assertEqual([t for t, _ in self.published], ["ota/dev-1/update"])

    def test_status_from_wrong_device_is_ignored(self):
        self.assertEqual(self.start().status_code, 200)
        app_main._handle_status("dev-2", "failed")  # not in the canary set
        with app_main.rollout_lock:
            st = app_main.rollout_state["zone_a"]
            self.assertEqual(st["phase"], "canary")
            self.assertNotIn("dev-2", st["failed"])

    def test_duplicate_success_is_idempotent(self):
        self.assertEqual(self.start().status_code, 200)
        app_main._handle_status("dev-1", "success")
        before = len(self.published)
        app_main._handle_status("dev-1", "success")
        self.assertEqual(len(self.published), before)

    def test_rollout_without_hw_uses_pico_build(self):
        r = self.client.post(
            "/api/rollout",
            json={"version": "2.0.0", "group": "zone_a", "canary": 2},
            headers=AUTH,
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["hw"], "pico-w")
        self.assertEqual(r.json()["targets"], ["dev-1", "dev-2"])

    def test_canary_size_is_clamped(self):
        r = self.start({"canary": 99})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["targets"], ["dev-1", "dev-2"])
        self.assertEqual(r.json()["remaining"], 0)


class StaticPagesTests(ApiTestCase):
    def test_logo_and_favicon_are_served(self):
        for path, magic in (
            ("/logo.png", b"\x89PNG\r\n\x1a\n"),
            ("/favicon.ico", b"\x00\x00\x01\x00"),
        ):
            r = self.client.get(path)
            self.assertEqual(r.status_code, 200, path)
            self.assertTrue(r.content.startswith(magic), path)

    def test_dashboard_renders_with_room_canvas(self):
        r = self.client.get("/app/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("/logo.png", r.text)
        js = self.client.get("/app/app.js")
        self.assertEqual(js.status_code, 200)
        # 2D room plan and per-sensor calibration controls live in the JS.
        self.assertIn('id="field"', js.text)
        self.assertIn("calibration", js.text.lower())

    def test_legacy_admin_page_offers_pico_target(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn('value="pico-w"', r.text)
        self.assertIn('value="esp32"', r.text)  # legacy images remain listable


class MqttIngestTests(ApiTestCase):
    def hello(self, device_id, payload):
        app_main._on_mqtt(
            f"ota/{device_id}/hello", json.dumps(payload).encode()
        )

    def status(self, device_id, payload):
        app_main._on_mqtt(
            f"ota/{device_id}/status", json.dumps(payload).encode()
        )

    def device(self, device_id):
        return next(
            d for d in store.get_all_devices() if d["device_id"] == device_id
        )

    def test_hello_records_normalised_hardware(self):
        self.hello("dev-x", {"group": "zone_a", "version": "2.0.0", "hw": "PICO-W"})
        d = self.device("dev-x")
        self.assertEqual(d["hw"], "pico-w")
        self.assertEqual(d["grp"], "zone_a")
        self.assertEqual(d["version"], "2.0.0")
        self.assertEqual(d["last_state"], "online")

    def test_bogus_hardware_is_not_recorded(self):
        self.hello("dev-y", {"group": "zone_a", "version": "2.0.0", "hw": "stm32"})
        self.assertIsNone(self.device("dev-y")["hw"])
        # Such a device is then never targeted by a rollout.
        self.assertEqual(
            [d for d in store.get_all_devices() if d.get("hw") == "stm32"], []
        )

    def test_status_without_hw_keeps_known_hardware(self):
        self.hello("dev-z", {"group": "zone_a", "version": "2.0.0", "hw": "pico-w"})
        self.status("dev-z", {"state": "success", "version": "2.0.0"})
        d = self.device("dev-z")
        self.assertEqual(d["hw"], "pico-w")
        self.assertEqual(d["last_state"], "success")


class ConfigAndCalibrationApiTests(ApiTestCase):
    def test_calibration_does_not_require_ota_token(self):
        r = self.client.post(
            "/api/calibration", json={"sensor_id": "sensor-1", "offset": 1.25}
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["offset"], 1.25)
        stored = store.get_current_offsets()
        self.assertEqual(stored.get("sensor-1"), 1.25)

        r = self.client.get("/api/calibration")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["offsets"].get("sensor-1"), 1.25)

    def test_calibration_validation(self):
        for payload in (
            {},
            {"sensor_id": ""},
            {"sensor_id": "s1", "offset": "abc"},
            {"sensor_id": "s1", "offset": 25.1},
            {"sensor_id": "s1", "offset": -25.1},
        ):
            r = self.client.post("/api/calibration", json=payload)
            self.assertEqual(r.status_code, 400, payload)

        r = self.client.post(
            "/api/calibration", json={"sensor_id": "s1", "offset": 1e-12}
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["offset"], 0.0)

    def test_room_config_does_not_require_ota_token(self):
        cfg = {
            "color_scale": {"min": -50, "max": 20},
            "stale_after_s": 15,
            "rooms": [
                {
                    "id": "room-1",
                    "name": "Cold room",
                    "sensors": [{"id": "sensor-1", "label": "Top"}],
                }
            ],
        }
        r = self.client.put("/api/fridges", json=cfg)
        self.assertEqual(r.status_code, 200, r.text)
        got = self.client.get("/api/fridges").json()
        self.assertEqual(got["rooms"][0]["sensors"][0]["id"], "sensor-1")

        known = self.client.get("/api/sensors/known").json()["sensors"]
        self.assertIn("sensor-1", known)

    def test_room_config_rejects_duplicates_and_missing_ids(self):
        bad = [
            {"rooms": [{"id": "", "sensors": []}]},
            {"rooms": [{"id": "a"}, {"id": "a"}]},
            {
                "rooms": [
                    {"id": "a", "sensors": [{"id": "s1"}]},
                    {"id": "b", "sensors": [{"id": "s1"}]},
                ]
            },
            {"rooms": [{"id": "a", "sensors": [{}]}]},
            {"rooms": "nope"},
            [],
        ]
        for body in bad:
            r = self.client.put("/api/fridges", json=body)
            self.assertEqual(r.status_code, 400, body)

    def test_live_stream_applies_current_calibration(self):
        self.client.post(
            "/api/calibration", json={"sensor_id": "sensor-1", "offset": 1.5}
        )

        class FakeLoop:
            def __init__(self):
                self.calls = []

            def call_soon_threadsafe(self, fn, queue, item):
                self.calls.append(item)

        loop = FakeLoop()
        old_loop, old_clients = app_main._sse_loop, app_main._sse_clients
        app_main._sse_loop, app_main._sse_clients = loop, {"q"}
        try:
            app_main._on_pt100(
                "pt100/sensor-1",
                b'{"temp": 10.0, "resistance": 103.9, "fault": 0}',
            )
        finally:
            app_main._sse_loop, app_main._sse_clients = old_loop, old_clients

        self.assertEqual(len(loop.calls), 1)
        evt = loop.calls[0]
        self.assertEqual(evt["raw_temp"], 10.0)
        self.assertEqual(evt["temp"], 11.5)
        self.assertEqual(evt["offset"], 1.5)
        self.assertEqual(evt["fault"], 0)

    def test_invalid_reading_is_forwarded_without_temperature(self):
        class FakeLoop:
            def __init__(self):
                self.calls = []

            def call_soon_threadsafe(self, fn, queue, item):
                self.calls.append(item)

        loop = FakeLoop()
        old_loop, old_clients = app_main._sse_loop, app_main._sse_clients
        app_main._sse_loop, app_main._sse_clients = loop, {"q"}
        try:
            app_main._on_pt100("pt100/sensor-2", b'{"valid": false, "fault": 3}')
        finally:
            app_main._sse_loop, app_main._sse_clients = old_loop, old_clients
        self.assertEqual(len(loop.calls), 1)
        self.assertIsNone(loop.calls[0]["temp"])
        self.assertIsNone(loop.calls[0]["raw_temp"])
        self.assertEqual(loop.calls[0]["fault"], 3)

    def test_empty_dashboard_config_queries_are_safe(self):
        r = self.client.get("/api/readings/latest")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"readings": {}})
        r = self.client.get("/api/readings/history")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["series"], {})


class ManifestInputSafetyTests(ApiTestCase):
    def test_manifest_treats_injection_inputs_as_no_match(self):
        self.upload(pico_image(), group="zone_a")
        self.assertEqual(
            self.manifest(hw="pico-w' OR '1'='1").status_code, 204
        )
        self.assertEqual(
            self.manifest(group="zone_a' OR '1'='1").status_code, 204
        )
        self.assertEqual(self.manifest(current="'; DROP TABLE firmware;--").status_code, 200)
        # The table is still there and still serves the image.
        self.assertEqual(self.manifest().status_code, 200)


if __name__ == "__main__":
    unittest.main()
