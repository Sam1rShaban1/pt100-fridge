#include "ota.h"
#include "config.h"
#include "certs.h"
#include "mqtt.h"
#include "platform.h"
#include "policy.h"
#include "sha256.h"
#include "wifi.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Updater.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ctype.h>
#include <string.h>
#include <strings.h>

// ---------------- request queue (no network work in callbacks) ----------------

struct OtaRequest {
  char url[192];
  char sha[65];
  char ver[16];
  uint32_t size;
};

static OtaRequest s_req;
static bool s_haveReq = false;
static bool s_checkRequested = false;
static bool s_busy = false;
static uint8_t s_attempts = 0;
static uint32_t s_nextAttemptMs = 0;
static uint32_t s_lastPollMs = 0;

// ---------------- helpers ----------------

static bool shaMatches(const uint8_t digest[32], const char* hex) {
  if (!hex || strlen(hex) != 64) return false;
  char calc[65];
  Sha256::hex(digest, calc);
  return strcasecmp(calc, hex) == 0;
}

// ---------------- status reporting ----------------

void otaPublishStatus(const char* state, const char* version) {
  JsonDocument doc;
  doc["state"] = state;
  doc["version"] = version;
  char buf[128];
  serializeJson(doc, buf);
  mqttPublish((String("ota/") + DEVICE_ID + "/status").c_str(), buf);
  Serial.printf("ota: %s (%s)\n", state, version);
}

// ---------------- download & stage ----------------

static bool downloadAndStage(const char* url, const char* shaHex, uint32_t expectSize,
                             char* err, size_t errLen) {
#ifdef LOCAL_DEV
  WiFiClient client;
#else
  WiFiClientSecure client;
  client.setCACert(ISRG_X1_ROOT);  // HTTPS cert issued by Caddy/Let's Encrypt
#endif
  client.setTimeout(OTA_HTTP_TIMEOUT_MS);

  HTTPClient http;
  http.setTimeout((uint16_t)OTA_HTTP_TIMEOUT_MS);
  if (!http.begin(client, String(url))) {
    snprintf(err, errLen, "http begin failed");
    return false;
  }

  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    snprintf(err, errLen, "http %d", code);
    http.end();
    return false;
  }

  int total = http.getSize();
  uint32_t totalBytes = total > 0 ? (uint32_t)total : 0;
  if (!fw::imageSizeOk(totalBytes, expectSize, OTA_MAX_IMAGE_BYTES)) {
    // Without a trustworthy length the Updater cannot reserve space; fail
    // loudly instead of guessing and writing a partial image. Oversized or
    // mismatched lengths are refused for the same reason.
    if (total <= 0) {
      snprintf(err, errLen, "missing content-length");
    } else if (totalBytes > OTA_MAX_IMAGE_BYTES) {
      snprintf(err, errLen, "image too large (%d bytes)", total);
    } else {
      snprintf(err, errLen, "size %d != expected %u", total, (unsigned)expectSize);
    }
    http.end();
    return false;
  }

  if (!Update.begin((size_t)total)) {
    snprintf(err, errLen, "update begin failed (err %u)", (unsigned)Update.getError());
    http.end();
    return false;
  }

  Sha256 sha;
  sha.begin();

  WiFiClient* stream = http.getStreamPtr();
  uint8_t buf[OTA_CHUNK_BYTES];
  uint32_t received = 0;
  uint32_t lastProgress = millis();
  uint32_t lastService = millis();
  bool ok = true;

  while (received < (uint32_t)total) {
    // Keep the broker's keepalive fed during a slow transfer. On a poor link a
    // 900 KB image takes long enough that an unserviced session would be
    // dropped, and the server would then see the device as offline mid-update.
    if ((uint32_t)(millis() - lastService) > 500) {
      lastService = millis();
      mqttService();
    }

    int avail = stream->available();
    if (avail <= 0) {
      if (!client.connected()) {
        snprintf(err, errLen, "connection lost at %u/%d", (unsigned)received, total);
        ok = false;
        break;
      }
      if ((uint32_t)(millis() - lastProgress) > OTA_STALL_TIMEOUT_MS) {
        snprintf(err, errLen, "stalled at %u/%d", (unsigned)received, total);
        ok = false;
        break;
      }
      delay(2);
      yield();
      continue;
    }

    size_t want = (size_t)avail < sizeof(buf) ? (size_t)avail : sizeof(buf);
    int r = stream->read(buf, want);
    if (r <= 0) {
      delay(2);
      continue;
    }

    sha.update(buf, (size_t)r);
    size_t written = Update.write(buf, (size_t)r);
    if (written != (size_t)r) {
      snprintf(err, errLen, "flash write failed (err %u)", (unsigned)Update.getError());
      ok = false;
      break;
    }
    received += (uint32_t)r;
    lastProgress = millis();
    yield();
  }

  http.end();

  if (!ok) {
    Update.end(false);  // discard staged data, keep running firmware
    return false;
  }
  if (received != (uint32_t)total) {
    snprintf(err, errLen, "short read %u/%d", (unsigned)received, total);
    Update.end(false);
    return false;
  }

  uint8_t digest[32];
  sha.finish(digest);
  if (!shaMatches(digest, shaHex)) {
    snprintf(err, errLen, "sha256 mismatch");
    Update.end(false);
    return false;
  }

  if (!Update.end(true)) {
    snprintf(err, errLen, "update end failed (err %u)", (unsigned)Update.getError());
    return false;
  }
  return true;
}

