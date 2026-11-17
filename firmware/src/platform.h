#pragma once
#include <Arduino.h>

// Small platform shim so the application code does not depend on ESP32-only
// symbols. This firmware targets the RP2040 (Pico W) only.

#if !defined(ARDUINO_ARCH_RP2040)
#error "This firmware targets the Raspberry Pi Pico W (Arduino-Pico core)."
#endif

#include <WiFi.h>

inline void ptRestart() {
  rp2040.restart();
}

inline uint32_t ptFreeHeap() {
  return rp2040.getFreeHeap();
}

inline uint32_t ptUptimeMs() {
  return millis();
}
