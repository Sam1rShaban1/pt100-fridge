# Pi 4B firmware (native port)

A Raspberry Pi 4B-native port of the ESP32 firmware (`firmware/`). It runs
directly on Raspberry Pi OS in Python 3, reading a **real** MAX31865 over the
Pi's SPI bus, publishing the same `pt100/<sensor>` MQTT payloads, and supporting
the **same OTA contract** (subscribe + manifest poll + SHA-256 verified
self-update). Use it to test the backend + OTA server end-to-end on the Pi.

> For the actual ESP32 device you still build `firmware/` with PlatformIO.
> This directory is the Pi-equivalent used for local validation.

## 1. Enable SPI and install deps

```bash
sudo raspi-config   # Interface Options -> SPI -> Enable
sudo apt update && sudo apt install -y python3-pip python3-venv
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

## 2. Wire the MAX31865 (3-wire PT100)

| MAX31865 | Pi 4B (3.3V logic) |
|----------|--------------------|
| VIN      | 3V3 (pin 1/17)     |
| GND      | GND (pin 6/9/...)  |
| CLK      | GPIO11 (SCLK, pin 23) |
| SDO      | GPIO9  (MISO, pin 21) |
| SDI      | GPIO10 (MOSI, pin 19) |
| CS       | GPIO8 (CE0, pin 24) or GPIO7 (CE1, pin 26) |

`config.py` defaults: `fridge_top` = `/dev/spidev0.0` (CE0), `freezer` =
`/dev/spidev0.1` (CE1). Edit `SENSORS` to change bus/CS.

If SPI is unavailable, the firmware automatically falls back to a **simulated**
sensor so you can still test the backend/OTA flow.

## 3. Start the backend on the same Pi

```bash
cd backend
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
# Grafana    http://<pi-ip>:3000
# OTA server http://<pi-ip>:8000
```

## 4. Run the Pi firmware

```bash
cd rpi
python3 main.py
```

It connects to the local Mosquitto (`localhost:1883`), publishes
`pt100/fridge_top` / `pt100/freezer`, and responds to OTA commands.

### Override config via env

```bash
MQTT_BROKER=localhost MQTT_PORT=1883 \
OTA_BASE_URL=http://localhost:8000 DEVICE_ID=pi-test-001 GROUP=zone_a \
python3 main.py
```

## 5. OTA self-update (real)

Upload a Python artifact as firmware in the OTA UI (or via the API) with a
higher version than the Pi's current `version.txt`, start a rollout targeting
`zone_a`, and the Pi will:

1. receive `ota/zone_a/update`,
2. download the file over HTTPS,
3. verify its SHA-256,
4. write `main.py` (backup → `main.py.bak`) and restart into the new version,
5. persist the version to `version.txt`.

Non-Python artifacts (e.g. an ESP32 `.bin` used only to exercise the server)
are verified and ACKed as `success` without applying.

## Topics (identical to ESP32 firmware)

| Direction | Topic | Payload |
|-----------|-------|---------|
| pub | `pt100/<sensor>` | `{"temp":4.01,"resistance":100.5,"fault":0,"mode":"spi"}` |
| pub | `ota/<device>/hello` | `{"group":"zone_a","version":"1.0.0"}` |
| pub | `ota/<device>/status` | `{"state":"downloading|verified|success|error","version":"1.0.1","sha256":"..."}` |
| sub | `ota/<group>/update` | `{"version":"1.0.1","url":"...","sha256":"..."}` |
| sub | `ota/<device>/update` | same |
