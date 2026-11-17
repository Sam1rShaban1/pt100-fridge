"""Firmware image validation.

The OTA server used to accept any bytes named ``*.bin`` and offer them to any
device in a group. That is how a board ends up flashing an image for a
different architecture and never booting again. Everything needed to catch
that class of mistake happens here, before the bytes are stored:

* only the known hardware targets are accepted,
* the image must actually be an image for that target (not a UF2, not a
  filesystem bundle, not a truncated download),
* the stored ``hw`` tag is what the manifest filters on, so a device can only
  ever be handed an image for its own board.
"""

from __future__ import annotations

import hashlib

HW_TARGETS = ("pico-w", "esp32")
DEFAULT_HW = "pico-w"

#: Nothing we build is anywhere near this; anything bigger is a mistake.
MAX_IMAGE_BYTES = 8 * 1024 * 1024
#: Real application images are comfortably larger than this.
MIN_IMAGE_BYTES = 16 * 1024
#: The 2 MB Pico layout reserves 1 MB for the LittleFS OTA staging area, so a
#: build larger than this cannot be applied even if it downloads fine.
MAX_PICO_IMAGE_BYTES = 900 * 1024

_UF2_MAGIC0 = 0x0A324655  # bytes: 55 46 32 0A ("UF2\n")
_UF2_MAGIC1 = 0x9E5D5157

_ESP32_IMAGE_MAGIC = 0xE9
_RP2040_XIP_BASE = 0x10000000
_RP2040_SRAM_BASE = 0x20000000
_RP2040_SRAM_END = 0x20082000  # 264 KB on RP2040, 520 KB on RP2350
_RP2040_BOOT2_BYTES = 256


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _le32(data: bytes, off: int) -> int:
    return int.from_bytes(data[off : off + 4], "little")


def _rp2040_crc32(data: bytes) -> int:
    """CRC-32/MPEG-2 over the boot2 stage, as the RP2040 bootrom checks it."""
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b << 24
        for _ in range(8):
            if crc & 0x80000000:
                crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF
            else:
                crc = (crc << 1) & 0xFFFFFFFF
    return crc


def _rp2040_boot2_ok(data: bytes) -> bool:
    """A real RP2040 flash image starts with a 256-byte, checksummed boot2.

    The last 4 bytes of the stage hold a CRC-32/MPEG-2 of the first 252. This
    is a strong, layout-independent signal that the bytes are an RP2040 image
    and not an ESP32/UF2/random file.
    """
    if len(data) < _RP2040_BOOT2_BYTES:
        return False
    stored = _le32(data, _RP2040_BOOT2_BYTES - 4)
    return stored == _rp2040_crc32(data[: _RP2040_BOOT2_BYTES - 4])


def _rp2040_vectors_ok(data: bytes, off: int) -> bool:
    if len(data) < off + 8:
        return False
    sp = _le32(data, off)
    pc = _le32(data, off + 4)
    return (
        _RP2040_SRAM_BASE <= sp <= _RP2040_SRAM_END
        and sp % 4 == 0
        and _RP2040_XIP_BASE <= pc < _RP2040_SRAM_BASE
        and bool(pc & 1)  # Thumb bit set on a valid reset vector
    )


def is_uf2(data: bytes) -> bool:
    if len(data) < 8:
        return False
    return _le32(data, 0) == _UF2_MAGIC0 or _le32(data, 4) == _UF2_MAGIC1


def detect_hw(data: bytes):
    """Return the hardware target this image appears to be built for.

    Returns one of ``HW_TARGETS``, ``"uf2"`` (a flashable USB bundle that must
    never be used for OTA) or ``None`` when the header is not recognised.

    The artifact produced by ``pio run -e pico-w`` for Arduino-Pico is the
    full flash image: 256-byte boot2, the OTA bootloader, the partition table,
    then the application at 0x3000. Older/bare builds may instead start with a
    vector table, so both shapes are accepted for RP2040.
    """
    if is_uf2(data):
        return "uf2"
    if len(data) < 8:
        return None
    # Check the RP2040 boot2 CRC before the ESP32 magic: a genuine boot2 could
    # theoretically begin with 0xE9, while an ESP32 image can never carry a
    # valid boot2 checksum.
    if _rp2040_boot2_ok(data):
        return "pico-w"
    if data[0] == _ESP32_IMAGE_MAGIC:
        return "esp32"
    # Bare application images: vector table at the start, or at the fixed
    # offsets used by the Arduino-Pico OTA bootloader / application.
    for off in (0, 0x100, 0x3000):
        if _rp2040_vectors_ok(data, off):
            return "pico-w"
    return None


def validate_image(data: bytes, hw: str):
    """Return ``None`` when the image is safe to serve to ``hw``.

    Otherwise return a human-readable reason, suitable for a 400 response.
    """
    if hw not in HW_TARGETS:
        return f"unknown hardware target {hw!r} (expected one of: {', '.join(HW_TARGETS)})"
    if not data:
        return "empty firmware file"
    if len(data) < MIN_IMAGE_BYTES:
        return f"firmware file is too small ({len(data)} bytes)"
    if len(data) > MAX_IMAGE_BYTES:
        return f"firmware file is too large ({len(data)} bytes, limit {MAX_IMAGE_BYTES})"
    if is_uf2(data):
        return (
            "this is a UF2 file, not an OTA image. UF2 is only for the first "
            "USB flash; upload the .bin produced by the build instead"
        )

    detected = detect_hw(data)
    if detected is None:
        return "unrecognised firmware image (no valid ESP32 or RP2040 header)"
    if detected != hw:
        label = {"esp32": "ESP32", "pico-w": "Raspberry Pi Pico W"}.get(hw, hw)
        return (
            f"image looks like a {detected} build but was tagged for {label}; "
            "refusing to store it"
        )
    if hw == "pico-w" and len(data) > MAX_PICO_IMAGE_BYTES:
        return (
            f"image is {len(data)} bytes but the Pico layout only has room for "
            f"{MAX_PICO_IMAGE_BYTES} bytes of sketch (1 MB LittleFS reserved for "
            "OTA staging); reduce the build or change the flash layout"
        )
    return None
