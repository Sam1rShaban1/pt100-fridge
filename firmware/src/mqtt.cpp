#include "mqtt.h"
#include "config.h"
#include "certs.h"

#ifdef LOCAL_DEV
WiFiClient mqttNet;
#else
WiFiClientSecure mqttNet;
#endif
PubSubClient mqtt(mqttNet);

// Implemented in main.cpp
extern void onMqttMessage(char* topic, byte* payload, unsigned int len);

static void mqttCallback(char* topic, byte* payload, unsigned int len) {
  onMqttMessage(topic, payload, len);
}

void mqttInit() {
#ifndef LOCAL_DEV
  mqttNet.setCACert(MQTT_ROOT_CA);
#endif
  mqttNet.setTimeout(15000);
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(1024);
}

static void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.println("WiFi lost, reconnecting...");
  WiFi.reconnect();
  unsigned long t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 10000) {
    delay(200);
  }
}

bool mqttConnect() {
  if (mqtt.connected()) return true;
  String id = String("pt100-") + DEVICE_ID;
  String lwtTopic = String("ota/") + DEVICE_ID + "/status";
  String lwtMsg = "{\"state\":\"offline\"}";
  if (mqtt.connect(id.c_str(), MQTT_USER, MQTT_PASSWORD,
                   lwtTopic.c_str(), 1, true, lwtMsg.c_str())) {
    mqtt.subscribe((String("ota/") + GROUP + "/update").c_str());
    mqtt.subscribe((String("ota/") + DEVICE_ID + "/update").c_str());
    Serial.println("MQTT connected");
    return true;
  }
  Serial.printf("MQTT connect failed, state=%d (broker=%s:%d)\n",
                mqtt.state(), MQTT_BROKER, MQTT_PORT);
  return false;
}

void mqttLoop() {
  ensureWifi();
  static unsigned long lastTry = 0;
  if (!mqtt.connected()) {
    unsigned long now = millis();
    if (now - lastTry >= 3000) {
      lastTry = now;
      mqttConnect();
    }
  } else {
    mqtt.loop();
  }
}

bool mqttPublish(const char* topic, const char* payload, bool retain) {
  if (!mqtt.connected()) mqttConnect();
  if (!mqtt.connected()) return false;
  return mqtt.publish(topic, (const char*)payload, retain);
}

void mqttSubscribe(const char* topic) {
  mqtt.subscribe(topic);
}
