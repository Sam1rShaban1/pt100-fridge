#include "config.h"
#include "certs.h"
#include "sensors.h"
#include "mqtt.h"
#include "ota.h"
#include "wifi.h"

#include <ArduinoJson.h>
#include <WiFi.h>

SensorArray sensors;

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n=== %s %s group=%s ===\n", DEVICE_ID, FW_VERSION, GROUP);

  wifiInit();
  // Don't block on WiFi — the wifi manager will reconnect in loop().
  // Give it a brief window to associate so first boot logs are useful.
  unsigned long t0 = millis();
  while (!wifiIsConnected() && millis() - t0 < 4000) {
    wifiLoop();
    delay(100);
  }
  if (wifiIsConnected()) {
    Serial.print("WiFi connected IP=");  Serial.println(WiFi.localIP());
    Serial.print("GW=");  Serial.println(WiFi.gatewayIP());
  } else {
    Serial.println("WiFi not yet connected — will retry in background");
  }
  Serial.print("MQTT target="); Serial.print(MQTT_BROKER); Serial.print(":"); Serial.println(MQTT_PORT);

  // Build the sensor list from SENSOR_DEFS in config.h
  #define SENSOR(id, cs) sensors.add(#id, cs);
  SENSOR_DEFS
  #undef SENSOR
  Serial.println("sensors added");
  sensors.begin(MAX31865_3WIRE);
  Serial.println("sensors begun");

  mqttInit();
  Serial.println("mqttInit done");
  mqttConnect();
  Serial.println("mqttConnect done");
  otaInit();
  Serial.println("otaInit done");
}

unsigned long lastPub = 0;
unsigned long lastPoll = 0;

void loop() {
  wifiLoop();
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
    if (wifiIsConnected()) otaCheckManifest();
  }

  // Optional: periodic WiFi health log (every 30s when disconnected)
  static unsigned long lastWifiLog = 0;
  if (!wifiIsConnected() && now - lastWifiLog > 30000) {
    lastWifiLog = now;
    Serial.printf("WiFi still disconnected %lus (status=%d)\n",
                  wifiDisconnectedMs() / 1000, (int)WiFi.status());
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
