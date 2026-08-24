#pragma once
#include <Arduino.h>

// ===================== WiFi =====================
#define WIFI_SSID      "YOUR_WIFI_SSID"
#define WIFI_PASSWORD  "YOUR_WIFI_PASSWORD"

// ===================== Device identity (set per device) =====================
#define DEVICE_ID      "fridge-001"
#define GROUP          "zone_a"
#define FW_VERSION     "1.0.0"   // bump this on every firmware release

// ===================== MQTT (over TLS, internet) =====================
// The broker must serve a certificate signed by backend/mosquitto/certs/ca.crt
#define MQTT_BROKER    "mqtt.example.com"
#define MQTT_PORT      8883
#define MQTT_USER      "fridge-001"
#define MQTT_PASSWORD  "DEVICE_MQTT_PASSWORD"

// ===================== OTA =====================
// Base URL of the OTA server (served by Caddy + Let's Encrypt). Firmware is
// downloaded from <OTA_BASE_URL>/firmware/<file> over HTTPS.
#define OTA_BASE_URL   "https://ota.example.com"
#define OTA_POLL_MS    3600000UL   // check the manifest once per hour

// ===================== Sensors =====================
#define PUBLISH_MS     5000UL
#define RREF           430.0f      // PT100 reference resistor (0.1%)
#define RNOMINAL       100.0f      // PT100 resistance at 0 C

// Sensor list: add one line per PT100/MAX31865 (id, CS pin).
// They share the ESP32 VSPI bus (SCLK=18, MOSI=23, MISO=19).
#define SENSOR_DEFS \
  SENSOR(fridge_top, 5) \
  SENSOR(fridge_mid, 4) \
  SENSOR(freezer,    2)
