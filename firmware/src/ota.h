#pragma once
#include <Arduino.h>

void otaInit();                 // publish a "hello" with group + version
void otaCheckManifest();        // poll the OTA server for a newer firmware
void otaHandleCommand(const char* topic, const char* payload); // MQTT-triggered update
void otaPublishStatus(const char* state, const char* version);
