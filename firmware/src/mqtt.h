#pragma once
#include "config.h"
#include <PubSubClient.h>
#ifdef LOCAL_DEV
#include <WiFi.h>
extern WiFiClient mqttNet;
#else
#include <WiFiClientSecure.h>
extern WiFiClientSecure mqttNet;
#endif
extern PubSubClient mqtt;

void mqttInit();
bool mqttConnect();
void mqttLoop();
bool mqttPublish(const char* topic, const char* payload, bool retain = false);
void mqttSubscribe(const char* topic);
