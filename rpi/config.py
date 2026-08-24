"""Raspberry Pi 4B port of the ESP32 firmware.

Runs natively on Raspberry Pi OS (Python 3). Talks the *same* MQTT contract as
firmware/src (pt100/<sensor> publish, ota/<group|device>/update subscribe,
hello/status, manifest poll) and reads a real MAX31865 over /dev/spidev.
It also performs a genuine OTA self-update (download -> SHA-256 verify -> restart)
so you can exercise the backend + OTA server end-to-end.

For the ESP32 you still need firmware/ (Arduino/PlatformIO). This file tree is the
Pi-equivalent used for local testing on the Pi 4B.
"""

import os

# ---- Device identity (overridable via env) ----
DEVICE_ID = os.environ.get("DEVICE_ID", "pi-test-001")
GROUP = os.environ.get("GROUP", "zone_a")
VER_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "version.txt")


def FW_VERSION():
    if os.path.exists(VER_FILE):
        return open(VER_FILE).read().strip()
    return os.environ.get("FW_VERSION", "1.0.0")


# ---- MQTT ----
MQTT_BROKER = os.environ.get("MQTT_BROKER", "localhost")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_USER = os.environ.get("MQTT_USER") or None
MQTT_PASSWORD = os.environ.get("MQTT_PASSWORD") or None
MQTT_TLS_CA = os.environ.get("MQTT_TLS_CA")  # set for MQTTS

# ---- OTA ----
OTA_BASE_URL = os.environ.get("OTA_BASE_URL", "http://localhost:8000")
OTA_POLL_MS = int(os.environ.get("OTA_POLL_MS", "60000"))

# ---- Sensors ----
# (id, spi_bus, cs) -> /dev/spidev<bus>.<cs>. CE0=GPIO8, CE1=GPIO7.
SENSORS = [
    ("fridge_top", 0, 0),
    ("freezer", 0, 1),
]
PUBLISH_MS = int(os.environ.get("PUBLISH_MS", "5000"))

# PT100
RTD_NOMINAL = 100.0
REF_RESISTOR = 430.0
