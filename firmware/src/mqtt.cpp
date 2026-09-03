#include "mqtt.h"
#include "config.h"
#include "certs.h"
#include "wifi.h"

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

bool mqttConnect() {
  if (!wifiIsConnected()) return false;
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
  if (!wifiIsConnected()) return;
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
  if (!wifiIsConnected()) return false;
  if (!mqtt.connected() && !mqttConnect()) return false;
  if (!mqtt.connected()) return false;
  bool ok = mqtt.publish(topic, (const char*)payload, retain);
  if (!ok) {
    Serial.printf("MQTT publish failed topic=%s state=%d — resetting client\n", topic, mqtt.state());
    mqtt.disconnect();
  }
  return ok;
}

void mqttSubscribe(const char* topic) {
  mqtt.subscribe(topic);
}
