#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>

// Pure decision helpers used by the firmware.
//
// These are deliberately free of Arduino/HTTP/EEPROM dependencies so the exact
// code that runs on the device can be compiled and exercised on a host
// (firmware/tests). Anything in here is a safety decision: getting it wrong
// can brick a remote unit, so it is covered by tests.
namespace fw {

// A manifest/command checksum must be exactly 64 hex characters. Rejecting
// anything else prevents "verify" from silently passing on a truncated hash.
inline bool isHexSha(const char* s) {
  if (!s || strlen(s) != 64) return false;
  for (size_t i = 0; i < 64; i++) {
    if (!isxdigit((unsigned char)s[i])) return false;
  }
  return true;
}

// True only for a URL under `base` followed by '/' or end-of-string.
// This rejects prefix tricks such as:
//   base http://host:8010
//   http://host:8010.evil/x   (next char '.')
//   http://host:80100/x       (next char '0')
// so a hijacked MQTT topic cannot redirect the updater off-server.
inline bool urlUnderBase(const char* url, const char* base) {
  if (!url || !base) return false;
  size_t n = strlen(base);
  if (n == 0) return false;
  if (strncmp(url, base, n) != 0) return false;
  return url[n] == '/' || url[n] == '\0';
}

// Is `a` a newer semantic version than `b`? Malformed versions are never
// considered newer, so a bad manifest cannot force a downgrade loop.
inline bool versionNewer(const char* a, const char* b) {
  int ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0;
  if (!a || !b) return false;
  if (sscanf(a, "%d.%d.%d", &ax, &ay, &az) < 3) return false;
  if (sscanf(b, "%d.%d.%d", &bx, &by, &bz) < 3) return false;
  if (ax != bx) return ax > bx;
  if (ay != by) return ay > by;
  return az > bz;
}

// May this update command/manifest be installed at all?
//
// Only a strictly newer version is accepted. A `force` flag coming over MQTT
// deliberately does NOT bypass this: the broker has no per-topic ACL, and
// allowing arbitrary downgrades is the easiest way to put a remote, physically
// inaccessible unit back onto a broken or incompatible image. Rollbacks are
// done by publishing a new version number, which also keeps rollout
// bookkeeping monotonic.
inline bool updateAcceptable(const char* candidate, const char* current,
                             bool /*force*/) {
  return versionNewer(candidate, current);
}

// Does a hardware tag from a manifest/command apply to this device?
// A missing tag is tolerated (older server builds), but any tag that is
// present and different must be refused: that is the cross-board brick case.
inline bool hwCompatible(const char* reported, const char* target) {
  if (!target || !*target) return false;
  if (!reported || !*reported) return true;
  return strcasecmp(reported, target) == 0;
}

// Content-Length / manifest size sanity for an OTA image.
// `expected` 0 means the manifest did not declare a size.
inline bool imageSizeOk(uint32_t contentLength, uint32_t expected, uint32_t maxBytes) {
  if (contentLength == 0 || contentLength > maxBytes) return false;
  if (expected != 0 && expected != contentLength) return false;
  return true;
}

// A PT100 reading is usable only when the MAX31865 reports no fault and both
// temperature and resistance land inside the plausibility window. NaN/inf fail
// the comparisons, and any comparison failure is treated as invalid, so a
// broken probe can never be recorded as a real cold-chain temperature.
inline bool readingValid(float tempC, float ohms, uint8_t fault,
                         float tMin, float tMax, float oMin, float oMax) {
  if (fault != 0) return false;
  if (!(tempC >= tMin && tempC <= tMax)) return false;
  if (!(ohms >= oMin && ohms <= oMax)) return false;
  return true;
}

// Boot guard counters saturate instead of wrapping (255 -> 0 would look like a
// healthy first boot and could re-enable auto-reboot on a failing image).
inline uint8_t nextBootCount(uint8_t prev) {
  return prev < 255 ? (uint8_t)(prev + 1) : 255;
}

inline bool safeModeAt(uint8_t count, uint8_t threshold) {
  return count >= threshold;
}

}  // namespace fw
