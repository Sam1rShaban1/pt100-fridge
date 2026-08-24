#include "mqtt.h"
#include "config.h"
#include "certs.h"

WiFiClientSecure mqttNet;
PubSubClient mqtt(mqttNet);

// Implemented in main.cpp
extern void onMqttMessage(char* topic, byte* payload, unsigned int len);

static void mqttCallback(char* topic, byte* payload, unsigned int len) {
  onMqttMessage(topic, payload, len);
}

void mqttInit() {
  mqttNet.setCACert(MQTT_ROOT_CA);
  mqttNet.setTimeout(15000);
  mqtt.setServer(MQTT_BROKER, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(1024);
}

bool mqttConnect() {
  String id = String("pt100-") + DEVICE_ID;
  String lwtTopic = String("ota/") + DEVICE_ID + "/status";
  String lwtMsg = "{\"state\":\"offline\"}";
  while (!mqtt.connected()) {
    if (mqtt.connect(id.c_str(), MQTT_USER, MQTT_PASSWORD,
                     lwtTopic.c_str(), 1, true, lwtMsg.c_str())) {
      mqtt.subscribe((String("ota/") + GROUP + "/update").c_str());
      mqtt.subscribe((String("ota/") + DEVICE_ID + "/update").c_str());
      return true;
    }
    delay(3000);
  }
  return false;
}

void mqttLoop() {
  if (!mqtt.connected()) mqttConnect();
  mqtt.loop();
}

bool mqttPublish(const char* topic, const char* payload, bool retain) {
  if (!mqtt.connected()) mqttConnect();
  if (!mqtt.connected()) return false;
  return mqtt.publish(topic, (const char*)payload, retain);
}

void mqttSubscribe(const char* topic) {
  mqtt.subscribe(topic);
}
