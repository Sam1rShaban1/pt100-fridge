# Firmware (Raspberry Pi Pico W + MAX31865 + PT100)

Arduino-Pico firmware for a **Raspberry Pi Pico W (RP2040)** that reads one or
more 3-wire PT100 sensors via MAX31865 RTD-to-digital converters, publishes
temperature over **MQTT** to a broker, and supports **OTA updates** from the
backend OTA server.

The ESP32 target has been retired. This tree builds only for the Pico W.

## Hardware wiring

SPI0 is shared by all MAX31865 boards (one CS pin each):

| MAX31865   | Pico W        |
|------------|---------------|
| VIN        | 3V3 (pin 36)  |
| GND        | GND           |
| 3V3 (exc)  | 3V3           |
| CLK        | GP18          |
| SDO (MISO) | GP16          |
| SDI (MOSI) | GP19          |
| CS         | GP17 (`PIN_SENSOR_CS`) |

Pins are defined in `src/config.h` (`PIN_SPI_SCK`, `PIN_SPI_MISO`,
`PIN_SPI_MOSI`, `PIN_SENSOR_CS`). The MAX31865 library uses the default SPI
instance, so these must match the wiring exactly — wrong pins do not crash,
they silently return 0 Ω/fault readings, which are now rejected as invalid.

**3-wire PT100** → breakout: join two leads to `RTD+` **and** `F+`; third lead → `RTD-`.
`RREF = 430 Ω` (0.1%), `RNOMINAL = 100 Ω` for PT100.

Sensors are defined in `src/config.h` via `SENSOR_DEFS` (id + CS pin). Sensor
IDs are what the dashboard and calibration are keyed on, so keep them stable.

## Configure

Edit `src/config.h`:

- `WIFI_SSID` / `WIFI_PASSWORD` — factory WiFi.
- `DEVICE_ID` / `GROUP` — unique per device; `GROUP` is the rollout group.
- `MQTT_BROKER` / `MQTT_USER` / `MQTT_PASSWORD` — broker host and per-device
  credentials (must exist in Mosquitto).
- `OTA_BASE_URL` — `https://ota.example.com` (served by the backend).
- `FW_VERSION` — bump on every release.
- `HW_TARGET` — must stay `"pico-w"`; the OTA server only serves images to
  devices that report a matching board.

`src/certs.h` contains the root CA the device trusts:

- `ISRG_X1_ROOT` — for HTTPS OTA downloads (Caddy / Let's Encrypt).

MQTT uses unencrypted TCP on port 1883 and does not use a certificate.

## Build & flash

```bash
pio run -e pico-w                  # build
pio run -e pico-w -t upload        # first install over USB
pio device monitor                 # 115200 baud
```

The first flash **must** be over USB with this exact build configuration.
After that, OTA works. The artifact to upload to the OTA server is:

```
.pio/build/pico-w/firmware.bin
```

Do **not** upload the `.uf2` — that is only for USB BOOTSEL flashing, and the
server rejects it.

### Flash layout (2 MB Pico W)

| Region                        | Size    |
|-------------------------------|---------|
| boot2 + OTA bootloader + app  | ~1.02 MB |
| LittleFS (OTA staging)        | 1 MB    |
| EEPROM (boot counter)         | 4 KB    |

OTA stages the image in LittleFS, so the filesystem must be at least as large
as the binary. The server rejects Pico images above 900 KB for this reason.
If the sketch ever outgrows that, build for a board with more flash and change
`board_upload.maximum_size` and `board_build.filesystem_size` together — a
board built for the wrong flash size will not boot.

## MQTT topics

| Topic                     | Direction | Payload                                  |
|---------------------------|-----------|------------------------------------------|
| `pt100/<sensor_id>`       | device→   | `{"temp":..,"resistance":..,"fault":0}`  |
| `ota/<device_id>/hello`   | device→   | `{"group":..,"version":..,"hw":"pico-w"}` |
| `ota/<device_id>/status`  | device→   | `{"state":"downloading|success|failed","version":..}` |
| `ota/<group>/update`      | →device   | `{"version":..,"hw":"pico-w","url":..,"sha256":..,"size":..}` |
| `ota/<device_id>/update`  | →device   | same (per-device targeting)              |

The device also sets a Last-Will `ota/<device_id>/status = {"state":"offline"}`.

When a reading is invalid (MAX31865 fault, open/short, or outside
-100 °C…150 °C), the device publishes `{"valid":false,"fault":N}` **without** a
`temp` field. The sensor then looks stale/offline in the dashboard instead of
recording a fake temperature. Wiring faults can never poison the history.

## OTA behavior

- On boot the device publishes `hello` (group, version, hw) and subscribes to
  `ota/<group>/update` and `ota/<device_id>/update`.
- Commands are **queued**, not executed in the MQTT callback; `otaLoop()` does
  the download so WiFi and the MQTT keepalive stay serviced.
- Updates are downloaded over HTTP(S), **SHA-256 verified**, then staged via
  Arduino-Pico's `Updater` and applied on reboot. A hash mismatch aborts and
  leaves the running firmware intact.
- Only URLs under `OTA_BASE_URL` are accepted, and only manifests/commands
  tagged `hw == "pico-w"` are honoured — a misconfigured server cannot push an
  ESP32 image to a Pico.
- Failed downloads are retried up to `OTA_MAX_ATTEMPTS` with a delay; the
  device never reboots on failure.
- The device also polls `GET <OTA_BASE_URL>/api/firmware/manifest?hw=pico-w`
  every `OTA_POLL_MS` as a fallback, and once ~45 s after boot.

## Recovery / safety

- **Boot guard:** consecutive unhealthy boots are counted in EEPROM. After 5
  boots without a healthy MQTT session, the device enters *safe mode*: it never
  auto-reboots on WiFi loss, keeps retrying, and keeps the OTA path alive, so a
  bad image can still be replaced remotely.
- **Power loss during OTA:** the Arduino-Pico OTA bootloader resumes from flash,
  so an interrupted update does not require a USB recovery as long as the
  bootloader itself is not being rewritten.
- **Last resort:** hold BOOTSEL and re-flash over USB. Keep physical access to
  at least one unit per site.

## Troubleshooting

| Symptom | Check |
|---|---|
| `sensors begun` but `temp` missing / `valid:false` | SPI pins vs. wiring, sensor `RREF`, 3-wire jumper |
| No MQTT connection | WiFi credentials, `MQTT_BROKER`, broker user/password |
| `ota: rejected update command` | command `hw`/URL does not match this device |
| `update begin failed (err 4)` | image larger than the 1 MB LittleFS staging area |
| Device never boots after OTA | USB BOOTSEL recovery; verify the image was built for 2 MB flash |
