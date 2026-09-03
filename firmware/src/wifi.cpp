#include "wifi.h"
#include "config.h"
#include <WiFi.h>

static unsigned long s_lastAttempt = 0;
static unsigned long s_retryDelay = 1000;
static uint16_t s_attempt = 0;
static unsigned long s_disconnectedSince = 0;
static unsigned long s_connectedSince = 0;
static bool s_wasConnected = false;
static bool s_initialized = false;
static bool s_reconnectPending = false;
static unsigned long s_reconnectAt = 0;
static int s_lastRssi = 0;

// After 10 minutes without WiFi, reboot to clear any wedged driver/DHCP state.
static const unsigned long REBOOT_AFTER_MS = 10UL * 60UL * 1000UL; // 10 min
// Cap retry interval at 60s
static const unsigned long RETRY_MAX_MS = 60000UL;

void wifiInit() {
  if (s_initialized) return;
  s_initialized = true;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);          // no modem sleep — critical for reliability
  WiFi.setAutoReconnect(false);  // manual exponential backoff, avoid double attempts
  WiFi.persistent(false);        // don't wear NVS on every boot
  WiFi.setHostname(DEVICE_ID);
  // Optional: increase TX power for noisy industrial freezers
  // WiFi.setTxPower(WIFI_POWER_19_5dBm);

  Serial.printf("WiFi: connecting to \"%s\"\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  s_lastAttempt = millis();
  s_disconnectedSince = millis();
  s_retryDelay = 1000;
  s_attempt = 0;
}

bool wifiIsConnected() {
  return WiFi.status() == WL_CONNECTED;
}

int wifiRSSI() {
  return WiFi.RSSI();
}

unsigned long wifiConnectedSince() {
  return s_connectedSince;
}

unsigned long wifiDisconnectedMs() {
  if (wifiIsConnected() || s_disconnectedSince == 0) return 0;
  return millis() - s_disconnectedSince;
}

bool wifiLoop() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!s_wasConnected) {
      s_wasConnected = true;
      s_connectedSince = millis();
      s_disconnectedSince = 0;
      s_reconnectPending = false;
      s_attempt = 0;
      s_retryDelay = 1000;
      Serial.printf("WiFi connected IP=%s GW=%s RSSI=%d dBm\n",
                    WiFi.localIP().toString().c_str(),
                    WiFi.gatewayIP().toString().c_str(),
                    WiFi.RSSI());
    } else {
      s_lastRssi = WiFi.RSSI();
    }
    return true;
  }

  // Currently disconnected
  if (s_wasConnected) {
    // snapshot RSSI before it goes invalid
    int rssiSnap = s_lastRssi;
    s_wasConnected = false;
    s_disconnectedSince = millis();
    Serial.printf("WiFi lost (status=%d) RSSI was %d dBm, will retry\n",
                  (int)WiFi.status(), rssiSnap);
  }
  if (s_disconnectedSince == 0) s_disconnectedSince = millis();

  unsigned long now = millis();

  // Non-blocking settle after disconnect(): wait 200ms before begin()
  if (s_reconnectPending) {
    if (now < s_reconnectAt) return false;
    s_reconnectPending = false;
    Serial.printf("WiFi: re-issuing begin(\"%s\")\n", WIFI_SSID);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    s_lastAttempt = now;
    return false;
  }

  // Watchdog: only reboot if WiFi had ever been up (avoid boot-loop on bad creds)
  if (s_connectedSince != 0 && now - s_disconnectedSince > REBOOT_AFTER_MS) {
    Serial.println("WiFi down 10min — rebooting to recover");
    delay(500);
    ESP.restart();
  }

  if (now - s_lastAttempt < s_retryDelay) {
    return false;
  }

  s_lastAttempt = now;
  s_attempt++;

  Serial.printf("WiFi reconnect #%u (backoff %lus, status=%d)...\n",
                s_attempt, s_retryDelay / 1000, (int)WiFi.status());

  // Clean disconnect then schedule begin() 200ms later (non-blocking)
  WiFi.disconnect(false, true);
  s_reconnectPending = true;
  s_reconnectAt = now + 200;

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s...
  s_retryDelay = s_retryDelay * 2;
  if (s_retryDelay > RETRY_MAX_MS) s_retryDelay = RETRY_MAX_MS;
  if (s_retryDelay < 1000) s_retryDelay = 1000;

  return false;
}
