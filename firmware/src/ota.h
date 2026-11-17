#pragma once
#include <Arduino.h>

// OTA for the Pico W (Arduino-Pico Updater).
//
// Network work never happens inside the MQTT callback: commands are validated,
// queued, and executed from otaLoop() so the WiFi stack and the MQTT keepalive
// stay serviced. Every image is SHA-256 verified before it is staged, and the
// Pico bootloader only applies a staged image after a reboot.

void otaInit();                  // publishes the "hello" with group/version/hw
void otaLoop();                  // call every loop iteration (does queued work)
void otaRequestManifestCheck();  // ask for a manifest poll on the next otaLoop()
void otaHandleCommand(const char* topic, const char* payload);  // MQTT trigger
void otaPublishStatus(const char* state, const char* version);
