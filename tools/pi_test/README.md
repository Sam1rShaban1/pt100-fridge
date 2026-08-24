# Pi test harness (no ESP32 needed)

A Python stand-in for the ESP32 firmware so you can validate the backend and
the OTA server end-to-end on a Raspberry Pi 4B (or any Linux machine).

It speaks the **same MQTT contract** as `firmware/src`:
`pt100/<sensor>` publishes, `ota/<group|device>/update` subscriptions,
`ota/<device>/hello` + `ota/<device>/status`, and manifest polling.

## 1. Run the backend locally on the Pi

```bash
cd backend
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
# Grafana    http://<pi-ip>:3000   (admin / GRAFANA_PASSWORD from .env)
# OTA server http://<pi-ip>:8000
```

This skips Caddy/Let's Encrypt (no public domain needed) and publishes
Grafana + OTA server on the Pi's LAN IP.

## 2. Install the harness

```bash
cd tools/pi_test
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

For **real** MAX31865 readings enable SPI (`sudo raspi-config` -> Interface -> SPI)
and wire the breakout to the Pi:

| MAX31865 | Pi (3.3V logic) |
|----------|-----------------|
| VIN      | 3V3             |
| GND      | GND             |
| CLK      | GPIO11 (SCLK)   |
| SDO      | GPIO9  (MISO)   |
| SDI      | GPIO10 (MOSI)   |
| CS       | GPIO8 (CE0) or GPIO7 (CE1) |

## 3. Run

Simulated data (no sensor needed):
```bash
python3 publisher.py --host <pi-ip> --port 1883 \
  --device-id pi-test-001 --group zone_a --sensors fridge_top:CE0 freezer:CE1
```

Real sensor (CE0 = fridge_top, CE1 = freezer):
```bash
python3 publisher.py --host <pi-ip> --port 1883 --spi \
  --device-id pi-test-001 --group zone_a --sensors fridge_top:CE0 freezer:CE1
```

Point at the local OTA server to exercise rollouts:
```bash
python3 publisher.py --host <pi-ip> --port 1883 \
  --manifest-url http://<pi-ip>:8000/api/firmware/manifest \
  --verify-download
```

Now the Grafana dashboard (`PT100 Fridge`) will populate, and uploading a
`.bin` + starting a rollout in the OTA UI will drive the canary -> full
state machine (the harness ACKs updates as `success`).

> Note: the harness does **not** flash firmware — it only validates the
> network/backend behavior. Real OTA flashing only happens on the ESP32.
