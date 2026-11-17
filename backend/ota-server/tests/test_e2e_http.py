"""End-to-end test against a real uvicorn server over TCP.

TestClient bypasses the network stack; devices do not. This starts the actual
server process, uploads a real-shaped Pico image, follows the manifest URL,
downloads the bytes, checks the hash/size, restarts the server, and repeats —
the exact sequence a device performs in the field, including persistence
across a redeploy.

Requires httpx (test dependency only). Run from backend/ota-server:

    python -m unittest discover -s tests -v
"""

import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.firmware_image import _rp2040_crc32, sha256_hex  # noqa: E402

OTA_DIR = Path(__file__).resolve().parents[1]
TOKEN = "e2e-admin-token"


def pico_flash_image(size=128 * 1024):
    boot2 = bytearray(252)
    boot2[0:4] = b"\x00\xb5\x32\x4b"
    img = bytearray(bytes(boot2) + struct.pack("<I", _rp2040_crc32(boot2)))
    img.extend(b"\x00" * (0x3000 - len(img)))
    img[0x3000:0x3008] = struct.pack("<II", 0x20042000, 0x100030E1)
    img.extend(b"\x00" * (size - len(img)))
    return bytes(img)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, tmp, port):
        self.tmp = tmp
        self.port = port
        self.proc = None
        self.log = Path(tmp) / "server.log"
        self._logfh = None

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def env(self):
        e = dict(os.environ)
        e.update(
            {
                "OTA_DB": str(Path(self.tmp) / "ota.db"),
                "FIRMWARE_DIR": str(Path(self.tmp) / "firmware"),
                "OTA_ADMIN_TOKEN": TOKEN,
                "PUBLIC_BASE_URL": "https://ota.example.com",  # placeholder
                "DEVICE_GROUPS": json.dumps({"zone_a": ["dev-1", "dev-2"]}),
                "MQTT_BROKER": "127.0.0.1",
                "MQTT_PORT": "1",
                "INFLUX_URL": "http://127.0.0.1:1",
            }
        )
        return e

    def start(self):
        self._logfh = open(self.log, "ab")
        self.proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(self.port),
                "--log-level",
                "warning",
            ],
            cwd=str(OTA_DIR),
            env=self.env(),
            stdout=self._logfh,
            stderr=self._logfh,
        )
        deadline = time.time() + 20
        while time.time() < deadline:
            if self.proc.poll() is not None:
                break
            try:
                r = httpx.get(f"{self.base}/api/client-config", timeout=0.5)
                if r.status_code == 200:
                    return
            except Exception:
                pass
            time.sleep(0.1)
        self.stop()
        raise RuntimeError(
            f"server did not start; log:\n{self.log.read_text(errors='replace')[-4000:]}"
        )

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        self.proc = None
        if self._logfh:
            self._logfh.close()
            self._logfh = None

    def restart(self):
        self.stop()
        self.start()


class RealHttpE2ETests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ota-e2e-"))
        self.server = Server(self.tmp, free_port())
        self.addCleanup(self.server.stop)
        self.server.start()
        self.data = pico_flash_image()
        self.client = httpx.Client(base_url=self.server.base, timeout=10)

    def tearDown(self):
        self.client.close()

    def auth(self):
        return {"Authorization": f"Bearer {TOKEN}"}

    def upload(self, data=None, hw="pico-w", version="2.0.0", auth=True):
        return self.client.post(
            "/api/firmware",
            files={"file": ("firmware.bin", data or self.data)},
            data={"group": "zone_a", "version": version, "hw": hw},
            headers=self.auth() if auth else {},
        )

    def manifest(self, current="1.0.0", hw="pico-w"):
        return self.client.get(
            "/api/firmware/manifest",
            params={
                "device_id": "dev-1",
                "group": "zone_a",
                "current": current,
                "hw": hw,
            },
        )

    def test_full_device_flow_over_tcp(self):
        self.assertEqual(self.upload().status_code, 200)

        m = self.manifest()
        self.assertEqual(m.status_code, 200, m.text)
        body = m.json()
        self.assertEqual(body["version"], "2.0.0")
        self.assertEqual(body["hw"], "pico-w")
        self.assertEqual(body["size"], len(self.data))
        self.assertEqual(body["sha256"], sha256_hex(self.data))
        self.assertTrue(
            body["url"].startswith(self.server.base),
            f"manifest URL must use the address the device reached: {body['url']}",
        )

        r = self.client.get(body["url"])
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.content), body["size"])
        self.assertEqual(sha256_hex(r.content), body["sha256"])
        self.assertEqual(r.content, self.data)
        # The device refuses images without a length; the server must send one.
        self.assertEqual(int(r.headers["content-length"]), body["size"])

    def test_manifest_and_download_survive_server_restart(self):
        self.assertEqual(self.upload().status_code, 200)
        first = self.manifest().json()

        self.server.restart()

        m = self.manifest()
        self.assertEqual(m.status_code, 200, m.text)
        self.assertEqual(m.json(), first)
        r = self.client.get(m.json()["url"])
        self.assertEqual(r.status_code, 200)
        self.assertEqual(sha256_hex(r.content), first["sha256"])

    def test_unknown_board_gets_no_image(self):
        self.assertEqual(self.upload().status_code, 200)
        self.assertEqual(self.manifest(hw="").status_code, 204)
        self.assertEqual(self.manifest(hw="esp32").status_code, 204)

    def test_cross_board_upload_is_rejected_over_tcp(self):
        r = self.upload(hw="esp32")
        self.assertEqual(r.status_code, 400)
        self.assertIn("pico-w", r.json()["detail"])
        self.assertEqual(self.manifest(hw="esp32").status_code, 204)

    def test_upload_requires_token(self):
        self.assertEqual(self.upload(auth=False).status_code, 401)

    def test_up_to_date_device_gets_204(self):
        self.assertEqual(self.upload().status_code, 200)
        self.assertEqual(self.manifest(current="2.0.0").status_code, 204)


if __name__ == "__main__":
    unittest.main()
