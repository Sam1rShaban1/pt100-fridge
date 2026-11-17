"""Focused tests for the OTA safety rules.

Run from backend/ota-server:

    python -m unittest discover -s tests -v
"""

import os
import re
import sqlite3
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_TMPDIR = tempfile.mkdtemp(prefix="ota-tests-")
os.environ["OTA_DB"] = str(Path(_TMPDIR) / "bootstrap.db")

from app import store  # noqa: E402
from app.firmware_image import (  # noqa: E402
    MAX_PICO_IMAGE_BYTES,
    _rp2040_boot2_ok,
    _rp2040_crc32,
    detect_hw,
    sha256_hex,
    validate_image,
)


def esp32_image(size=64 * 1024):
    return bytes([0xE9, 0x04, 0x02, 0x20]) + b"\x00" * (size - 4)


def pico_image(size=64 * 1024, sp=0x20041000, pc=0x10000101):
    return struct.pack("<II", sp, pc) + b"\x00" * (size - 8)


def uf2_image(size=64 * 1024):
    return struct.pack("<II", 0x0A324655, 0x9E5D5157) + b"\x00" * (size - 8)


def pico_flash_image(size=64 * 1024):
    """The shape Arduino-Pico actually produces: boot2 + OTA + app at 0x3000."""
    boot2 = bytearray(252)
    boot2[0:4] = b"\x00\xb5\x32\x4b"
    img = bytearray(bytes(boot2) + struct.pack("<I", _rp2040_crc32(boot2)))
    assert len(img) == 256
    img.extend(b"\x00" * (0x3000 - len(img)))
    img[0x3000:0x3008] = struct.pack("<II", 0x20042000, 0x100030E1)
    img.extend(b"\x00" * (size - len(img)))
    return bytes(img)


class ImageValidationTests(unittest.TestCase):
    def test_detects_targets(self):
        self.assertEqual(detect_hw(esp32_image()), "esp32")
        self.assertEqual(detect_hw(pico_image()), "pico-w")
        self.assertEqual(detect_hw(pico_flash_image()), "pico-w")
        self.assertEqual(detect_hw(uf2_image()), "uf2")
        self.assertIsNone(detect_hw(b"nonsense" * 4096))

    def test_accepts_matching_images(self):
        self.assertIsNone(validate_image(pico_image(), "pico-w"))
        self.assertIsNone(validate_image(pico_flash_image(), "pico-w"))
        self.assertIsNone(validate_image(esp32_image(), "esp32"))

    def test_boot2_checksum_gate(self):
        good = pico_flash_image()
        self.assertTrue(_rp2040_boot2_ok(good))

        # Corrupt the boot2 payload: the CRC no longer matches. The image is
        # still recognised as RP2040 by its app vector table, but a file with
        # neither a valid CRC nor known vectors must not be accepted.
        bad = bytearray(good)
        bad[10] ^= 0xFF
        self.assertFalse(_rp2040_boot2_ok(bytes(bad)))
        self.assertEqual(detect_hw(bytes(bad)), "pico-w")

        blank = bytearray(64 * 1024)
        self.assertIsNone(detect_hw(bytes(blank)))

    def test_rejects_cross_board_images(self):
        self.assertIn("esp32 build", validate_image(esp32_image(), "pico-w"))
        self.assertIn("pico-w build", validate_image(pico_image(), "esp32"))

    def test_rejects_uf2(self):
        err = validate_image(uf2_image(), "pico-w")
        self.assertIsNotNone(err)
        self.assertIn("UF2", err)

    def test_rejects_bad_headers_and_sizes(self):
        self.assertIsNotNone(validate_image(b"", "pico-w"))
        self.assertIsNotNone(validate_image(pico_image()[:100], "pico-w"))
        self.assertIsNotNone(validate_image(b"x" * (1024 * 1024), "pico-w"))
        self.assertIsNotNone(validate_image(pico_image(), "unknown-board"))

    def test_rejects_pico_image_too_big_for_flash_layout(self):
        big = pico_image(MAX_PICO_IMAGE_BYTES + 1)
        err = validate_image(big, "pico-w")
        self.assertIsNotNone(err)
        self.assertIn("LittleFS", err)

    def test_rejects_bad_reset_vector(self):
        self.assertIsNotNone(validate_image(pico_image(sp=0x1000, pc=0x10000101), "pico-w"))
        self.assertIsNotNone(validate_image(pico_image(sp=0x20041000, pc=0x10000100), "pico-w"))


