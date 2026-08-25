#include "ota.h"
#include "config.h"
#include "certs.h"
#include "mqtt.h"

#include <ArduinoJson.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <mbedtls/sha256.h>

// ---------------- helpers ----------------

static int semverGt(const char* a, const char* b) {
  int ax, ay, az, bx, by, bz;
  if (sscanf(a, "%d.%d.%d", &ax, &ay, &az) < 3) return 0;
  if (sscanf(b, "%d.%d.%d", &bx, &by, &bz) < 3) return 0;
  if (ax != bx) return ax > bx;
  if (ay != by) return ay > by;
  return az > bz;
}

static bool sha256Matches(const uint8_t* hash, const char* hex) {
  // hex is expected lowercase (server sends hashlib hexdigest)
  char calc[65];
  for (int i = 0; i < 32; i++) sprintf(calc + 2 * i, "%02x", hash[i]);
  calc[64] = 0;
  return strcmp(calc, hex) == 0;
}

// ---------------- status reporting ----------------

void otaPublishStatus(const char* state, const char* version) {
  StaticJsonDocument<128> doc;
  doc["state"] = state;
  doc["version"] = version;
  char buf[128];
  serializeJson(doc, buf);
  mqttPublish((String("ota/") + DEVICE_ID + "/status").c_str(), buf);
}

// ---------------- the actual update ----------------

static void doUpdate(const char* url, const char* sha256Hex, const char* newVer) {
  otaPublishStatus("downloading", newVer);

#ifdef LOCAL_DEV
  WiFiClient client;
#else
  WiFiClientSecure client;
  client.setCACert(ISRG_X1_ROOT);   // HTTPS cert issued by Caddy/Let's Encrypt
#endif
  client.setTimeout(30000);

  HTTPClient http;
  if (!http.begin(client, url)) { otaPublishStatus("failed", FW_VERSION); return; }

  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    http.end();
    otaPublishStatus("failed", FW_VERSION);
    return;
  }

  int total = http.getSize();
  if (total <= 0 || !Update.begin(total)) {
    http.end();
    otaPublishStatus("failed", FW_VERSION);
    return;
  }

  mbedtls_sha256_context ctx;
  uint8_t hash[32];
  mbedtls_sha256_starts_ret(&ctx, 0);

  WiFiClient* stream = http.getStreamPtr();
  uint8_t buf[1024];
  int r;
  while ((r = stream->readBytes(buf, sizeof(buf))) > 0) {
    mbedtls_sha256_update_ret(&ctx, buf, r);
    Update.write(buf, r);
  }
  mbedtls_sha256_finish_ret(&ctx, hash);
  http.end();

  if (!sha256Matches(hash, sha256Hex)) {
    Update.end(false);
    otaPublishStatus("failed", FW_VERSION);
    return;
  }

  if (Update.end(true)) {
    otaPublishStatus("success", newVer);
    delay(500);
    ESP.restart();
  } else {
    otaPublishStatus("failed", FW_VERSION);
  }
}

// ---------------- entry points ----------------

void otaInit() {
  StaticJsonDocument<160> doc;
  doc["group"] = GROUP;
  doc["version"] = FW_VERSION;
  char buf[160];
  serializeJson(doc, buf);
  mqttPublish((String("ota/") + DEVICE_ID + "/hello").c_str(), buf);
}

void otaHandleCommand(const char* topic, const char* payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return;
  const char* url = doc["url"];
  const char* sha = doc["sha256"];
  const char* ver = doc["version"];
  if (!url || !sha || !ver) return;
  if (semverGt(ver, FW_VERSION)) {
    doUpdate(url, sha, ver);
  }
}

void otaCheckManifest() {
#ifdef LOCAL_DEV
  WiFiClient client;
#else
  WiFiClientSecure client;
  client.setCACert(ISRG_X1_ROOT);
#endif
  client.setTimeout(15000);

  HTTPClient http;
  String url = String(OTA_BASE_URL) + "/api/firmware/manifest?device_id=" + DEVICE_ID
             + "&group=" + GROUP + "&current=" + FW_VERSION;
  if (!http.begin(client, url)) return;

  int code = http.GET();
  if (code != HTTP_CODE_OK) { http.end(); return; }
  String body = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, body)) return;
  const char* u = doc["url"];
  const char* s = doc["sha256"];
  const char* v = doc["version"];
  if (u && s && v && semverGt(v, FW_VERSION)) {
    doUpdate(u, s, v);
  }
}