static void applyPendingUpdate() {
  // A WiFi outage is not a failed update. Defer without consuming an attempt:
  // otherwise three short dropouts silently discard a queued update and the
  // unit stays on old firmware until the next poll.
  if (!wifiIsConnected()) {
    Serial.println("ota: wifi down, deferring update");
    s_nextAttemptMs = millis() + OTA_RETRY_MS;
    return;
  }

  otaPublishStatus("downloading", s_req.ver);
  char err[80] = {0};
  bool ok = downloadAndStage(s_req.url, s_req.sha, s_req.size, err, sizeof(err));

  if (ok) {
    otaPublishStatus("success", s_req.ver);
    // Let the QoS-1 success reach the broker (a rollout canary is promoted on
    // it) before rebooting into the staged image.
    uint32_t t0 = millis();
    while ((uint32_t)(millis() - t0) < 400) {
      mqttService();
      delay(10);
    }
    ptRestart();
    return;
  }

  s_attempts++;
  Serial.printf("ota: attempt %u/%u failed: %s\n", s_attempts, OTA_MAX_ATTEMPTS, err);
  otaPublishStatus("failed", FW_VERSION);
  if (s_attempts >= OTA_MAX_ATTEMPTS) {
    Serial.println("ota: giving up on this request");
    s_haveReq = false;
    s_attempts = 0;
  } else {
    s_nextAttemptMs = millis() + OTA_RETRY_MS;
  }
}

// ---------------- manifest polling ----------------

static void scheduleUpdate(const char* url, const char* sha, const char* ver,
                           uint32_t size, bool force) {
  if (!fw::urlUnderBase(url, OTA_BASE_URL) || !fw::isHexSha(sha) ||
      !ver || !ver[0]) {
    Serial.println("ota: rejected update command (bad url/sha/version)");
    return;
  }
  if (strlen(url) >= sizeof(s_req.url) || strlen(ver) >= sizeof(s_req.ver)) {
    Serial.println("ota: rejected update command (field too long)");
    return;
  }
  if (!fw::updateAcceptable(ver, FW_VERSION, force)) {
    Serial.printf("ota: %s is not newer than %s%s\n", ver, FW_VERSION,
                  force ? " (downgrade refused)" : "");
    return;
  }
  strncpy(s_req.url, url, sizeof(s_req.url) - 1);
  strncpy(s_req.sha, sha, sizeof(s_req.sha) - 1);
  strncpy(s_req.ver, ver, sizeof(s_req.ver) - 1);
  s_req.url[sizeof(s_req.url) - 1] = 0;
  s_req.sha[sizeof(s_req.sha) - 1] = 0;
  s_req.ver[sizeof(s_req.ver) - 1] = 0;
  s_req.size = size;
  s_haveReq = true;
  s_attempts = 0;
  s_nextAttemptMs = 0;  // start as soon as otaLoop() runs
  Serial.printf("ota: queued %s (%u bytes)\n", s_req.ver, (unsigned)size);
}

