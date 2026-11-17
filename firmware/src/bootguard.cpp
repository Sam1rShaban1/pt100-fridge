#include "bootguard.h"
#include "config.h"
#include "policy.h"

#include <EEPROM.h>

// The EEPROM emulation exists on RP2040 and is stored in its own flash sector,
// so this never interferes with the filesystem used for OTA staging.
static const int ADDR_MAGIC = 0;
static const int ADDR_COUNT = 1;
static const uint8_t MAGIC = 0x5A;

static uint8_t s_bootCount = 0;
static bool s_safeMode = false;
static bool s_healthy = false;

void bootGuardInit() {
  EEPROM.begin(16);
  bool known = EEPROM.read(ADDR_MAGIC) == MAGIC;
  s_bootCount = fw::nextBootCount(known ? (uint8_t)EEPROM.read(ADDR_COUNT) : 0);
  EEPROM.write(ADDR_MAGIC, MAGIC);
  EEPROM.write(ADDR_COUNT, s_bootCount);
  EEPROM.commit();

  s_safeMode = fw::safeModeAt(s_bootCount, BOOT_SAFE_THRESHOLD);
  Serial.printf("bootguard: boot #%u%s\n", s_bootCount,
                s_safeMode ? " -> SAFE MODE (auto-reboot disabled)" : "");
}

bool bootGuardSafeMode() {
  return s_safeMode;
}

uint8_t bootGuardBootCount() {
  return s_bootCount;
}

void bootGuardMarkHealthy() {
  if (s_healthy || s_bootCount == 0) {
    return;
  }
  s_healthy = true;
  s_bootCount = 0;
  EEPROM.write(ADDR_COUNT, 0);
  EEPROM.commit();
  Serial.println("bootguard: healthy boot, counter cleared");
}
