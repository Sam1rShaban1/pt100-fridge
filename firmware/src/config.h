#pragma once
#include <Arduino.h>

// ===================== Local dev mode =====================
// When defined, the firmware uses PLAINTEXT MQTT (1883) and HTTP OTA
// so it can talk to the Docker stack on your LAN without valid certs.
// Comment this out (and restore certs) for production/internet use.
#define LOCAL_DEV

// ===================== WiFi =====================
#define WIFI_SSID      "MVDSI"
#define WIFI_PASSWORD  "mvdsi30406"

// ===================== Device identity (set per device) =====================
#define DEVICE_ID      "fridge-001"
#define GROUP          "zone_a"
#define FW_VERSION     "1.0.0"   // bump this on every firmware release

// ===================== MQTT =====================
// LOCAL_DEV: broker is this machine's LAN IP, plaintext port 1883.
// Production: set MQTT_BROKER to your domain (e.g. mqtt.yourdomain.com) and
// port 8883, and flash src/certs.h MQTT_ROOT_CA with backend/mosquitto/certs/ca.crt.
#define MQTT_BROKER    "192.168.1.175"
#define MQTT_PORT      1883
#define MQTT_USER      "fridge-001"
#define MQTT_PASSWORD  "localdev-pass"

// ===================== OTA =====================
// LOCAL_DEV: plain HTTP to the ota-server container (port 8000 published).
// Production: https://ota.yourdomain.com (served by Caddy + Let's Encrypt).
#define OTA_BASE_URL   "http://192.168.1.175:8010"
#define OTA_POLL_MS    3600000UL   // check the manifest once per hour

// ===================== Sensors =====================
#define PUBLISH_MS     500UL
#define RREF           430.0f      // PT100 reference resistor (0.1%) -> SMD "431" = 430R
#define RNOMINAL       100.0f      // PT100 resistance at 0 C

// Sensor list: add one line per PT100/MAX31865 (id, CS pin).
// They share the ESP32 VSPI bus (SCLK=18, MOSI=23, MISO=19).
#define SENSOR_DEFS \
  SENSOR(fridge_top, 5)