class StoreHardwareTests(unittest.TestCase):
    def setUp(self):
        self.db = Path(tempfile.mkdtemp(prefix="ota-db-")) / "ota.db"
        store.DB_PATH = str(self.db)
        store.init_db()

    def test_same_version_on_two_boards_does_not_collide(self):
        store.add_firmware("2.0.0", "zone_a", "aa", 100, "2.0.0-pico-w.bin", hw="pico-w")
        store.add_firmware("2.0.0", "zone_a", "bb", 200, "2.0.0-esp32.bin", hw="esp32")
        self.assertEqual(store.get_firmware("2.0.0", "pico-w")["sha256"], "aa")
        self.assertEqual(store.get_firmware("2.0.0", "esp32")["sha256"], "bb")

    def test_manifest_only_offers_matching_hardware(self):
        store.add_firmware("2.0.0", "zone_a", "aa", 100, "2.0.0-pico-w.bin", hw="pico-w")
        store.add_firmware("3.0.0", "zone_a", "bb", 200, "3.0.0-esp32.bin", hw="esp32")
        best = store.latest_for_group("zone_a", "1.0.0", "pico-w")
        self.assertEqual(best["version"], "2.0.0")
        self.assertEqual(best["hw"], "pico-w")
        self.assertIsNone(store.latest_for_group("zone_a", "2.0.0", "pico-w"))

    def test_group_all_is_considered(self):
        store.add_firmware("2.0.0", "all", "aa", 100, "2.0.0-pico-w.bin", hw="pico-w")
        best = store.latest_for_group("zone_b", "1.0.0", "pico-w")
        self.assertEqual(best["version"], "2.0.0")

    def test_status_without_hw_keeps_known_hardware(self):
        store.upsert_device("fridge-001", "zone_a", "2.0.0", "online", "pico-w")
        store.upsert_device("fridge-001", "zone_a", "2.0.0", "success", None)
        dev = next(d for d in store.get_all_devices() if d["device_id"] == "fridge-001")
        self.assertEqual(dev["hw"], "pico-w")
        self.assertEqual(dev["last_state"], "success")

    def test_legacy_schema_is_migrated_to_esp32(self):
        db = Path(tempfile.mkdtemp(prefix="ota-legacy-")) / "ota.db"
        c = sqlite3.connect(db)
        c.executescript(
            """
            CREATE TABLE firmware (
                version TEXT PRIMARY KEY, grp TEXT NOT NULL, sha256 TEXT NOT NULL,
                size INTEGER NOT NULL, filename TEXT NOT NULL,
                created TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE devices (
                device_id TEXT PRIMARY KEY, grp TEXT, version TEXT,
                last_seen TEXT, last_state TEXT
            );
            INSERT INTO firmware(version, grp, sha256, size, filename)
                VALUES('1.0.1', 'zone_a', 'aa', 123, '1.0.1.bin');
            INSERT INTO devices(device_id, grp, version, last_state)
                VALUES('fridge-001', 'zone_a', '1.0.1', 'online');
            """
        )
        c.commit()
        c.close()

        store.DB_PATH = str(db)
        store.init_db()
        store.init_db()  # idempotent

        row = store.get_firmware("1.0.1", "esp32")
        self.assertIsNotNone(row)
        self.assertEqual(row["filename"], "1.0.1.bin")
        self.assertIsNone(store.get_firmware("1.0.1", "pico-w"))
        dev = next(d for d in store.get_all_devices() if d["device_id"] == "fridge-001")
        self.assertIsNone(dev["hw"])


class BuiltArtifactTests(unittest.TestCase):
    """Validate the actual .bin this repo builds, not just synthetic fixtures.

    This is what would be uploaded for a real rollout, so it must pass the
    server's own validator and fit the OTA staging area.
    """

    REPO = Path(__file__).resolve().parents[3]
    ARTIFACT = REPO / "firmware" / ".pio" / "build" / "pico-w" / "firmware.bin"
    CONFIG = REPO / "firmware" / "src" / "config.h"

    @classmethod
    def setUpClass(cls):
        if not cls.ARTIFACT.exists():
            raise unittest.SkipTest(f"{cls.ARTIFACT} not built yet")
        cls.data = cls.ARTIFACT.read_bytes()
        m = re.search(r'FW_VERSION\s+"([^"]+)"', cls.CONFIG.read_text())
        cls.version = m.group(1) if m else None

    def test_artifact_is_a_valid_pico_image(self):
        self.assertTrue(_rp2040_boot2_ok(self.data))
        self.assertEqual(detect_hw(self.data), "pico-w")
        self.assertIsNone(validate_image(self.data, "pico-w"))

    def test_artifact_fits_ota_staging(self):
        self.assertLessEqual(len(self.data), MAX_PICO_IMAGE_BYTES)

    def test_artifact_is_never_accepted_for_esp32(self):
        self.assertIsNotNone(validate_image(self.data, "esp32"))

    def test_artifact_contains_expected_target_and_version(self):
        self.assertIn(b"pico-w", self.data)
        self.assertIsNotNone(self.version, "FW_VERSION not found in config.h")
        self.assertIn(self.version.encode(), self.data)

    def test_artifact_flash_layout_matches_ota_staging(self):
        # [boot2][OTA][partition table @0x2ff0][app @0x3000][LittleFS][EEPROM]
        fs_start, fs_end, eeprom_start, flash_length = struct.unpack(
            "<4I", self.data[0x2FF0:0x3000]
        )
        self.assertEqual(fs_start, 0x10100000 - 0x1000)  # 2 MB minus 1 MB FS minus 4 KB
        self.assertEqual(fs_end - fs_start, 1024 * 1024)  # board_build.filesystem_size = 1m
        self.assertEqual(eeprom_start, fs_end)
        self.assertEqual(flash_length, fs_start - 0x10000000)
        # The server cap must fit inside the staging filesystem.
        self.assertLessEqual(MAX_PICO_IMAGE_BYTES, fs_end - fs_start)

    def test_build_config_still_reserves_one_megabyte_filesystem(self):
        ini = (self.REPO / "firmware" / "platformio.ini").read_text()
        self.assertIn("board_build.filesystem_size = 1m", ini)
        # A 2 MB board: app + 1 MB FS + 4 KB EEPROM.
        self.assertLess(MAX_PICO_IMAGE_BYTES, 1024 * 1024)


class HashTests(unittest.TestCase):
    def test_sha256_hex(self):
        self.assertEqual(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        )


if __name__ == "__main__":
    unittest.main()
