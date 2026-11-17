#pragma once
#include <Arduino.h>

// ===================== Hardware target =====================
// This firmware targets the Raspberry Pi Pico W (RP2040, Arduino-Pico core).
// The OTA server keys firmware per board, so HW_TARGET must match the value
// used when the image was uploaded ("pico-w").
#define HW_TARGET      "pico-w"

// ===================== Local dev mode =====================
// When defined, the firmware uses PLAINTEXT MQTT (1883) and HTTP OTA so it can
// talk to the Docker stack on your LAN without valid certificates.
// Comment this out (and restore the CA configuration) for production/internet.
#define LOCAL_DEV

// ===================== WiFi =====================
#define WIFI_SSID      "MVDSI"
#define WIFI_PASSWORD  "mvdsi30406"

// ===================== Device identity (set per device) =====================
#define DEVICE_ID      "fridge-001"
#define GROUP          "zone_a"
#define FW_VERSION     "2.0.0"   // bump on every firmware release

// ===================== MQTT (plain TCP, no TLS) =====================
#define MQTT_BROKER    "192.168.1.23"
#define MQTT_PORT      1883
#define MQTT_USER      "fridge-001"
#define MQTT_PASSWORD  "localdev-pass"

// ===================== OTA =====================
// LOCAL_DEV: plain HTTP to the ota-server container (port 8010 published).
// Production: https://ota.yourdomain.com (Caddy + Let's Encrypt).
#define OTA_BASE_URL   "http://192.168.0.126:8010"
#define OTA_POLL_MS    3600000UL    // manifest check interval (1 hour)
#define OTA_HTTP_TIMEOUT_MS 20000   // connect/read timeout
#define OTA_STALL_TIMEOUT_MS 15000  // abort if no bytes for this long
#define OTA_MAX_IMAGE_BYTES (900UL * 1024UL)  // must fit the sketch region
#define OTA_MAX_ATTEMPTS 3          // per requested update, then give up
#define OTA_RETRY_MS    15000UL     // between failed apply attempts
#define OTA_CHUNK_BYTES 1024

// ===================== Sensors =====================
#define PUBLISH_MS     1000UL
#define RREF           430.0f      // PT100 reference resistor (0.1%) -> SMD "431" = 430R
#define RNOMINAL       100.0f      // PT100 resistance at 0 C

// SPI0 pins on the Pico W. Change these to match your wiring.
#define PIN_SPI_SCK    18
#define PIN_SPI_MISO   16
#define PIN_SPI_MOSI   19
#define PIN_SENSOR_CS  17

// Plausibility window for a cold-chain PT100 reading. Anything outside this
// (or any MAX31865 fault) is treated as invalid and is NOT published as a
// temperature, so wiring faults can never poison the history.
#define SENSOR_MIN_VALID_C    (-100.0f)
#define SENSOR_MAX_VALID_C    (150.0f)
#define SENSOR_MIN_VALID_OHM  (20.0f)
#define SENSOR_MAX_VALID_OHM  (450.0f)

// ===================== Boot guard =====================
// Consecutive boots without a healthy run before entering safe mode (no
// automatic reboots, so a bad image can still be OTA-recovered).
#define BOOT_SAFE_THRESHOLD 5
#define HEALTHY_UPTIME_MS   60000UL

// Sensor list: one line per PT100/MAX31865 (id, CS pin).
#define SENSOR_DEFS \
  SENSOR(fridge_top, PIN_SENSOR_CS)
