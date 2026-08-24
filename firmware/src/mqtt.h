#pragma once
#include <PubSubClient.h>
#include <WiFiClientSecure.h>

extern WiFiClientSecure mqttNet;
extern PubSubClient mqtt;

void mqttInit();
bool mqttConnect();
void mqttLoop();
bool mqttPublish(const char* topic, const char* payload, bool retain = false);
void mqttSubscribe(const char* topic);
