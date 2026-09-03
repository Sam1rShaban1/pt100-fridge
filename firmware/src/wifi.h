#pragma once
#include <Arduino.h>

// Robust WiFi manager: non-blocking, exponential backoff, auto-reboot.
// Call wifiInit() once in setup(), wifiLoop() every loop() iteration.

void wifiInit();
bool wifiLoop();              // returns true if connected, handles reconnect
bool wifiIsConnected();
int  wifiRSSI();
unsigned long wifiConnectedSince(); // millis() when last connected, 0 if never
unsigned long wifiDisconnectedMs(); // ms since disconnect, 0 if connected
