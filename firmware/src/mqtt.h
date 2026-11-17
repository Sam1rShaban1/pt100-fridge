#pragma once
#include "config.h"
#include <PubSubClient.h>
#include <WiFi.h>
extern WiFiClient mqttNet;
extern PubSubClient mqtt;

// Service an existing MQTT session only. Never starts a new connection, so it
// is safe to call from a long OTA download: it keeps the broker keepalive fed
// without blocking on a TCP/TLS handshake.
void mqttService();

void mqttInit();
bool mqttConnect();
void mqttLoop();
bool mqttPublish(const char* topic, const char* payload, bool retain = false);
void mqttSubscribe(const char* topic);
bool mqttIsConnected();