static void checkManifest() {
  if (!wifiIsConnected()) return;

#ifdef LOCAL_DEV
  WiFiClient client;
#else
  WiFiClientSecure client;
  client.setCACert(ISRG_X1_ROOT);
#endif
  client.setTimeout(OTA_HTTP_TIMEOUT_MS);

  String url = String(OTA_BASE_URL) + "/api/firmware/manifest?device_id=" + DEVICE_ID +
               "&group=" + GROUP + "&current=" + FW_VERSION + "&hw=" + HW_TARGET;

  HTTPClient http;
  http.setTimeout((uint16_t)OTA_HTTP_TIMEOUT_MS);
  if (!http.begin(client, url)) return;

  int code = http.GET();
  if (code == HTTP_CODE_NO_CONTENT || code == HTTP_CODE_NOT_MODIFIED) {
    http.end();
    return;  // already up to date
  }
  if (code != HTTP_CODE_OK) {
    Serial.printf("ota: manifest http %d\n", code);
    http.end();
    return;
  }

  String body = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, body)) {
    Serial.println("ota: manifest parse failed");
    return;
  }

  const char* u = doc["url"];
  const char* s = doc["sha256"];
  const char* v = doc["version"];
  const char* hw = doc["hw"];
  uint32_t size = doc["size"] | 0;

  // Defence in depth: even if the server were misconfigured, never accept a
  // manifest for another board.
  if (!fw::hwCompatible(hw, HW_TARGET)) {
    Serial.printf("ota: manifest hw '%s' != '%s', ignoring\n", hw, HW_TARGET);
    return;
  }
  scheduleUpdate(u, s, v, size, false);
}

// ---------------- entry points ----------------

void otaInit() {
  JsonDocument doc;
  doc["group"] = GROUP;
  doc["version"] = FW_VERSION;
  doc["hw"] = HW_TARGET;
  doc["heap"] = ptFreeHeap();
  char buf[192];
  serializeJson(doc, buf);
  mqttPublish((String("ota/") + DEVICE_ID + "/hello").c_str(), buf);

  // First manifest poll shortly after boot, then on the regular interval.
  s_lastPollMs = millis() - OTA_POLL_MS + 45000UL;
}

void otaRequestManifestCheck() {
  s_checkRequested = true;
}

void otaLoop() {
  if (s_busy) return;
  uint32_t now = millis();

  if (s_haveReq) {
    if ((int32_t)(now - s_nextAttemptMs) < 0) return;
    s_busy = true;
    applyPendingUpdate();
    s_busy = false;
    return;
  }

  if (s_checkRequested) {
    s_checkRequested = false;
    s_busy = true;
    checkManifest();
    s_busy = false;
    return;
  }

  if ((uint32_t)(now - s_lastPollMs) >= OTA_POLL_MS) {
    s_lastPollMs = now;
    s_checkRequested = true;
  }
}

void otaHandleCommand(const char* topic, const char* payload) {
  (void)topic;
  if (s_busy) return;  // never re-enter while an update is running

  JsonDocument doc;
  if (deserializeJson(doc, payload)) return;

  const char* url = doc["url"];
  const char* sha = doc["sha256"];
  const char* ver = doc["version"];
  const char* hw = doc["hw"];
  const char* action = doc["action"];
  uint32_t size = doc["size"] | 0;
  bool force = doc["force"] | false;

  if (!fw::hwCompatible(hw, HW_TARGET)) {
    Serial.printf("ota: command for hw '%s' ignored\n", hw);
    return;
  }
  if (!url || !sha) {
    // Server without a usable public base URL asks the device to pull the
    // manifest itself, which yields a URL that is reachable from here.
    if (action && strcmp(action, "check") == 0) {
      s_checkRequested = true;
      Serial.println("ota: manifest check requested by server");
    }
    return;
  }
  scheduleUpdate(url, sha, ver, size, force);
}
