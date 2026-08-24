#include "config.h"
#include "certs.h"
#include "sensors.h"
#include "mqtt.h"
#include "ota.h"

#include <ArduinoJson.h>
#include <WiFi.h>

SensorArray sensors;

void setup() {
  Serial.begin(115200);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected");

  // Build the sensor list from SENSOR_DEFS in config.h
  #define SENSOR(id, cs) sensors.add(#id, cs);
  SENSOR_DEFS
  #undef SENSOR
  sensors.begin(MAX31865_3WIRE);

  mqttInit();
  mqttConnect();
  otaInit();
}

unsigned long lastPub = 0;
unsigned long lastPoll = 0;

void loop() {
  mqttLoop();

  unsigned long now = millis();

  if (now - lastPub >= PUBLISH_MS) {
    lastPub = now;
    StaticJsonDocument<256> doc;
    for (size_t i = 0; i < sensors.count(); i++) {
      float t, r;
      uint8_t f;
      sensors.readAt(i, t, r, f);
      doc.clear();
      doc["temp"] = round(t * 100.0f) / 100.0f;
      doc["resistance"] = round(r * 100.0f) / 100.0f;
      doc["fault"] = f;
      char buf[128];
      serializeJson(doc, buf);
      mqttPublish((String("pt100/") + sensors.idAt(i)).c_str(), buf);
    }
  }

  if (now - lastPoll >= OTA_POLL_MS) {
    lastPoll = now;
    otaCheckManifest();
  }
}

// Called by the MQTT callback in mqtt.cpp
void onMqttMessage(char* topic, byte* payload, unsigned int len) {
  String t(topic);
  if (t.startsWith("ota/")) {
    char p[len + 1];
    memcpy(p, payload, len);
    p[len] = 0;
    otaHandleCommand(topic, p);
  }
}
