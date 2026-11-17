#include "config.h"
#include "sensors.h"
#include "mqtt.h"
#include "ota.h"
#include "wifi.h"
#include "bootguard.h"
#include "platform.h"

#include <ArduinoJson.h>
#include <WiFi.h>
#include <math.h>

SensorArray sensors;

static bool s_safeMode = false;
static uint32_t s_healthySince = 0;
static uint32_t s_wifiSince = 0;
static unsigned long lastPub = 0;

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n=== %s %s hw=%s group=%s ===\n", DEVICE_ID, FW_VERSION,
                HW_TARGET, GROUP);

  // Must run before WiFi: safe mode disables the 10-minute auto-reboot so a
  // device with a bad image stays reachable for OTA recovery.
  bootGuardInit();
  s_safeMode = bootGuardSafeMode();
  wifiSetAutoReboot(!s_safeMode);
  Serial.printf("heap=%u bytes\n", (unsigned)ptFreeHeap());

  wifiInit();
  // Don't block on WiFi — the wifi manager will reconnect in loop().
  // Give it a brief window to associate so first boot logs are useful.
  unsigned long t0 = millis();
  while (!wifiIsConnected() && millis() - t0 < 4000) {
    wifiLoop();
    delay(100);
  }
  if (wifiIsConnected()) {
    Serial.print("WiFi connected IP=");  Serial.println(WiFi.localIP());
    Serial.print("GW=");  Serial.println(WiFi.gatewayIP());
  } else {
    Serial.println("WiFi not yet connected — will retry in background");
  }
  Serial.print("MQTT target="); Serial.print(MQTT_BROKER); Serial.print(":"); Serial.println(MQTT_PORT);

  // Build the sensor list from SENSOR_DEFS in config.h
  #define SENSOR(id, cs) sensors.add(#id, cs);
  SENSOR_DEFS
  #undef SENSOR
  Serial.println("sensors added");
  sensors.begin(MAX31865_3WIRE);
  Serial.println("sensors begun");

  mqttInit();
  Serial.println("mqttInit done");
  mqttConnect();
  Serial.println("mqttConnect done");
  // otaInit() publishes the "hello" and is called from loop() as soon as the
  // broker connection comes up (first boot included), so the server still
  // learns this device even if the broker was down during setup().
}

void loop() {
  wifiLoop();
  mqttLoop();
  otaLoop();  // queued OTA work runs here, never inside the MQTT callback

  // Announce group/version/hardware on every (re)connect. Doing it here rather
  // than in setup() means a broker outage during boot cannot leave the device
  // invisible to the dashboard and to rollout targeting.
  static bool wasMqttUp = false;
  bool mqttUp = mqttIsConnected();
  if (mqttUp && !wasMqttUp) otaInit();
  wasMqttUp = mqttUp;

  unsigned long now = millis();

  // Consider the boot healthy only after a while with a live network session,
  // so a short-lived connection does not clear the boot-guard counter. WiFi
  // alone is enough: the risk the guard protects against is an image that
  // cannot associate, not a broker outage.
  if (wifiIsConnected()) {
    if (s_wifiSince == 0) s_wifiSince = now;
    else if (now - s_wifiSince > HEALTHY_UPTIME_MS) bootGuardMarkHealthy();
  } else {
    s_wifiSince = 0;
  }
  if (mqttIsConnected()) {
    if (s_healthySince == 0) s_healthySince = now;
    else if (now - s_healthySince > HEALTHY_UPTIME_MS) bootGuardMarkHealthy();
  } else {
    s_healthySince = 0;
  }

  if (now - lastPub >= PUBLISH_MS) {
    lastPub = now;
    for (size_t i = 0; i < sensors.count(); i++) {
      float t, r;
      uint8_t f;
      bool valid = sensors.readAt(i, t, r, f);
      JsonDocument doc;
      if (valid) {
        doc["temp"] = round(t * 100.0f) / 100.0f;
      } else {
        // Never publish an implausible number: a wiring/fault condition must
        // look like "no reading" (sensor goes stale), not like cold storage.
        doc["valid"] = false;
      }
      if (isfinite(r)) {
        doc["resistance"] = round(r * 100.0f) / 100.0f;
      }
      doc["fault"] = f;
      char buf[160];
      serializeJson(doc, buf);
      mqttPublish((String("pt100/") + sensors.idAt(i)).c_str(), buf);
    }
  }

  // Periodic health log (every 30s when disconnected)
  static unsigned long lastWifiLog = 0;
  if (!wifiIsConnected() && now - lastWifiLog > 30000) {
    lastWifiLog = now;
    Serial.printf("WiFi still disconnected %lus (status=%d)%s\n",
                  wifiDisconnectedMs() / 1000, (int)WiFi.status(),
                  s_safeMode ? " [safe mode]" : "");
  }
}

// Called by the MQTT callback in mqtt.cpp. This only queues work: doing HTTP
// and flash writes from inside the PubSubClient callback stalls the network
// stack and can drop the connection mid-download.
void onMqttMessage(char* topic, byte* payload, unsigned int len) {
  String t(topic);
  if (t.startsWith("ota/")) {
    char p[len + 1];
    memcpy(p, payload, len);
    p[len] = 0;
    otaHandleCommand(topic, p);
  }
}
