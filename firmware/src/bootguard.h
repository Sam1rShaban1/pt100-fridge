#pragma once
#include <Arduino.h>

// Boot-loop protection.
//
// A firmware image that cannot associate with WiFi would otherwise reboot
// forever (the WiFi manager reboots after 10 minutes of downtime), and a
// device stuck in that loop can never be reached to be fixed. The boot guard
// counts consecutive unhealthy boots in EEPROM and puts the device into a
// "safe mode" that never reboots on its own, keeps retrying the network, and
// keeps the OTA path alive.

void bootGuardInit();
bool bootGuardSafeMode();
void bootGuardMarkHealthy();   // call once the device has been healthy for a while
uint8_t bootGuardBootCount();
