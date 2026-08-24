#!/usr/bin/env python3
"""
Pi test harness that mimics the ESP32 firmware's network contract, so you can
validate the backend (Mosquitto -> Telegraf -> InfluxDB3 -> Grafana) and the OTA
server WITHOUT an ESP32.

Mirrors firmware/src behavior:
  - publishes  pt100/<sensor>          -> {"temp","resistance","fault"}
  - subscribes ota/<group>/update      (and ota/<device_id>/update)
  - publishes  ota/<device_id>/hello   -> {"group","version"}
  - publishes  ota/<device_id>/status   -> {"state","version"}
  - polls the OTA manifest endpoint (fallback path)

Real MAX31865 reading on the Pi's SPI is supported (--spi). Otherwise it
simulates. It does NOT flash anything: an OTA "update" is reported as success
so you can exercise the server's canary -> full rollout state machine.
"""
import argparse
import json
import sys
import time
import urllib.request
import urllib.error

try:
    import paho.mqtt.client as mqtt
except ImportError:
    sys.exit("Install paho-mqtt: pip install paho-mqtt")

try:
    import board
    import busio
    from adafruit_max31865 import MAX31865
    HAVE_HW = True
except Exception:
    HAVE_HW = False


def semver_gt(a, b):
    def p(x):
        try:
            return tuple(int(i) for i in str(x).split("."))
        except Exception:
            return (0, 0, 0)
    return p(a) > p(b)


def build_hw(sensor_specs):
    if not HAVE_HW:
        return {}
    spi = busio.SPI(board.SCK, board.MOSI, board.MISO)
    out = {}
    for sid, cs in sensor_specs:
        out[sid] = MAX31865(
            spi, getattr(board, cs), wires=3, rtd_nominal=100, ref_resistor=430
        )
    return out


def read(hw, sid, simulate):
    if not simulate and sid in hw:
        try:
            return round(hw[sid].temperature, 2), round(hw[sid].resistance, 2), 0
        except Exception:
            return 0.0, 0.0, 1
    t = round(4.0 + (time.time() % 10) * 0.3, 2)
    return t, round(100.0 + t * 0.385, 2), 0


def apply_update(client, ud, data):
    if not semver_gt(data.get("version", "0.0.0"), ud["version"]):
        return
    client.publish(
        f"ota/{ud['device_id']}/status",
        json.dumps({"state": "downloading", "version": data["version"]}),
    )
    ok = True
    if ud.get("verify_download") and data.get("url"):
        try:
            urllib.request.urlopen(data["url"], timeout=15).read(1024)
        except Exception:
            ok = False
    time.sleep(2)
    client.publish(
        f"ota/{ud['device_id']}/status",
        json.dumps({"state": "success" if ok else "failed", "version": data["version"]}),
    )


def on_connect(client, userdata, flags, rc, props=None):
    client.subscribe(f"ota/{userdata['group']}/update")
    client.subscribe(f"ota/{userdata['device_id']}/update")
    client.publish(
        f"ota/{userdata['device_id']}/hello",
        json.dumps({"group": userdata["group"], "version": userdata["version"]}),
    )


def on_message(client, userdata, msg):
    try:
        apply_update(client, userdata, json.loads(msg.payload))
    except Exception as e:
        print("msg error:", e)


def main():
    ap = argparse.ArgumentParser(description="Pi stand-in for the ESP32 firmware.")
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--tls-ca", default=None, help="CA cert for MQTTS")
    ap.add_argument("--user", default=None)
    ap.add_argument("--password", default=None)
    ap.add_argument("--device-id", default="pi-test-001")
    ap.add_argument("--group", default="zone_a")
    ap.add_argument("--version", default="0.0.0")
    ap.add_argument("--publish-ms", type=int, default=5000)
    ap.add_argument(
        "--sensors",
        nargs="*",
        default=["fridge_top:CE0", "freezer:CE1"],
        help="id:CSboardpin, e.g. fridge_top:CE0 (CE0/CE1 = Pi SPI chip selects)",
    )
    ap.add_argument("--spi", action="store_true", help="read real MAX31865 on SPI")
    ap.add_argument("--simulate", action="store_true", help="force simulated readings")
    ap.add_argument("--manifest-url", default=None, help="OTA manifest URL to poll")
    ap.add_argument("--poll-ms", type=int, default=60000)
    ap.add_argument("--verify-download", action="store_true")
    args = ap.parse_args()

    specs = [s.split(":", 1) for s in args.sensors]
    hw = build_hw(specs) if args.spi else {}
    simulate = args.simulate or not args.spi
    if args.spi and not hw:
        print("WARNING: --spi requested but CircuitPython MAX31865 lib not available; simulating.")

    ud = {
        "group": args.group,
        "device_id": args.device_id,
        "version": args.version,
        "verify_download": args.verify_download,
    }

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.user_data_set(ud)
    client.on_connect = on_connect
    client.on_message = on_message
    if args.tls_ca:
        client.tls_set(ca_certs=args.tls_ca)
    if args.user:
        client.username_pw_set(args.user, args.password)
    client.connect(args.host, args.port, 60)
    client.loop_start()

    last_pub = 0.0
    last_poll = 0.0
    print(f"Publishing to {args.host}:{args.port} as {args.device_id}/{args.group} "
          f"(simulate={simulate})")
    try:
        while True:
            now = time.time() * 1000.0
            if now - last_pub >= args.publish_ms:
                last_pub = now
                for sid, _ in specs:
                    t, r, f = read(hw, sid, simulate)
                    payload = json.dumps({"temp": t, "resistance": r, "fault": f})
                    client.publish(f"pt100/{sid}", payload)
                    print(f"pt100/{sid} -> {payload}")
            if args.manifest_url and now - last_poll >= args.poll_ms:
                last_poll = now
                u = (f"{args.manifest_url}?device_id={args.device_id}"
                     f"&group={args.group}&current={args.version}")
                try:
                    with urllib.request.urlopen(u, timeout=10) as resp:
                        apply_update(client, ud, json.loads(resp.read()))
                except urllib.error.HTTPError as e:
                    if e.code != 204:
                        print("manifest:", e)
                except Exception as e:
                    print("manifest:", e)
            time.sleep(0.1)
    except KeyboardInterrupt:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
