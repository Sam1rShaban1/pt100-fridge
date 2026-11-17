#pragma once
#include <stdint.h>
#include <stddef.h>

// Portable SHA-256. Used to verify an OTA image before it is staged, without
// depending on mbedtls (ESP32) or BearSSL (RP2040) internals.
class Sha256 {
 public:
  Sha256() { begin(); }
  void begin();
  void update(const uint8_t* data, size_t len);
  void finish(uint8_t out[32]);

  // Lowercase hex digest, out must have room for 65 bytes.
  static void hex(const uint8_t digest[32], char out[65]);

 private:
  void transform(const uint8_t* chunk);

  uint32_t h_[8];
  uint64_t len_;
  uint8_t buf_[64];
  size_t bufLen_;
};
