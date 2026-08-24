# Firmware (ESP32 + MAX31865 + PT100)

Arduino/PlatformIO firmware for an ESP32 that reads one or more 3-wire PT100
sensors via MAX31865 RTD-to-digital converters, publishes temperature over
**MQTTS** (TLS) to a broker, and supports **internet OTA updates** triggered
by the backend OTA server.

## Hardware wiring

ESP32 VSPI bus is shared by all MAX31865 boards (just one CS pin each):

| MAX31865   | ESP32       |
|------------|-------------|
| VIN        | 3V3         |
| GND        | GND         |
| 3V3 (exc)  | 3V3         |
| CLK        | GPIO18      |
| SDO (MISO) | GPIO19      |
| SDI (MOSI) | GPIO23      |
| CS         | per sensor (see `config.h`) |

**3-wire PT100** → breakout: join two leads to `RTD+` **and** `F+`; third lead → `RTD-`.
`RREF = 430 Ω` (0.1%), `RNOMINAL = 100 Ω` for PT100.

Sensors are defined in `src/config.h` via `SENSOR_DEFS` (id + CS pin).

## Configure

Edit `src/config.h`:

- `WIFI_SSID` / `WIFI_PASSWORD` — factory WiFi.
- `DEVICE_ID` / `GROUP` — unique per device; `GROUP` is the rollout group.
- `MQTT_BROKER` / `MQTT_USER` / `MQTT_PASSWORD` — the broker host (e.g. `mqtt.example.com`)
  and **per-device** credentials (must exist in Mosquitto).
- `OTA_BASE_URL` — `https://ota.example.com` (served by the backend).
- `FW_VERSION` — bump on every release.

`src/certs.h` contains the two root CAs the device trusts:

- `ISRG_X1_ROOT` — for HTTPS OTA downloads (Caddy / Let's Encrypt).
- `MQTT_ROOT_CA` — the project MQTT CA (`backend/mosquitto/certs/ca.crt`).

If you regenerate the MQTT CA, paste the new `ca.crt` into `MQTT_ROOT_CA`.

## Build & flash

```bash
pio run -t upload          # build + flash
pio device monitor         # 115200 baud
```

The partition table (`partitions.csv`) has two OTA app slots, so OTA works.

## MQTT topics

| Topic                     | Direction | Payload                                  |
|---------------------------|-----------|------------------------------------------|
| `pt100/<sensor_id>`       | device→   | `{"temp":..,"resistance":..,"fault":0}`  |
| `ota/<device_id>/hello`   | device→   | `{"group":..,"version":..}`              |
| `ota/<device_id>/status` | device→   | `{"state":"downloading|success|failed","version":..}` |
| `ota/<group>/update`      | →device   | `{"version":..,"url":..,"sha256":..,"size":..}` |
| `ota/<device_id>/update`  | →device   | same (per-device targeting)              |

The device also sets a Last-Will `ota/<device_id>/status = {"state":"offline"}`.

## OTA behavior

- On boot the device subscribes to `ota/<group>/update` and `ota/<device_id>/update`
  and publishes a `hello`.
- Updates are downloaded over HTTPS, **SHA-256 verified** before flashing. A wrong
  checksum aborts and leaves the running firmware intact.
- The device also polls `GET <OTA_BASE_URL>/api/firmware/manifest` every `OTA_POLL_MS`
  as a fallback in case an MQTT command was missed.
