"""Pi 4B firmware entrypoint (mirrors firmware/src/main.cpp).

- Builds sensors (real MAX31865 if spidev present, else SimSensor).
- Publishes pt100/<sensor> JSON on PUBLISH_MS interval.
- Subscribes ota/<group>/update + ota/<device>/update, dispatches OTA.
- Sends ota/<device>/hello on connect and polls the manifest every OTA_POLL_MS.
"""

import json
import sys
import time

import config
from max31865 import MAX31865, SimSensor
from mqtt_client import MQTTClient
import ota

mqtt = None


def build_sensors():
    sensors = []
    for sid, bus, cs in config.SENSORS:
        try:
            dev = MAX31865(bus, cs, wires=3,
                           rtd_nominal=config.RTD_NOMINAL,
                           ref_resistor=config.REF_RESISTOR)
            mode = "spi"
        except Exception as e:
            print(f"[sensors] {sid}: SPI unavailable ({e}); using simulation")
            dev = SimSensor(base=4.0 + len(sensors))
            mode = "sim"
        sensors.append((sid, dev, mode))
    return sensors


def on_connect():
    mqtt.publish(f"ota/{config.DEVICE_ID}/hello",
                 json.dumps({"group": config.GROUP,
                             "version": config.FW_VERSION()}))


def on_message(topic, payload):
    if not topic.startswith("ota/"):
        return
    try:
        cmd = json.loads(payload)
    except Exception:
        return
    # only react to update commands with a target version
    if "version" not in cmd:
        return
    ota.do_update(cmd, publish)


def publish(topic, payload):
    mqtt.publish(topic, payload)


def main():
    global mqtt
    sensors = build_sensors()
    for sid, dev, mode in sensors:
        print(f"[init] sensor {sid} via {mode}")

    subs = [f"ota/{config.GROUP}/update", f"ota/{config.DEVICE_ID}/update"]
    mqtt = MQTTClient(
        broker=config.MQTT_BROKER,
        port=config.MQTT_PORT,
        user=config.MQTT_USER,
        password=config.MQTT_PASSWORD,
        tls_ca=config.MQTT_TLS_CA,
        subscriptions=subs,
        on_connect=on_connect,
        on_message=on_message,
    )
    mqtt.connect()

    last_pub = 0
    last_poll = 0
    while True:
        now = time.time() * 1000
        if now - last_pub >= config.PUBLISH_MS:
            last_pub = now
            for sid, dev, mode in sensors:
                payload = json.dumps({
                    "temp": dev.temperature(),
                    "resistance": round(dev.resistance(), 2),
                    "fault": dev.read_fault(),
                    "mode": mode,
                })
                mqtt.publish(f"pt100/{sid}", payload)
        if now - last_poll >= config.OTA_POLL_MS:
            last_poll = now
            ota.check_manifest(publish)
        time.sleep(0.1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("stopped")
        sys.exit(0)
