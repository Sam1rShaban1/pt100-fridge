// Host tests for firmware/src/policy.h.
//
// These compile the exact header the device firmware compiles, so a
// regression in the OTA/sensor safety rules fails here before it can strand a
// remote unit.
#include "../src/policy.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

static int failures = 0;
static int checks = 0;

#define CHECK(cond)                                                       \
  do {                                                                    \
    checks++;                                                             \
    if (!(cond)) {                                                        \
      failures++;                                                         \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);              \
    }                                                                     \
  } while (0)

static void test_sha_shape() {
  const char* good = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const char* upper = "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD";
  CHECK(fw::isHexSha(good));
  CHECK(fw::isHexSha(upper));
  CHECK(!fw::isHexSha(nullptr));
  CHECK(!fw::isHexSha(""));
  CHECK(!fw::isHexSha("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015a"));
  CHECK(!fw::isHexSha("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015add"));
  CHECK(!fw::isHexSha("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015az"));
  CHECK(!fw::isHexSha("ba7816bf8f01cfea 14140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  CHECK(!fw::isHexSha("' OR 1=1 --                                                       "));
}

static void test_url_allowlist() {
  const char* base = "http://192.168.0.126:8010";
  CHECK(fw::urlUnderBase("http://192.168.0.126:8010/firmware/2.0.0-pico-w.bin", base));
  CHECK(fw::urlUnderBase("http://192.168.0.126:8010/", base));
  CHECK(fw::urlUnderBase(base, base));

  // Prefix tricks must not escape the configured server.
  CHECK(!fw::urlUnderBase("http://192.168.0.126:8010.evil/fw.bin", base));
  CHECK(!fw::urlUnderBase("http://192.168.0.126:80100/fw.bin", base));
  CHECK(!fw::urlUnderBase("http://192.168.0.126:8011/fw.bin", base));
  CHECK(!fw::urlUnderBase("https://192.168.0.126:8010/fw.bin", base));
  CHECK(!fw::urlUnderBase("http://evil.example/fw.bin", base));
  CHECK(!fw::urlUnderBase("", base));
  CHECK(!fw::urlUnderBase(nullptr, base));
  CHECK(!fw::urlUnderBase("http://192.168.0.126:8010/fw.bin", ""));
  CHECK(!fw::urlUnderBase("http://192.168.0.126:8010/fw.bin", nullptr));

  // Base without a trailing slash accepts both file and root URLs.
  const char* bare = "https://ota.example.org";
  CHECK(fw::urlUnderBase("https://ota.example.org/fw.bin", bare));
  CHECK(fw::urlUnderBase("https://ota.example.org/", bare));
}

static void test_versions() {
  CHECK(fw::versionNewer("1.0.1", "1.0.0"));
  CHECK(fw::versionNewer("1.1.0", "1.0.9"));
  CHECK(fw::versionNewer("2.0.0", "1.99.99"));
  CHECK(fw::versionNewer("1.10.0", "1.9.0"));
  CHECK(!fw::versionNewer("1.0.0", "1.0.0"));
  CHECK(!fw::versionNewer("1.0.0", "1.0.1"));
  CHECK(!fw::versionNewer("0.9.9", "1.0.0"));
  CHECK(!fw::versionNewer("garbage", "1.0.0"));
  CHECK(!fw::versionNewer("1.0", "1.0.0"));
  CHECK(!fw::versionNewer("", "1.0.0"));
  CHECK(!fw::versionNewer(nullptr, "1.0.0"));
  CHECK(!fw::versionNewer("1.0.0", nullptr));
}

static void test_update_acceptance() {
  // Newer is accepted, with or without the server's force flag.
  CHECK(fw::updateAcceptable("2.0.1", "2.0.0", false));
  CHECK(fw::updateAcceptable("2.0.1", "2.0.0", true));
  CHECK(fw::updateAcceptable("3.0.0", "2.9.9", true));

  // force must never turn a downgrade or reinstall into an accepted update:
  // an unauthenticated publisher could otherwise force an old/broken image.
  CHECK(!fw::updateAcceptable("1.9.9", "2.0.0", false));
  CHECK(!fw::updateAcceptable("1.9.9", "2.0.0", true));
  CHECK(!fw::updateAcceptable("2.0.0", "2.0.0", false));
  CHECK(!fw::updateAcceptable("2.0.0", "2.0.0", true));
  CHECK(!fw::updateAcceptable("latest", "2.0.0", true));
  CHECK(!fw::updateAcceptable(nullptr, "2.0.0", true));
}

static void test_hw_compat() {
  CHECK(fw::hwCompatible("pico-w", "pico-w"));
  CHECK(fw::hwCompatible("PICO-W", "pico-w"));
  CHECK(!fw::hwCompatible("esp32", "pico-w"));
  CHECK(!fw::hwCompatible("pico", "pico-w"));
  CHECK(fw::hwCompatible("", "pico-w"));        // empty tag tolerated
  CHECK(fw::hwCompatible(nullptr, "pico-w"));    // absent tag tolerated
  CHECK(!fw::hwCompatible("pico-w", nullptr));   // no target: refuse
  CHECK(!fw::hwCompatible("pico-w", ""));
}

static void test_image_size() {
  const uint32_t max = 900UL * 1024UL;
  CHECK(fw::imageSizeOk(1024, 1024, max));
  CHECK(fw::imageSizeOk(1024, 0, max));       // size unknown in manifest
  CHECK(fw::imageSizeOk(max, max, max));      // boundary is allowed
  CHECK(!fw::imageSizeOk(0, 0, max));         // no/unknown length
  CHECK(!fw::imageSizeOk(max + 1, 0, max));
  CHECK(!fw::imageSizeOk(1024, 1025, max));   // manifest mismatch
  CHECK(!fw::imageSizeOk(0, 1024, max));
}

static void test_readings() {
  const float tmin = -100.0f, tmax = 150.0f, omin = 20.0f, omax = 450.0f;
  CHECK(fw::readingValid(-18.5f, 92.7f, 0, tmin, tmax, omin, omax));
  CHECK(fw::readingValid(0.0f, 100.0f, 0, tmin, tmax, omin, omax));
  CHECK(fw::readingValid(tmin, omin, 0, tmin, tmax, omin, omax));  // inclusive
  CHECK(fw::readingValid(tmax, omax, 0, tmin, tmax, omin, omax));

  CHECK(!fw::readingValid(-18.5f, 92.7f, 1, tmin, tmax, omin, omax));  // fault
  CHECK(!fw::readingValid(-18.5f, 92.7f, 255, tmin, tmax, omin, omax));
  CHECK(!fw::readingValid(-101.0f, 100.0f, 0, tmin, tmax, omin, omax));
  CHECK(!fw::readingValid(151.0f, 100.0f, 0, tmin, tmax, omin, omax));
  CHECK(!fw::readingValid(-18.0f, 19.9f, 0, tmin, tmax, omin, omax));
  CHECK(!fw::readingValid(-18.0f, 450.1f, 0, tmin, tmax, omin, omax));

  // NaN/inf must never look like a temperature.
  CHECK(!fw::readingValid(NAN, 100.0f, 0, tmin, tmax, omin, omax));
  CHECK(!fw::readingValid(INFINITY, 100.0f, 0, tmin, tmax, omin, omax));
  CHECK(!fw::readingValid(-INFINITY, 100.0f, 0, tmin, tmax, omin, omax));
  CHECK(!fw::readingValid(-18.0f, NAN, 0, tmin, tmax, omin, omax));
  CHECK(!fw::readingValid(-18.0f, INFINITY, 0, tmin, tmax, omin, omax));
}

static void test_boot_guard() {
  CHECK(fw::nextBootCount(0) == 1);
  CHECK(fw::nextBootCount(4) == 5);
  CHECK(fw::nextBootCount(254) == 255);
  CHECK(fw::nextBootCount(255) == 255);  // saturates, never wraps to 0

  CHECK(!fw::safeModeAt(0, 5));
  CHECK(!fw::safeModeAt(4, 5));
  CHECK(fw::safeModeAt(5, 5));
  CHECK(fw::safeModeAt(255, 5));
}

int main() {
  test_sha_shape();
  test_url_allowlist();
  test_versions();
  test_update_acceptance();
  test_hw_compat();
  test_image_size();
  test_readings();
  test_boot_guard();
  if (failures) {
    printf("%d/%d policy checks FAILED\n", failures, checks);
    return 1;
  }
  printf("policy: %d checks passed\n", checks);
  return 0;
}
